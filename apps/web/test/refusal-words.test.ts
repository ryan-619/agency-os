/**
 * Every refusal the send path can produce has words a person can read.
 *
 * The codes are listed here rather than imported as a runtime array —
 * packages/core exports the type and not a list — but the list is checked
 * against the type with `satisfies`, so a code added to `SendRefusalCode`
 * fails this file's typecheck until it is added here, and then fails the
 * test until it has words.
 */
import type { SendRefusalCode } from '@agency/core'
import { describe, expect, it } from 'vitest'
import { REFUSAL_WORDS, campaignAutoPausedWords, refusalWords } from '../src/lib/refusal-words'

const SEND_CODES = {
  unparseable_recipient: true,
  suppressed: true,
  bounced: true,
  cold_channel_forbidden: true,
  no_consent: true,
  consent_revoked: true,
  quiet_hours: true,
  unknown_timezone: true,
  daily_cap: true,
  campaign_inactive: true,
  needs_approval: true,
  stale_evidence: true,
} satisfies Record<SendRefusalCode, true>

/** Every code the send path produces — `bounced` among them since bounce handling landed. */
const CODES: readonly string[] = Object.keys(SEND_CODES)

describe('REFUSAL_WORDS', () => {
  it.each(CODES)('has words for %s', (code) => {
    const words = REFUSAL_WORDS[code]
    expect(words).toBeTypeOf('string')
    expect(words!.trim().length).toBeGreaterThan(0)
    // Words a person chose, never the code itself. (Some of them happen to
    // read like the code with its underscores taken out — "quiet hours" is
    // simply what quiet hours are called — so that is not what is refused.)
    expect(words).not.toBe(code)
  })

  it('has no entry that nothing produces', () => {
    for (const key of Object.keys(REFUSAL_WORDS)) expect(CODES).toContain(key)
  })

  it('reads as sentences fragments, not codes', () => {
    for (const words of Object.values(REFUSAL_WORDS)) expect(words).not.toMatch(/_/)
  })
})

describe('refusalWords', () => {
  it('returns the words for a known code', () => {
    expect(refusalWords('daily_cap')).toBe('daily cap')
    expect(refusalWords('campaign_inactive')).toBe('campaign paused or not active')
    expect(refusalWords('bounced')).toBe('address bounced')
    expect(refusalWords('stale_evidence')).toBe('the evidence it quotes is stale')
  })

  it('makes an unknown code readable rather than hiding it', () => {
    expect(refusalWords('some_new_code')).toBe('some new code')
  })
})

describe('campaignAutoPausedWords', () => {
  it('says what paused it, with its own numbers, and what to do', () => {
    expect(campaignAutoPausedWords({ bouncePct: 6, bounced: 12, sentTo: 200 })).toBe(
      'Paused automatically: 6% of addresses bounced (12 of 200). Fix the list, then activate it again.',
    )
    expect(campaignAutoPausedWords({ bouncePct: 5.4, bounced: 7, sentTo: 130 })).toContain('5.4% of addresses bounced (7 of 130)')
  })
})
