import { describe, it, expect } from 'vitest'
import { wallClockToInstant } from '../src/lib/wall-clock'

/**
 * A wall-clock time in a named zone. The browser's own `new Date(local)`
 * reads the string in the BROWSER's zone; these pin that the helper reads
 * it in the zone it was told, whichever machine the test runs on.
 */
describe('wallClockToInstant', () => {
  it('reads 14:00 London in summer as 13:00 UTC', () => {
    expect(wallClockToInstant('2026-07-01T14:00', 'Europe/London')?.toISOString()).toBe('2026-07-01T13:00:00.000Z')
  })

  it('reads 14:00 London in winter as 14:00 UTC', () => {
    expect(wallClockToInstant('2026-01-15T14:00', 'Europe/London')?.toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })

  it('reads 09:30 Kolkata as 04:00 UTC (a half-hour zone)', () => {
    expect(wallClockToInstant('2026-03-10T09:30', 'Asia/Kolkata')?.toISOString()).toBe('2026-03-10T04:00:00.000Z')
  })

  it('reads 18:00 New York in summer as 22:00 UTC', () => {
    expect(wallClockToInstant('2026-08-20T18:00', 'America/New_York')?.toISOString()).toBe('2026-08-20T22:00:00.000Z')
  })

  it('crosses the New York autumn fall-back without drifting', () => {
    // 2026-11-01 01:30 happens twice in New York; the helper settles on one
    // of the two and is off by at most the hour — never by a day.
    const d = wallClockToInstant('2026-11-01T01:30', 'America/New_York')
    expect(d).not.toBeNull()
    expect(Math.abs(d!.getTime() - Date.UTC(2026, 10, 1, 5, 30)) <= 3_600_000).toBe(true)
  })

  it('refuses text that is not a wall-clock time, and a zone it does not know', () => {
    expect(wallClockToInstant('tomorrow at two', 'Europe/London')).toBeNull()
    expect(wallClockToInstant('2026-07-01T14:00', 'Mars/Olympus')).toBeNull()
  })
})
