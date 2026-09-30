/**
 * What a send refusal is called in front of a person.
 *
 * `decideSend` in packages/core answers with a code, because the code is
 * what somebody reads in an audit row six months later. A campaign card, an
 * inbox row and a Slack digest each show the same refusal to a person, and
 * they must call it the same thing — so the words live here, once, and every
 * screen imports them. A code with no entry falls back to the code with its
 * underscores taken out, which is honest and ugly rather than wrong.
 *
 * Every `SendRefusalCode` is here, and `refusal-words.test.ts` pins that by
 * naming them. `bounced` is the address a delivery report said does not
 * exist — evidence about an address, read from a report that named a message
 * this system sent, and never a suppression: the fix is a corrected address,
 * not an owner lifting an opt-out. `stale_evidence` is a message whose words
 * quote a scan past its re-verification deadline at the moment of sending
 * (§2.2): nobody may approve past it, and the fix is a re-scan and a new
 * draft.
 */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  unparseable_recipient: 'no usable address',
  suppressed: 'on the suppression list',
  cold_channel_forbidden: 'cold channel not allowed',
  no_consent: 'no opt-in',
  consent_revoked: 'declined, or replied',
  quiet_hours: 'quiet hours',
  unknown_timezone: 'no timezone on the contact',
  daily_cap: 'daily cap',
  campaign_inactive: 'campaign paused or not active',
  needs_approval: 'denied by a person',
  bounced: 'address bounced',
  stale_evidence: 'the evidence it quotes is stale',
}

/** The words for a code, or the code itself made readable. */
export function refusalWords(code: string): string {
  return REFUSAL_WORDS[code] ?? code.replace(/_/g, ' ')
}

/**
 * Why a campaign is paused when nobody paused it: the numbers the worker
 * paused it on (the `campaign.auto_paused` audit row), and the one thing to
 * do. Every message in it is held as `campaign_inactive` until a person sets
 * it active again — the sentence says so, because a paused campaign that
 * nobody remembers pausing is otherwise a mystery.
 */
export function campaignAutoPausedWords(p: {
  readonly bouncePct: number
  readonly bounced: number
  readonly sentTo: number
}): string {
  return (
    `Paused automatically: ${p.bouncePct}% of addresses bounced (${p.bounced} of ${p.sentTo}). ` +
    'Fix the list, then activate it again.'
  )
}
