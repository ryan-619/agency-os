/**
 * §2.2: "Findings older than 14 days are marked stale and must be re-verified
 * before appearing in any outbound draft."
 *
 * The word doing the work is *marked*. A column that records the answer is a
 * cache of a sweep, and a sweep runs when someone runs it — so the column says
 * fresh about an observation that aged out an hour ago. Everything that
 * decides whether a finding may be SHOWN or QUOTED asks this instead.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_STALE_AFTER_DAYS, isStale, staleBefore } from '../src/freshness.js'

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
