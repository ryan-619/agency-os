/**
 * What /approvals shows beside a draft, as pure functions (PROMPT.md §2.1,
 * §2.2, §2.4).
 *
 * A person approves the WORDS, not the moment (CLAUDE.md, "The send path"):
 * the worker re-checks every rule when it sends. So nothing here decides
 * anything. What it does is put the facts the sender will read in front of
 * the person before they click — the same facts, from the same function
 * (`previewSend`), in the same words every other screen uses
 * (`REFUSAL_WORDS`) — and the evidence the draft is allowed to quote, with
 * its date, so the body can be checked against what was actually observed.
 *
 * The one place this changes what a person can do is the rule nobody may
 * approve past (`humanCanResolve: false`). Approve is disabled there and says
 * why, because an approval the sender must refuse is not a decision — it is
 * practice at clicking yes, which is exactly the habit §2.4 guards against.
 *
 * No `server-only` and no `@/` import: `test/approval-view.test.ts` imports
 * this file, and vitest resolves neither.
 */
import { shortDate } from './consent-view'
import { refusalWords } from './refusal-words'

// ---------------------------------------------------------------------------
// The per-candidate decision
// ---------------------------------------------------------------------------

/** One candidate's `previewSend` answer, as the card renders it. */
export interface CandidateDecision {
  /** `send_now`, a `SendRefusalCode`, or `unchecked` when the preview itself could not run. */
  readonly code: string
  /** The words every screen uses for the code (`REFUSAL_WORDS`). */
  readonly words: string
  /** `decideSend`'s own flag: false for the rules no human may override. */
  readonly humanCanResolve: boolean
  /** The rule's own sentence, from `decideSend` — null when nothing stops it. */
  readonly reason: string | null
}

/**
 * `SendDecision`'s shape, restated so this file imports nothing from the
 * server. `SendPreview.decision` is assignable to it.
 */
export type PreviewDecision =
  | { readonly allowed: true; readonly code: 'send_now' }
  | { readonly allowed: false; readonly code: string; readonly reason: string; readonly humanCanResolve: boolean }

const SEND_NOW_WORDS = 'nothing stops it right now'

/** A `previewSend` decision in the words the card shows. */
export function decisionView(d: PreviewDecision): CandidateDecision {
  if (d.allowed) return { code: 'send_now', words: SEND_NOW_WORDS, humanCanResolve: true, reason: null }
  return { code: d.code, words: refusalWords(d.code), humanCanResolve: d.humanCanResolve, reason: d.reason }
}

/**
 * The preview could not run — the contact or the campaign vanished between
 * the page's reads. Resolvable, because it says nothing about the person: the
 * worker checks again at sending, and approving is not blocked by a race.
 */
export function uncheckedDecision(message: string): CandidateDecision {
  return { code: 'unchecked', words: 'could not be checked', humanCanResolve: true, reason: message }
}

/**
 * The codes the worker DEFERS rather than refuses (`apps/agent/src/outreach/
 * sender.ts`): the person said yes and only the clock or the campaign is
 * wrong, so an approved message waits with `scheduled_for` and goes later.
 * Everything else is terminal once the worker reads it.
 */
export const DEFERRED_CODES: ReadonlySet<string> = new Set(['quiet_hours', 'daily_cap', 'campaign_inactive'])

/**
 * One candidate's line under the "To" choice, and in its option label.
 *
 * It says what the WORKER would do, not just which rule: "quiet hours" alone
 * reads like a refusal, and it is not one — the message waits for morning.
 */
export function candidateLine(decision: CandidateDecision | null): string {
  if (decision === null) return 'not checked — no campaign chosen yet'
  if (decision.code === 'send_now') return decision.words
  if (decision.code === 'unchecked') return 'could not be checked here — the worker checks again at sending'
  if (!decision.humanCanResolve) return `${decision.words} — nobody may approve past this`
  if (DEFERRED_CODES.has(decision.code)) return `${decision.words} — the worker would hold it and try again later`
  return `${decision.words} — fix this first, or the worker will refuse it`
}

