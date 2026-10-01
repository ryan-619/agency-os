/**
 * §2.2: "Findings older than 14 days are marked stale and must be re-verified
 * before appearing in any outbound draft."
 *
 * The word doing the work is *marked*. A column that records the answer is a
 * cache of a sweep, and a sweep runs when someone runs it — so the column says
 * fresh about an observation that aged out an hour ago. Everything that
 * decides whether a finding may be SHOWN or QUOTED asks this instead.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { DEFAULT_STALE_AFTER_DAYS, isStale, staleAfterDaysOf, staleBefore } from '../src/freshness.js'

const DAY = 86_400_000
const now = new Date('2026-09-11T12:00:00.000Z')
const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY)

describe('isStale', () => {
  it('is false inside the window and true outside it', () => {
    expect(isStale(daysAgo(0), 14, now)).toBe(false)
    expect(isStale(daysAgo(13), 14, now)).toBe(false)
    expect(isStale(daysAgo(15), 14, now)).toBe(true)
    expect(isStale(daysAgo(30), 14, now)).toBe(true)
  })

  it('treats exactly the threshold as still fresh, and a moment past it as not', () => {
    expect(isStale(daysAgo(14), 14, now)).toBe(false)
    expect(isStale(new Date(daysAgo(14).getTime() - 1), 14, now)).toBe(true)
  })

  it('uses the ICP threshold, not a constant', () => {
    expect(isStale(daysAgo(5), 3, now)).toBe(true)
    expect(isStale(daysAgo(5), 30, now)).toBe(false)
    expect(DEFAULT_STALE_AFTER_DAYS).toBe(14)
  })

  it('accepts an ISO string, which is what a jsonb capture carries', () => {
    expect(isStale(daysAgo(1).toISOString(), 14, now)).toBe(false)
    expect(isStale(daysAgo(40).toISOString(), 14, now)).toBe(true)
  })

  /**
   * Every unusable input answers "stale". Missing or unreadable is not
   * evidence that something was observed recently, and the cost of being wrong
   * runs one way: a needless re-scan against an email that states a fact
   * nobody currently holds.
   */
  it('calls a missing or unreadable timestamp stale rather than fresh', () => {
    expect(isStale(null, 14, now)).toBe(true)
    expect(isStale(undefined, 14, now)).toBe(true)
    expect(isStale('not a date', 14, now)).toBe(true)
    expect(isStale(new Date(Number.NaN), 14, now)).toBe(true)
  })

  it('refuses a nonsensical threshold instead of treating everything as fresh', () => {
    expect(() => isStale(daysAgo(1), 0, now)).toThrow(/positive number/)
    expect(() => isStale(daysAgo(1), -14, now)).toThrow(/positive number/)
    expect(() => isStale(daysAgo(1), Number.NaN, now)).toThrow(/positive number/)
  })

  it('does not call a future observation stale', () => {
    expect(isStale(new Date(now.getTime() + DAY), 14, now)).toBe(false)
  })
})

describe('staleBefore', () => {
  it('is the cut-off isStale compares against', () => {
    const cutoff = staleBefore(14, now)
    expect(cutoff.getTime()).toBe(now.getTime() - 14 * DAY)
    expect(isStale(new Date(cutoff.getTime() - 1), 14, now)).toBe(true)
    expect(isStale(cutoff, 14, now)).toBe(false)
  })

  it('refuses a nonsensical threshold', () => {
    expect(() => staleBefore(0, now)).toThrow(/positive number/)
  })
})

/**
 * `isStale` THROWS on a threshold that is not a positive number, on purpose —
 * treating everything as fresh would be the dangerous direction. So the one
 * place a threshold comes from, the ICP row, is read through one helper that
 * never hands it such a value. Readers that passed `stale_after_days`
 * through raw made the proposal page, the company page, the share link and
 * two agent tools a 500 over a hand-edited `0`, while `/compliance` fell back
 * to the default — the page and the tool that must agree did not.
 */
describe('staleAfterDaysOf', () => {
  const seed = JSON.parse(
    readFileSync(new URL('../../db/seed/icp-security-gap-saas.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  const withDays = (days: unknown): unknown => ({ ...seed, freshness: { stale_after_days: days } })

  it('reads the profile’s own threshold', () => {
    expect(staleAfterDaysOf(withDays(7))).toBe(7)
    expect(staleAfterDaysOf(withDays(30))).toBe(30)
    expect(staleAfterDaysOf(withDays(0.5))).toBe(0.5)
  })

  it('reads the seeded profile’s threshold as it is stored', () => {
    expect(staleAfterDaysOf(seed)).toBe((seed.freshness as { stale_after_days: number }).stale_after_days)
  })

  it('answers the default for every value isStale would throw on, and the result never throws there', () => {
    for (const bad of [0, -14, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '14', null, true, {}]) {
      const days = staleAfterDaysOf(withDays(bad))
      expect(days, String(bad)).toBe(DEFAULT_STALE_AFTER_DAYS)
      expect(() => isStale(now, days, now)).not.toThrow()
    }
    // The premise: the raw value really does throw there.
    expect(() => isStale(now, 0, now)).toThrow(/positive number/)
  })

  it('answers the default when the profile sets no freshness at all', () => {
    const { freshness: _dropped, ...none } = seed
    expect(staleAfterDaysOf(none)).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(staleAfterDaysOf({ ...seed, freshness: {} })).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(staleAfterDaysOf({ ...seed, freshness: 'fourteen days' })).toBe(DEFAULT_STALE_AFTER_DAYS)
  })

  /**
   * A definition the scorer cannot read sets nothing — the same answer the
   * web's `readIcp` gives it, so a page and a tool reading one broken row
   * agree on the threshold as they agree on everything else.
   */
  it('answers the default for no profile, or one that is not a readable ICP definition', () => {
    expect(staleAfterDaysOf(undefined)).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(staleAfterDaysOf(null)).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(staleAfterDaysOf('{"freshness":{"stale_after_days":7}}')).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(staleAfterDaysOf({ freshness: { stale_after_days: 7 } })).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(staleAfterDaysOf({ ...seed, label: '', freshness: { stale_after_days: 7 } })).toBe(DEFAULT_STALE_AFTER_DAYS)
  })
})
