/**
 * The follow-up steps editor's words and limits (0024), client-safe: a copy
 * of core's `DEFAULT_FOLLOW_UP_BODY`, `SEQUENCE_LIMITS` and
 * `SEQUENCE_PLACEHOLDERS` that `steps-words.test.ts` holds equal to core's,
 * as `TEMPLATE_CHANNEL_NAMES` is held to `TEMPLATE_CHANNELS`.
 */
export const STEP_DEFAULT_BODY =
  'Hi {first_name},\n\nJust bringing my note back to the top of your inbox. Happy to share more — or to stop here if it is not for you.\n\n{agency}'

export const STEP_LIMITS = { steps: 9, afterDaysMax: 90, bodyMax: 4_000, subjectMax: 200 } as const

export const STEP_PLACEHOLDERS = ['first_name', 'company', 'agency'] as const

export type StepKind = 'message' | 'call' | 'visit'

export const STEP_KIND_WORDS: Readonly<Record<StepKind, string>> = {
  message: 'another message',
  call: 'a call task',
  visit: 'a visit task',
}

export const STOP_REASON_WORDS: Readonly<Record<string, string>> = {
  replied: 'replied',
  paused: 'paused',
  refused: 'a message did not go',
  deal_closed: 'deal closed',
  campaign_ended: 'campaign done',
  finished: 'every step taken',
}

/** "message after 3 days, call after 2 days" — the steps in a line. */
export function stepsLine(steps: readonly { readonly kind: StepKind; readonly afterDays: number }[]): string {
  return steps.map((s) => `${s.kind} after ${s.afterDays} ${s.afterDays === 1 ? 'day' : 'days'}`).join(', ')
}