/**
 * Why Approve is disabled for this candidate, or null when it is not.
 *
 * Only `humanCanResolve: false` blocks — a suppression, a recorded refusal,
 * a paused contact, a cold SMS, and words written from a scan that is past
 * its re-verification deadline now (§2.2). Everything else leaves Approve
 * enabled, because the send path re-checks at sending and a person
 * approving past quiet hours is doing exactly what the design expects.
 *
 * Stale evidence has its own sentence, because "choose someone else" is no
 * fix for it: every person at the company gets the same words, and the
 * words are what aged.
 */
export function approveBlock(decision: CandidateDecision | null): string | null {
  if (decision === null || decision.humanCanResolve) return null
  if (decision.code === 'stale_evidence') {
    return (
      `Approving is pointless: ${decision.words} — the scan it was written from is past its re-verification ` +
      'deadline, and nobody may approve past that. Deny it, re-scan the company, then draft it again.'
    )
  }
  return (
    `Approving is pointless: ${decision.words}, and nobody may approve past that — the worker would refuse it. ` +
    'Deny the draft, or choose someone else.'
  )
}

// ---------------------------------------------------------------------------
// Which campaign the decisions were computed under
// ---------------------------------------------------------------------------

export interface CampaignLike {
  readonly id: string
  readonly name: string
  readonly channel: string
  readonly status: string
}

export interface CheckedUnder {
  readonly id: string
  readonly name: string
  /** True when it is the campaign the draft already carries. */
  readonly own: boolean
}

/**
 * The campaign a draft's candidates are previewed under: the draft's own
 * when it carries one, otherwise the first ACTIVE campaign on its channel,
 * otherwise the first on its channel at all. Null when the channel has none.
 *
 * One campaign, not every campaign, and that loses nothing that blocks: the
 * rules nobody may approve past (cold channel, suppression, consent) come
 * before every campaign-dependent step in `decideSend` and depend only on
 * the person and the CHANNEL — and every campaign offered for a draft is on
 * the draft's channel. What can differ under another campaign is only the
 * clock, the cap and the campaign's own status, and the card says so.
 */
export function campaignToCheck(
  draft: { readonly channel: string; readonly campaignId: string | null },
  campaigns: readonly CampaignLike[],
): CheckedUnder | null {
  if (draft.campaignId) {
    const own = campaigns.find((c) => c.id === draft.campaignId)
    if (own) return { id: own.id, name: own.name, own: true }
  }
  const onChannel = campaigns.filter((c) => c.channel === draft.channel)
  const first = onChannel.find((c) => c.status === 'active') ?? onChannel[0]
  return first ? { id: first.id, name: first.name, own: false } : null
}

/** The label above the candidates, naming the campaign the check ran under. */
export function checkedUnderLabel(checked: CheckedUnder | null, channel: string): string {
  if (checked === null) return `Not checked: there is no ${channel} campaign to check against.`
  return checked.own
    ? `Checked when this page loaded, under this draft's campaign, ${checked.name}.`
    : `Checked when this page loaded, under ${checked.name} — the first ${channel} campaign; the draft has none of its own yet.`
}

/**
 * Said when the person chooses a campaign other than the one checked. Only
 * the clock, the cap and the status can differ (see `campaignToCheck`).
 */
export const OTHER_CAMPAIGN_NOTE =
  'The check above ran under a different campaign. Suppression and consent are the same under any ' +
  'campaign on this channel; quiet hours, the daily cap and the status may not be — the worker checks those at sending.'

// ---------------------------------------------------------------------------
// Who addressed it
// ---------------------------------------------------------------------------

export type AddressedBy = 'enrolment' | 'inbox' | null

/**
 * Who chose the recipient before a person saw the draft.
 *
 * An inbox answer names the reply it answers (`answers_touch_id`, 0018). A
 * row with a contact and a campaign and no such link was written by campaign
 * enrolment — the only other writer of a pre-addressed outbound row. The
 * agent's `queue_touch` writes a draft to nobody.
 */
export function addressedByOf(touch: {
  readonly contactId: string | null
  readonly campaignId: string | null
  readonly answersTouchId: string | null
}): AddressedBy {
  if (touch.answersTouchId) return 'inbox'
  if (touch.contactId && touch.campaignId) return 'enrolment'
  return null
}

/** The line on a pre-addressed card. The choice is a suggestion, and it says so. */
export function addressedByLabel(by: AddressedBy): string | null {
  switch (by) {
    case 'enrolment':
      return 'Addressed by enrolment — change if wrong.'
    case 'inbox':
      return 'Addressed by the inbox — change if wrong.'
    case null:
      return null
  }
}

