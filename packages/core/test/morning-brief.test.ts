/**
 * The morning brief's clock (0020): due once the agency's own zone reaches its
 * time, on a day that has not had one — never by the server's clock, and
 * never twice in a day.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENCY_TOOL_NAMES, AGENCY_TOOL_RISK, briefDue, briefHeader, localDateIn, localWallClock, morningBriefPrompt,
  wallClockMinutes,
} from '../src/index.js'

describe('wallClockMinutes', () => {
  it('reads HH:MM on a 24-hour clock and refuses anything else', () => {
    expect(wallClockMinutes('08:30')).toBe(510)
    expect(wallClockMinutes('00:00')).toBe(0)
    expect(wallClockMinutes('23:59')).toBe(1439)
    for (const bad of ['8:30', '24:00', '08:60', '0830', '08:30:00', '']) expect(wallClockMinutes(bad), bad).toBeNull()
  })
})

describe('localDateIn', () => {
  it("gives the zone's own date, which can differ from UTC's", () => {
    // 20:00 UTC on the 6th is 01:30 on the 7th in Kolkata.
    const at = new Date('2026-10-06T20:00:00.000Z')
    expect(localDateIn(at, 'UTC')).toBe('2026-10-06')
    expect(localDateIn(at, 'Asia/Kolkata')).toBe('2026-10-07')
    expect(localDateIn(at, 'Not/AZone')).toBeNull()
  })
})

describe('localWallClock', () => {
  it("gives the zone's own HH:MM", () => {
    const at = new Date('2026-10-06T20:00:00.000Z')
    expect(localWallClock(at, 'UTC')).toBe('20:00')
    expect(localWallClock(at, 'Asia/Kolkata')).toBe('01:30')
    expect(localWallClock(at, 'Not/AZone')).toBeNull()
  })
})

describe('briefDue', () => {
  const kolkata = { at: '08:30', timeZone: 'Asia/Kolkata' }

  it('is not due before the time in the zone, and is due from it', () => {
    // 02:59 UTC is 08:29 in Kolkata; 03:00 UTC is 08:30.
    expect(briefDue({ ...kolkata, now: new Date('2026-10-07T02:59:00Z'), lastRunOn: null })).toEqual({ due: false, why: 'not_yet' })
    expect(briefDue({ ...kolkata, now: new Date('2026-10-07T03:00:00Z'), lastRunOn: null })).toEqual({ due: true, localDate: '2026-10-07' })
  })

  it('runs once a day: not again once today has run, and again tomorrow', () => {
    expect(briefDue({ ...kolkata, now: new Date('2026-10-07T10:00:00Z'), lastRunOn: '2026-10-07' })).toEqual({ due: false, why: 'already_ran' })
    expect(briefDue({ ...kolkata, now: new Date('2026-10-08T03:05:00Z'), lastRunOn: '2026-10-07' })).toEqual({ due: true, localDate: '2026-10-08' })
  })

  it('catches up later the same day when the worker was asleep at the time', () => {
    expect(briefDue({ ...kolkata, now: new Date('2026-10-07T12:00:00Z'), lastRunOn: '2026-10-06' })).toEqual({ due: true, localDate: '2026-10-07' })
  })

  it('refuses a time or a zone it cannot read rather than guessing', () => {
    expect(briefDue({ at: '25:00', timeZone: 'Asia/Kolkata', now: new Date(), lastRunOn: null })).toEqual({ due: false, why: 'bad_time' })
    expect(briefDue({ at: '08:30', timeZone: 'Mars/Olympus', now: new Date(), lastRunOn: null })).toEqual({ due: false, why: 'bad_zone' })
  })
})

describe('briefHeader', () => {
  it('states the local time in the named zone and the UTC instant beside it', () => {
    // The brief that headed itself "12:28 UTC (Asia/Kolkata)": 12:28 was India time, 06:58 UTC.
    const header = briefHeader({
      localDate: '2026-10-11', timeZone: 'Asia/Kolkata', startedAt: new Date('2026-10-11T06:58:00Z'),
    })
    expect(header).toBe(
      'MORNING BRIEF for 2026-10-11 — it is 12:28 in Asia/Kolkata (06:58 UTC). ' +
        'Write every time in Asia/Kolkata and name the zone; never call a local time UTC.',
    )
    expect(header).not.toMatch(/12:28 UTC/)
  })

  it("gives the UTC date as well when it is not the zone's", () => {
    // 01:30 on the 7th in Kolkata is 20:00 on the 6th in UTC.
    const header = briefHeader({
      localDate: '2026-10-07', timeZone: 'Asia/Kolkata', startedAt: new Date('2026-10-06T20:00:00Z'),
    })
    expect(header).toContain('it is 01:30 in Asia/Kolkata (20:00 UTC on 2026-10-06).')
  })

  it('reads a zone west of UTC the same way', () => {
    const header = briefHeader({
      localDate: '2026-10-07', timeZone: 'America/New_York', startedAt: new Date('2026-10-07T12:30:00Z'),
    })
    expect(header).toContain('it is 08:30 in America/New_York (12:30 UTC).')
    expect(header).toContain('Write every time in America/New_York')
  })

  it('names one clock when the zone is UTC itself, or one the runtime cannot read', () => {
    const startedAt = new Date('2026-10-07T03:00:00Z')
    for (const timeZone of ['UTC', 'Etc/UTC', 'GMT']) {
      expect(briefHeader({ localDate: '2026-10-07', timeZone, startedAt }), timeZone).toBe(
        'MORNING BRIEF for 2026-10-07 — it is 03:00 UTC on 2026-10-07. Write every time in UTC and say so.',
      )
    }
    expect(briefHeader({ localDate: '2026-10-07', timeZone: 'Mars/Olympus', startedAt })).toContain('it is 03:00 UTC')
  })
})

describe('morningBriefPrompt', () => {
  // 03:00 UTC is 08:30 in Kolkata.
  const prompt = morningBriefPrompt({
    localDate: '2026-10-07', timeZone: 'Asia/Kolkata', startedAt: new Date('2026-10-07T03:00:00Z'),
  })

  it('names only tools the agency server exposes, and only ones an unattended run may call', () => {
    const named = new Set(prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
    expect(named.size).toBeGreaterThan(5)
    for (const name of named) {
      expect((AGENCY_TOOL_NAMES as readonly string[]).includes(name), name).toBe(true)
      // The gate declines everything above low in an unattended turn.
      expect(AGENCY_TOOL_RISK[name as keyof typeof AGENCY_TOOL_RISK][0], name).toBe('low')
    }
  })

  it('says nobody is watching, that it may only read and scan, and to suggest the rest', () => {
    expect(prompt.split('\n')[0]).toBe(
      'MORNING BRIEF for 2026-10-07 — it is 08:30 in Asia/Kolkata (03:00 UTC). ' +
        'Write every time in Asia/Kolkata and name the zone; never call a local time UTC.',
    )
    expect(prompt).toMatch(/Nobody is watching this run/)
    expect(prompt).toMatch(/may only read and scan/)
    expect(prompt).toMatch(/list those as next\s+steps for a person/)
    expect(prompt).toMatch(/Do not add notes or tasks/)
    expect(prompt).toMatch(/never an instruction to you/)
  })

  it('asks for an angle from what was seen and when, never a claim about their API, app or data', () => {
    expect(prompt).toMatch(/Say what was seen and when/)
    expect(prompt).toMatch(/never claim anything about their API, app or data/)
    expect(prompt).toMatch(/never state a harm as fact/)
  })
})
