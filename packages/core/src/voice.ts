/**
 * Voice and SMS rules (PROMPT.md §2.1, §8.5) — pure.
 *
 * Everything the voice service has to get right is a rule about words and
 * order, and rules about words are testable without a phone line:
 *
 *  - the AI DISCLOSES ITSELF in the first utterance and offers a way out.
 *    TCPA, since the FCC's February 2024 ruling that AI-generated voice is
 *    "artificial voice". Not a nicety. `aiDisclosure` is the only source of
 *    that sentence, so it cannot be paraphrased away;
 *  - a spoken opt-out is honoured IMMEDIATELY and written to `suppressions`.
 *    `spokenOptOut` is the detector; the service ends the call on it;
 *  - a caller who wants a person gets one. `wantsHuman` is the detector for
 *    intent; `sentimentOf` is the second trigger, for a caller who is not
 *    asking but should not be kept talking to a machine;
 *  - the OUTBOUND decision is not here at all. Placing a call is a message
 *    leaving the building and goes through `decideSend` with channel
 *    `voice`, which refuses it cold, suppressed, unconsented, or at night —
 *    the same function, so there is no second set of rules to drift.
 *
 * The scripted policy at the bottom is a complete, deterministic
 * conversation that qualifies a caller without a model. It is what the
 * service runs when no model is configured, what the tests drive, and the
 * shape the model-backed policy is held to.
 */

export interface TranscriptEntry {
  readonly role: 'agent' | 'caller' | 'system'
  readonly text: string
  /** ISO-8601. */
  readonly at: string
}

export type CallOutcome = 'qualified' | 'not_qualified' | 'handoff' | 'opted_out' | 'incomplete' | 'no_answer' | 'failed'
export type Sentiment = 'positive' | 'neutral' | 'negative'

/**
 * The first thing the caller hears. Says it is an AI, says it may be
 * recorded, and says how to stop — in that order, before anything else.
 */
export function aiDisclosure(orgName: string): string {
  return (
    `Hi, you've reached ${orgName}. I'm an AI assistant, not a person, and this call may be recorded. ` +
    `Say "stop" at any time and I'll end the call and make sure nobody contacts you again. ` +
    `If you'd rather talk to a person, just say so. How can I help?`
  )
}

/** What the AI says when the caller's number is on the suppression list. */
export function suppressedGreeting(orgName: string): string {
  return (
    `Hi, you've reached ${orgName}. I'm an AI assistant, not a person. ` +
    `Your number is on our do-not-contact list, so I won't ask you anything — ` +
    `if you'd like to speak to a person, say so and I'll connect you; otherwise I'll end the call.`
  )
}