// ---------------------------------------------------------------------------
// The evidence the draft may quote
// ---------------------------------------------------------------------------

export interface DraftEvidence {
  /** When the scan whose findings are listed ran (ISO). */
  readonly asOf: string
  /** Derived from the scan's `ran_at` by `isStale`, never read from `findings.stale`. */
  readonly stale: boolean
  /** One line per quotable finding. Empty when stale — nothing stale is quotable. */
  readonly lines: readonly string[]
}

/**
 * §2.2: the sentence a stale card leads with. It used to end "re-scan, then
 * approve", which stopped being true when the send path started refusing
 * stale evidence: a draft is judged by the scan that was current when it was
 * WRITTEN, so a re-scan freshens the company and never this draft's words.
 */
export const STALE_EVIDENCE_NOTE =
  'This draft is about a company whose findings are stale; §2.2 says re-verify before anything outbound — ' +
  're-scan, then draft it again. The send path refuses a draft written from a stale scan, and approving does not change that.'

export const MISSING_EVIDENCE_NOTE =
  'This draft is about a company this product has never scanned successfully, so nothing it says about them ' +
  'was observed here; §2.2 says re-verify before anything outbound — scan, then approve.'

/** How many evidence lines a card shows before pointing at the company page. */
export const EVIDENCE_LINES_SHOWN = 6

/**
 * One quotable finding as a line: the ICP's reason the gap matters, then what
 * the scanner actually saw. A finding with no detail says so rather than
 * inventing one — "header absent" is an inference the card does not make.
 */
export function evidenceLine(f: { readonly signalKey: string; readonly why: string | null; readonly detail: string | null }): string {
  const claim = f.why?.trim() || f.signalKey
  const observed = f.detail?.trim() || 'no detail recorded — see the company page'
  return `${claim}: ${observed}`
}

export type EvidenceNote =
  | { readonly tone: 'warn'; readonly text: string }
  | { readonly tone: 'plain'; readonly text: string }

/**
 * What the card says about the evidence behind the draft.
 *
 * Stale and missing are warnings. This note decides nothing: whether Approve
 * is enabled comes from the candidates' `previewSend` answers, and those ask
 * the sender's own question — is the scan these words were WRITTEN from past
 * its deadline now? — so a draft written from a stale scan is blocked there,
 * as `stale_evidence`, and a draft about a never-scanned company is not (no
 * scan could have been quoted). A fresh scan with no gaps is plain: nothing
 * is wrong, but a draft claiming a gap has nothing behind it.
 */
export function evidenceNote(evidence: DraftEvidence | null, hasCompany: boolean): EvidenceNote | null {
  if (!hasCompany) {
    return { tone: 'plain', text: 'This draft is not about a company, so there is no scan evidence to check it against.' }
  }
  if (evidence === null) return { tone: 'warn', text: MISSING_EVIDENCE_NOTE }
  if (evidence.stale) {
    return { tone: 'warn', text: `${STALE_EVIDENCE_NOTE} The last successful scan ran ${shortDate(evidence.asOf)}.` }
  }
  if (evidence.lines.length === 0) {
    return {
      tone: 'plain',
      text: `The latest successful scan (${shortDate(evidence.asOf)}) observed no gaps, so the draft has none to quote.`,
    }
  }
  return null
}

/** The heading over the evidence lines, with the scan's date. */
export function evidenceHeading(evidence: DraftEvidence): string {
  return `What the draft may quote — observed ${shortDate(evidence.asOf)}`
}

// ---------------------------------------------------------------------------
// Approving does not send
// ---------------------------------------------------------------------------

export const APPROVE_DOES_NOT_SEND = 'Approving does not send. The worker re-checks every rule at the moment of sending.'

export const NO_WORKER_FOOTNOTE =
  'Approving does not send, and nothing on this deployment will until a worker is connected — ' +
  'every rule is checked again at that moment, not now.'

/**
 * The line beside Approve. With no worker, "the worker re-checks" describes
 * something that is not there, so the line says what is: the queue shows
 * `nothingWillSendNote()` once, above the cards, and each card says this.
 */
