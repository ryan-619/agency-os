/**
 * Follow-up sequences (0024): the steps a campaign takes after its opener,
 * and the one decision about a person's run through them.
 *
 * Pure, like `decideSend`, and for the same reason: the advancer gathers the
 * facts and obeys the answer, so the order of the checks lives in one place.
 * A run STOPS — for good — the moment the person replies (any reply but an
 * auto-reply), is paused, their deal closes or the campaign is done; it
 * stops when a step's message is refused, bounced or fails, because a
 * follow-up to a message that never arrived is an opener in disguise. It
 * WAITS while its last message is still a draft or queued, while the
 * campaign is paused, and until the next step's day comes. Every message a
 * step drafts still goes through the one send path, which judges it at the
 * moment of sending; and a call or a visit is a task a person carries out.
 */

export const SEQUENCE_STEP_KINDS = ['message', 'call', 'visit'] as const
export type SequenceStepKind = (typeof SEQUENCE_STEP_KINDS)[number]

export const SEQUENCE_STOP_REASONS = ['replied', 'paused', 'refused', 'deal_closed', 'campaign_ended', 'finished'] as const
export type SequenceStopReason = (typeof SEQUENCE_STOP_REASONS)[number]

export interface SequenceStep {
  /** 2 onwards: the opener is step 1. */
  readonly position: number
  readonly kind: SequenceStepKind
  /** Days after the step before: after its message was sent, or its task made. */
  readonly afterDays: number
  readonly subject: string | null
  readonly body: string | null
}

export const SEQUENCE_LIMITS = { steps: 9, afterDaysMax: 90, bodyMax: 4_000, subjectMax: 200 } as const

/** The words a step may fill in. Anything else in braces is refused when the steps are saved. */
export const SEQUENCE_PLACEHOLDERS = ['first_name', 'company', 'agency'] as const

/** A follow-up for a person who has not answered, offered when a message step is added. */
export const DEFAULT_FOLLOW_UP_BODY =
  'Hi {first_name},\n\nJust bringing my note back to the top of your inbox. Happy to share more — or to stop here if it is not for you.\n\n{agency}'

const PLACEHOLDER = /\{([a-z_]+)\}/g

/** What is wrong with a set of steps, as a sentence, or null. Positions must run 2, 3, 4… with no gap. */
export function sequenceStepsProblem(steps: readonly SequenceStep[]): string | null {
  if (steps.length > SEQUENCE_LIMITS.steps) return `A campaign has at most ${SEQUENCE_LIMITS.steps} follow-up steps.`
  for (const [i, s] of steps.entries()) {
    const n = `Step ${i + 2}`
    if (s.position !== i + 2) return `${n} is out of order: steps run 2, 3, 4… after the opener.`
    if (!(SEQUENCE_STEP_KINDS as readonly string[]).includes(s.kind)) return `${n} is a message, a call or a visit.`
    if (!Number.isInteger(s.afterDays) || s.afterDays < 1 || s.afterDays > SEQUENCE_LIMITS.afterDaysMax) {
      return `${n} waits between 1 and ${SEQUENCE_LIMITS.afterDaysMax} days.`
    }
    if (s.kind !== 'message') {
      if (s.subject !== null || s.body !== null) return `${n} is a ${s.kind}, which has no words to send.`
      continue
    }
    const body = s.body?.trim() ?? ''
    if (body === '') return `${n} is a message, and needs its words.`
    if ([...body].length > SEQUENCE_LIMITS.bodyMax) return `${n}'s words are longer than ${SEQUENCE_LIMITS.bodyMax} characters.`
    if (s.subject !== null && (s.subject.trim() === '' || [...s.subject.trim()].length > SEQUENCE_LIMITS.subjectMax)) {
      return `${n}'s subject is blank or longer than ${SEQUENCE_LIMITS.subjectMax} characters — leave it empty to reply on the opener's subject.`
    }
    for (const text of [s.subject ?? '', body]) {
      for (const m of text.matchAll(PLACEHOLDER)) {
        if (!(SEQUENCE_PLACEHOLDERS as readonly string[]).includes(m[1]!)) {
          return `${n} uses {${m[1]}}, which nothing fills in. It may use ${SEQUENCE_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`
        }
      }
    }
  }
  return null
}