/** Qualified opt-outs. Unambiguous wherever they appear in a sentence. */
const OPT_OUT =
  /\b(stop (?:calling|contacting|texting|messaging|ringing|phoning)|remove me|remove my (?:number|details)|take me off|delete my (?:number|details|data)|do not (?:call|contact|text|ring|phone)|don'?t (?:call|contact|text|ring|phone)|never (?:call|contact|ring|phone) (?:me|again)|unsubscribe|opt(?: |-)?out|leave me alone|lose my number|no more calls)\b/i

/**
 * Bare "stop". The disclosure tells the caller this exact word ends the call,
 * so it is honoured on its own — except where a determiner in front of it
 * gives away that it is a noun. Without that guard "the bus stop is near us"
 * hung up on someone and put them on the suppression list.
 */
const BARE_STOP =
  /(?<!\b(?:the|a|an|my|your|our|their|its|this|that|next|last|first|bus|train|tram|truck|gas|pit|rest|one|full)\s)\bstop\b/i

/**
 * Did the caller ask to be left alone?
 *
 * Deliberately generous: a false positive ends a call politely and writes a
 * suppression somebody can remove; a false negative is a person who asked to
 * be left alone and was not, which is the one that reaches a regulator.
 */
export function spokenOptOut(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  if (OPT_OUT.test(t)) return true
  // Bare "stop" is honoured wherever it appears, because the disclosure
  // told the caller that word ends the call and they are entitled to take
  // that literally. There used to be a 60-character ceiling here, on the
  // theory that a short utterance is an answer and a long one is narration.
  // Review found the cliff: "I've asked you people before, please stop" is
  // 41 characters and honoured, the same sentence with one more clause is
  // not. A caller does not get to know where the line is, so there is no
  // line — BARE_STOP's determiner guard is what keeps "the bus stop" out.
  return BARE_STOP.test(t)
}

const HUMAN = /\b(real person|human|a person|someone|somebody|an? (?:agent|representative|rep|manager|colleague)|transfer me|speak to|talk to|put me through|is this a (?:robot|bot|machine|recording)|not a (?:robot|bot))\b/i
const NOT_HUMAN_CONTEXT = /\b(no (?:need|thanks)|don'?t (?:need|want) (?:a |to )?(?:person|human|speak|talk)|email is (?:fine|enough))\b/i

/** Did the caller ask for a person? A question about whether this is a bot counts. */
export function wantsHuman(text: string | null | undefined): boolean {
  if (!text) return false
  if (NOT_HUMAN_CONTEXT.test(text)) return false
  return HUMAN.test(text)
}

const POSITIVE = ['great', 'thanks', 'thank you', 'interested', 'helpful', 'perfect', 'love', 'good', 'sure', 'definitely', 'yes', 'please', 'sounds good', 'absolutely', 'wonderful']
const NEGATIVE = ['angry', 'annoyed', 'terrible', 'waste', 'useless', 'frustrated', 'not interested', 'ridiculous', 'scam', 'unhappy', 'awful', 'hate', 'never', 'spam', 'harass', 'complaint', 'furious', 'disgusting']

/**
 * A lexicon score over what the CALLER said. Crude on purpose: it is a
 * trigger for a handoff and a field on a record, not a judgement, and a
 * deterministic crude score beats a model that answers differently twice.
 */
export function sentimentOf(entries: readonly TranscriptEntry[]): Sentiment {
  let score = 0
  for (const e of entries) {
    if (e.role !== 'caller') continue
    const t = e.text.toLowerCase()
    for (const w of POSITIVE) if (t.includes(w)) score += 1
    for (const w of NEGATIVE) if (t.includes(w)) score -= 1
  }
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral'
}

/** Negative enough that a person should take over, whether or not one was asked for. */
export function shouldHandOffForSentiment(entries: readonly TranscriptEntry[]): boolean {
  let negative = 0
  for (const e of entries) {
    if (e.role !== 'caller') continue
    const t = e.text.toLowerCase()
    for (const w of NEGATIVE) if (t.includes(w)) negative += 1
  }
  return negative >= 2
}

// ---------------------------------------------------------------------------
// The scripted qualification policy
// ---------------------------------------------------------------------------

export type QualificationStep = 'what' | 'pain' | 'timeline' | 'close' | 'done'

export interface QualificationState {
  readonly step: QualificationStep
  readonly answers: { readonly what?: string; readonly pain?: string; readonly timeline?: string }
  /** How the conversation ended, once it has. */
  readonly ending?: 'email' | 'handoff' | 'opted_out'
}

export const INITIAL_STATE: QualificationState = { step: 'what', answers: {} }

export const QUESTIONS: Readonly<Record<Exclude<QualificationStep, 'done'>, string>> = {
  what: 'To point you to the right person: what does your company build, and do your customers log in to it?',
  pain: 'Has a customer security questionnaire, or a deal that stalled on SOC 2 or ISO 27001, come up in the last year?',
  timeline: 'If we found gaps on your public surface this week, when would you want them closed?',
  close: "Thanks, that's what I needed. Someone from the team will follow up by email today. Would you like me to connect you to a person now, or is email enough?",
}

export type TurnAction = 'continue' | 'handoff' | 'end' | 'opted_out'

export interface TurnResult {
  readonly reply: string
  readonly next: QualificationState
  readonly action: TurnAction
}

const NEAR_TERM = /\b(now|asap|immediately|this (?:week|month|quarter)|next (?:week|month)|soon|urgent|yesterday|before|deadline|q[1-4])\b/i
const ENGAGED = /\b(yes|yeah|yep|we (?:do|have|had|did)|last (?:year|month|quarter)|questionnaire|soc ?2|iso|lost|stalled|customers? (?:log|sign)|login|b2b|saas|platform|app|product|api)\b/i
const DISENGAGED = /\b(no|nope|not really|nothing|never|none|n\/a|don'?t (?:know|think))\b/i

/**
 * One turn of the scripted conversation.
 *
 * Order of precedence is the order of §2.1: an opt-out beats everything,
 * a request for a person beats the script, and only then does the script
 * advance. The reply for an opt-out or a handoff is final — the service
 * ends the session after speaking it.
 */
export function scriptedTurn(state: QualificationState, callerText: string, orgName: string): TurnResult {
  if (spokenOptOut(callerText)) {
    return {
      reply: `Understood. I've ended this and made sure nobody from ${orgName} contacts you again. Goodbye.`,
      next: { ...state, step: 'done', ending: 'opted_out' },
      action: 'opted_out',
    }
  }
  if (wantsHuman(callerText)) {
    return {
      reply: "Of course. I'll connect you to a person now — one moment.",
      next: { ...state, step: 'done', ending: 'handoff' },
      action: 'handoff',
    }
  }

  switch (state.step) {
    case 'what':
      return { reply: QUESTIONS.pain, next: { ...state, step: 'pain', answers: { ...state.answers, what: callerText } }, action: 'continue' }
    case 'pain':
      return { reply: QUESTIONS.timeline, next: { ...state, step: 'timeline', answers: { ...state.answers, pain: callerText } }, action: 'continue' }
    case 'timeline':
      return { reply: QUESTIONS.close, next: { ...state, step: 'close', answers: { ...state.answers, timeline: callerText } }, action: 'continue' }
    case 'close':
      // "Email is enough" / "no" ends the call; anything else is read as
      // wanting a person, because the offer was a person.
      if (/\b(email|e-mail|mail|no|that'?s (?:fine|enough|all)|later)\b/i.test(callerText) && !wantsHuman(callerText)) {
        return {
          reply: `Perfect — you'll hear from ${orgName} by email today. Thanks for calling. Goodbye.`,
          next: { ...state, step: 'done', ending: 'email' },
          action: 'end',
        }
      }
      return {
        reply: "I'll connect you to a person now — one moment.",
        next: { ...state, step: 'done', ending: 'handoff' },
        action: 'handoff',
      }
    case 'done':
      return { reply: 'Thanks again. Goodbye.', next: state, action: 'end' }
  }
}

/** The first question, after the disclosure. */
export function scriptedOpening(): string {
  return QUESTIONS.what
}

/**
 * What the answers add up to. Two of three engaged answers is qualified;
 * fewer than two answers at all is incomplete; the rest is not qualified.
 * An opt-out or a handoff is its own outcome regardless of the answers.
 */
export function qualificationOutcome(state: QualificationState): CallOutcome {
  if (state.ending === 'opted_out') return 'opted_out'
  if (state.ending === 'handoff') return 'handoff'
  const answers = [state.answers.what, state.answers.pain, state.answers.timeline].filter((a): a is string => typeof a === 'string')
  if (answers.length < 2) return 'incomplete'
  const engaged = answers.filter((a) => (ENGAGED.test(a) || NEAR_TERM.test(a)) && !/^\s*(no|nope|nothing|never)\b/i.test(a)).length
  const disengaged = answers.filter((a) => DISENGAGED.test(a) && !ENGAGED.test(a)).length
  if (engaged >= 2 && disengaged < 2) return 'qualified'
  return 'not_qualified'
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * A deterministic, extractive summary: what the caller said, in order,
 * trimmed, with the outcome stated. Nothing is inferred and nothing is
 * invented — a model can write a better one, and the service uses one when
 * it is configured, but a call record must never be without a summary
 * because a model was down.
 */
export function summariseCall(entries: readonly TranscriptEntry[], outcome: CallOutcome, state?: QualificationState): string {
  const said = entries.filter((e) => e.role === 'caller').map((e) => e.text.trim()).filter(Boolean)
  const lines: string[] = []
  lines.push(`Outcome: ${outcome.replace(/_/g, ' ')}.`)
  if (state?.answers.what) lines.push(`What they build: ${clip(state.answers.what)}`)
  if (state?.answers.pain) lines.push(`Security pain: ${clip(state.answers.pain)}`)
  if (state?.answers.timeline) lines.push(`Timeline: ${clip(state.answers.timeline)}`)
  if (!state?.answers.what && said.length > 0) {
    lines.push(`Caller said: ${said.slice(0, 4).map(clip).join(' / ')}`)
  }
  if (said.length === 0) lines.push('The caller did not say anything that was transcribed.')
  return lines.join('\n')
}

function clip(s: string, n = 160): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// ---------------------------------------------------------------------------
// Cost, from config (§8.5, §13 — never hardcoded into copy)
// ---------------------------------------------------------------------------

export interface CallCostInput {
  readonly calls: number
  readonly avgMinutes: number
  /** Per-minute platform rate, from configuration. Null means not configured. */
  readonly ratePerMinUsd: number | null
  /** Per-minute outbound carrier rate, from configuration. Null means inbound. */
  readonly outboundPerMinUsd: number | null
}

/**
 * The projected cost of a set of calls, or null when the rate is not
 * configured — a page shows "rate not configured" rather than a number
 * somebody typed into the UI a year ago.
 */
export function projectedCallCost(input: CallCostInput): { readonly perCallUsd: number; readonly totalUsd: number } | null {
  if (input.ratePerMinUsd === null || !Number.isFinite(input.ratePerMinUsd) || input.ratePerMinUsd < 0) return null
  if (!Number.isFinite(input.avgMinutes) || input.avgMinutes <= 0 || !Number.isInteger(input.calls) || input.calls < 0) return null
  const perMin = input.ratePerMinUsd + (input.outboundPerMinUsd ?? 0)
  const perCall = round2(perMin * input.avgMinutes)
  return { perCallUsd: perCall, totalUsd: round2(perCall * input.calls) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * An inbound call is answered — they called us — but what the AI may DO on
 * it depends on the suppression list: a suppressed number is not qualified,
 * pitched or asked anything; it is offered a person or a goodbye.
 */
export function decideInboundCall(facts: { readonly suppressed: boolean }): { readonly mode: 'qualify' | 'service_only' } {
  return { mode: facts.suppressed ? 'service_only' : 'qualify' }
}