export function approveFootnote(noSenderNote: string | null): string {
  return noSenderNote ? NO_WORKER_FOOTNOTE : APPROVE_DOES_NOT_SEND
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export const KEY_HELP =
  'Keys: j / k move between drafts · a, then Enter, approves the focused draft · d denies it · Esc cancels.'

/**
 * The card after `key` moves focus from `current`. `j` is next and `k` is
 * previous, both wrapping; from no card (or one no longer listed) `j` lands
 * on the first and `k` on the last. Any other key leaves focus where it was.
 */
export function nextFocus(ids: readonly string[], current: string | null, key: string): string | null {
  if (key !== 'j' && key !== 'k') return current
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (at === -1) return key === 'j' ? ids[0]! : ids[ids.length - 1]!
  const step = key === 'j' ? 1 : -1
  return ids[(at + step + ids.length) % ids.length]!
}

export type Approvability = { readonly ok: true } | { readonly ok: false; readonly why: string }

export type KeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'focus'; readonly id: string }
  | { readonly kind: 'arm'; readonly id: string }
  | { readonly kind: 'disarm' }
  | { readonly kind: 'approve'; readonly id: string }
  | { readonly kind: 'deny'; readonly id: string }
  | { readonly kind: 'explain'; readonly id: string; readonly why: string }

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

/**
 * What a keypress does on /approvals.
 *
 * Approving is the one action here that ends with a message leaving the
 * building, so it is never ONE key: `a` arms the card the person explicitly
 * focused (the card says "press Enter to approve"), and only Enter on that
 * same card approves. Any other key, or focus moving, disarms — a stray `a`
 * in the wrong tab is a prompt, never an outbound message. `d` denies
 * outright: denying sends nothing, and the draft is kept with the note.
 *
 * `focused` is the card that has DOM focus — clicked, tabbed to, or reached
 * with j/k — and null when nothing is; `a`, Enter and `d` do nothing then.
 * The caller ignores keys typed into a field or on a button, and any key
 * with Ctrl, Alt or Meta, before asking.
 */
export function keyAction(input: {
  readonly key: string
  readonly ids: readonly string[]
  readonly focused: string | null
  readonly armed: string | null
  readonly approvable: (id: string) => Approvability
  readonly deniable: (id: string) => boolean
}): KeyAction {
  const { key, ids, focused, armed } = input
  if (MODIFIER_KEYS.has(key)) return { kind: 'none' }

  if (key === 'j' || key === 'k') {
    const next = nextFocus(ids, focused, key)
    return next === null ? (armed ? { kind: 'disarm' } : { kind: 'none' }) : { kind: 'focus', id: next }
  }

  if (key === 'Enter') {
    if (armed === null) return { kind: 'none' }
    if (armed !== focused) return { kind: 'disarm' }
    return input.approvable(armed).ok ? { kind: 'approve', id: armed } : { kind: 'disarm' }
  }

  if (key === 'a') {
    if (focused === null) return armed ? { kind: 'disarm' } : { kind: 'none' }
    const can = input.approvable(focused)
    return can.ok ? { kind: 'arm', id: focused } : { kind: 'explain', id: focused, why: can.why }
  }

  if (key === 'd') {
    if (focused === null || !input.deniable(focused)) return armed ? { kind: 'disarm' } : { kind: 'none' }
    return { kind: 'deny', id: focused }
  }

  // Escape, and every other key: an armed card is disarmed, nothing else happens.
  return armed ? { kind: 'disarm' } : { kind: 'none' }
}

/**
 * Whether a card can be approved right now, and if not, why — for the `a`
 * key, which has no button to grey out.
 */
export function approvability(card: {
  readonly canDecide: boolean
  readonly settled: boolean
  readonly busy: boolean
  readonly contactId: string
  readonly campaignId: string
  readonly block: string | null
}): Approvability {
  if (!card.canDecide) return { ok: false, why: 'Your role cannot decide approvals.' }
  if (card.settled) return { ok: false, why: 'This draft has already been decided.' }
  if (card.busy) return { ok: false, why: 'A decision on this draft is already on its way.' }
  if (!card.contactId || !card.campaignId) return { ok: false, why: 'Choose a person and a campaign first.' }
  if (card.block) return { ok: false, why: card.block }
  return { ok: true }
}