/** A step's words with the placeholders filled in; a first name nobody recorded reads "there". */
export function renderStepWords(text: string, vars: { readonly firstName: string | null; readonly company: string; readonly agency: string }): string {
  return text.replace(PLACEHOLDER, (whole, key: string) =>
    key === 'first_name' ? vars.firstName?.trim() || 'there' : key === 'company' ? vars.company : key === 'agency' ? vars.agency : whole,
  )
}

/** A follow-up's subject when its step names none: the opener's, as a reply ("Re: …"), once. */
export function followUpSubject(openerSubject: string | null): string | null {
  const s = openerSubject?.trim()
  if (!s) return null
  return [...`Re: ${s.replace(/^(?:re:\s*)+/i, '')}`].slice(0, SEQUENCE_LIMITS.subjectMax).join('')
}

/** The message a run is waiting on, as the advancer read it. */
export interface WaitingMessage {
  readonly status: string
  readonly sentAt: Date | null
}

export interface SequenceFacts {
  readonly nextPosition: number
  readonly anchorAt: Date
  readonly waiting: WaitingMessage | null
  readonly steps: readonly SequenceStep[]
  readonly campaignStatus: string
  /** A reply from them since the opener went — any channel, anything but an auto-reply. */
  readonly repliedSince: boolean
  readonly contactPaused: boolean
  /** Their company's deal is closed — won or lost — and none is open. */
  readonly dealClosed: boolean
  readonly now: Date
}

export type SequenceDecision =
  | { readonly kind: 'stop'; readonly reason: SequenceStopReason }
  | { readonly kind: 'wait'; readonly why: 'message_not_sent' | 'campaign_not_active' | 'not_due'; readonly anchorAt: Date; readonly settled: boolean }
  | { readonly kind: 'take'; readonly step: SequenceStep; readonly anchorAt: Date; readonly settled: boolean }

const WENT = new Set(['sent', 'delivered'])
const DID_NOT_GO = new Set(['refused', 'failed', 'bounced'])

/**
 * What to do with one run now. `settled` is true when the message it waited
 * on has gone: the advancer then clears the wait and re-anchors the run at
 * that message's `sent_at` (`anchorAt`), whatever else it does.
 */
export function sequenceNext(f: SequenceFacts): SequenceDecision {
  if (f.repliedSince) return { kind: 'stop', reason: 'replied' }
  if (f.contactPaused) return { kind: 'stop', reason: 'paused' }
  if (f.dealClosed) return { kind: 'stop', reason: 'deal_closed' }
  if (f.campaignStatus === 'done') return { kind: 'stop', reason: 'campaign_ended' }

  let anchorAt = f.anchorAt
  let settled = false
  if (f.waiting) {
    if (DID_NOT_GO.has(f.waiting.status)) return { kind: 'stop', reason: 'refused' }
    if (!WENT.has(f.waiting.status) || !f.waiting.sentAt) return { kind: 'wait', why: 'message_not_sent', anchorAt, settled }
    anchorAt = f.waiting.sentAt
    settled = true
  }
  if (f.campaignStatus !== 'active') return { kind: 'wait', why: 'campaign_not_active', anchorAt, settled }
  const step = [...f.steps].sort((a, b) => a.position - b.position).find((s) => s.position >= f.nextPosition)
  if (!step) return { kind: 'stop', reason: 'finished' }
  if (f.now.getTime() < anchorAt.getTime() + step.afterDays * 86_400_000) return { kind: 'wait', why: 'not_due', anchorAt, settled }
  return { kind: 'take', step, anchorAt, settled }
}
