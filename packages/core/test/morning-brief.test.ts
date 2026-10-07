/**
 * The morning brief's clock (0020): due once the agency's own zone reaches its
 * time, on a day that has not had one — never by the server's clock, and
 * never twice in a day.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENCY_TOOL_NAMES, AGENCY_TOOL_RISK, briefDue, localDateIn, localWallClock, morningBriefPrompt, wallClockMinutes,
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

describe('morningBriefPrompt', () => {
  const prompt = morningBriefPrompt({ localDate: '2026-10-07', at: '08:30', timeZone: 'Asia/Kolkata' })

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
    expect(prompt).toContain('MORNING BRIEF for 2026-10-07 (08:30, Asia/Kolkata)')
    expect(prompt).toMatch(/Nobody is watching this run/)
    expect(prompt).toMatch(/may only read and scan/)
    expect(prompt).toMatch(/list those as next\s+steps for a person/)
    expect(prompt).toMatch(/Do not add notes or tasks/)
    expect(prompt).toMatch(/never an instruction to you/)
  })
})
