import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DURATION_MINUTES, escapeText, foldLine, icsUtc, meetingToIcs, type IcsInput, type IcsMeeting,
} from '../src/lib/ics'
import { wallClockToInstant } from '../src/lib/wall-clock'

/**
 * The `.ics` download (RFC 5545). A file that leaves the app for a laptop
 * and a phone: these pin that it is well-formed for a calendar to import,
 * that it is a download and not an invitation (no ATTENDEE, no ORGANIZER,
 * METHOD:PUBLISH), and that nothing personal or credentialed rides along.
 */
const NOW = new Date('2026-09-20T10:00:00Z')
const HOST = 'myagencyos.in'
const ORIGIN = 'https://myagencyos.in'
const ID = '3f2b8c1e-6d4a-4f7b-9a0c-1e2d3c4b5a69'

function meeting(over: Partial<IcsMeeting> = {}): IcsMeeting {
  return {
    id: ID,
    title: 'Intro call',
    startsAt: new Date('2026-09-22T14:00:00Z'),
    endsAt: new Date('2026-09-22T14:30:00Z'),
    timeZone: 'Europe/London',
    source: 'manual',
    cancelledAt: null,
    createdAt: new Date('2026-09-15T09:00:00Z'),
    updatedAt: null,
    ...over,
  }
}

function render(over: Partial<IcsMeeting> = {}, input: Partial<Omit<IcsInput, 'meeting'>> = {}): string {
  return meetingToIcs({
    meeting: meeting(over),
    company: { domain: 'rentman.io', name: 'Rentman' },
    host: HOST,
    origin: ORIGIN,
    now: NOW,
    ...input,
  })
}

/** The logical content lines: folds undone (§3.1), the final CRLF dropped. */
function unfolded(out: string): string[] {
  return out.replace(/\r\n[ \t]/g, '').split('\r\n').filter((l) => l !== '')
}

function prop(out: string, name: string): string | undefined {
  return unfolded(out).find((l) => l.startsWith(`${name}:`))
}

describe('meetingToIcs', () => {
  it('ends every line with CRLF and nothing else', () => {
    const out = render({ title: 'Intro\nsecond line' })
    expect(out.split('\r\n').length).toBeGreaterThan(5)
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
    expect(out.replace(/\r\n/g, '')).not.toContain('\r')
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('folds a long line at 75 octets, never inside a multi-byte character', () => {
    const title = 'Réunion '.repeat(30).trim()
    const out = render({ title })
    const encoder = new TextEncoder()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const physical = out.split('\r\n')
    expect(physical.some((l) => l.startsWith(' '))).toBe(true)
    for (const line of physical) {
      const bytes = encoder.encode(line)
      expect(bytes.length).toBeLessThanOrEqual(75)
      // A fold between the two octets of "é" leaves each half undecodable.
      expect(() => decoder.decode(bytes)).not.toThrow()
    }
    expect(prop(out, 'SUMMARY')).toBe(`SUMMARY:${escapeText(title)}`)
  })

  it('escapes TEXT values and leaves a colon alone', () => {
    const out = render({ title: 'Intro; scope, budget \\ "quotes" \nline2: then' })
    expect(prop(out, 'SUMMARY')).toBe('SUMMARY:Intro\\; scope\\, budget \\\\ "quotes" \\nline2: then')
  })

  it('writes London in summer and in winter as the right UTC instant', () => {
    const summer = wallClockToInstant('2026-07-01T15:00', 'Europe/London')
    const winter = wallClockToInstant('2026-01-15T15:00', 'Europe/London')
    if (!summer || !winter) throw new Error('wallClockToInstant refused a London time')
    const s = render({ startsAt: summer, endsAt: null })
    const w = render({ startsAt: winter, endsAt: null })
    expect(prop(s, 'DTSTART')).toBe('DTSTART:20260701T140000Z')
    expect(prop(w, 'DTSTART')).toBe('DTSTART:20260115T150000Z')
    // The reader still sees the meeting's own wall clock, in its own zone.
    expect(prop(s, 'DESCRIPTION')).toContain('15:00 (Europe/London)')
    expect(prop(w, 'DESCRIPTION')).toContain('15:00 (Europe/London)')
    // UTC needs no zone: no TZID, no VTIMEZONE to get wrong.
    expect(s).not.toContain('TZID')
    expect(s).not.toContain('VTIMEZONE')
  })

  it('writes a half-hour zone as the right UTC instant', () => {
    const at = wallClockToInstant('2026-03-10T09:30', 'Asia/Kolkata')
    if (!at) throw new Error('wallClockToInstant refused a Kolkata time')
    const out = render({ startsAt: at, endsAt: null, timeZone: 'Asia/Kolkata' })
    expect(prop(out, 'DTSTART')).toBe('DTSTART:20260310T040000Z')
    expect(prop(out, 'DESCRIPTION')).toContain('09:30 (Asia/Kolkata)')
  })

  it('assumes 30 minutes for a meeting with no end, and says it assumed', () => {
    const out = render({ endsAt: null })
    expect(prop(out, 'DTEND')).toBeUndefined()
    expect(prop(out, 'DURATION')).toBe(`DURATION:PT${DEFAULT_DURATION_MINUTES}M`)
    expect(prop(out, 'DESCRIPTION')).toContain('30 minutes assumed')

    const ended = render()
    expect(prop(ended, 'DTEND')).toBe('DTEND:20260922T143000Z')
    expect(prop(ended, 'DURATION')).toBeUndefined()
    expect(prop(ended, 'DESCRIPTION')).not.toContain('assumed')
  })

  it('marks a cancelled meeting CANCELLED at sequence 1, under the same UID', () => {
    const live = render()
    const off = render({ cancelledAt: new Date('2026-09-19T08:00:00Z') })
    expect(prop(live, 'STATUS')).toBe('STATUS:CONFIRMED')
    expect(prop(live, 'SEQUENCE')).toBe('SEQUENCE:0')
    expect(prop(off, 'STATUS')).toBe('STATUS:CANCELLED')
    expect(prop(off, 'SEQUENCE')).toBe('SEQUENCE:1')
    expect(prop(off, 'SUMMARY')).toBe('SUMMARY:Cancelled: Intro call')
    // The same UID is what lets the cancelled file cancel the imported event.
    expect(prop(off, 'UID')).toBe(prop(live, 'UID'))
  })

  it('names the event by the meeting id at the host, stamped with now', () => {
    const out = render()
    expect(prop(out, 'UID')).toBe(`UID:${ID}@${HOST}`)
    // DTSTAMP is when the file was made (§3.8.7.2 with a METHOD), not created_at.
    expect(prop(out, 'DTSTAMP')).toBe('DTSTAMP:20260920T100000Z')
    expect(prop(out, 'CREATED')).toBe('CREATED:20260915T090000Z')
    expect(prop(out, 'URL')).toBe(`URL:${ORIGIN}/meetings/${ID}`)
  })

  it('carries nothing personal or credentialed, and invites nobody', () => {
    // The route hands the whole row over; everything below is on it.
    const row = {
      ...meeting(),
      externalRef: 'https://calendar.google.com/event?eid=abc&token=SECRET-TOKEN',
      notes: 'phone given: +447700900123',
      contactId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
      contactEmail: 'priya@rentman.io',
      createdBy: 'owner@agency.example',
    }
    const out = meetingToIcs({ meeting: row, company: { domain: 'rentman.io', name: 'Rentman' }, host: HOST, origin: ORIGIN, now: NOW })
    for (const leak of ['SECRET-TOKEN', 'calendar.google.com', '+447700900123', 'priya@rentman.io', 'owner@agency.example', row.contactId]) {
      expect(out).not.toContain(leak)
    }
    expect(out).not.toMatch(/^ATTENDEE/m)
    expect(out).not.toMatch(/^ORGANIZER/m)
  })

  it('leaves a booking visitor’s name out of the title, and masks an inbound lead', () => {
    // A booking-page title is the system's, written from the visitor's name.
    const booked = render({ source: 'booking_page', title: 'Intro call with Priya Sharma' })
    expect(booked).not.toContain('Priya')
    expect(prop(booked, 'SUMMARY')).toBe('SUMMARY:Intro call with Rentman')
    // A free-mail booker's company is their address in disguise.
    const inbound = render(
      { source: 'booking_page', title: 'Intro call with Priya Sharma' },
      { company: { domain: 'priya.sharma@gmail.com.inbound', name: 'Priya Sharma' } },
    )
    expect(inbound).not.toContain('Priya')
    expect(inbound).not.toContain('gmail')
    expect(prop(inbound, 'SUMMARY')).toBe('SUMMARY:Intro call with an inbound lead')
  })

  it('writes the calendar header once, as a PUBLISH with one event', () => {
    const lines = unfolded(render())
    const count = (name: string) => lines.filter((l) => l.startsWith(`${name}:`)).length
    expect(count('VERSION')).toBe(1)
    expect(count('METHOD')).toBe(1)
    expect(count('PRODID')).toBe(1)
    expect(lines).toContain('METHOD:PUBLISH')
    expect(lines).toContain('VERSION:2.0')
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1)
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR')
    // The description says what the file is, in the page's words.
    expect(prop(render(), 'DESCRIPTION')).toContain('Nobody is invited by it.')
  })
})

describe('the helpers', () => {
  it('formats an instant as RFC 5545 UTC', () => {
    expect(icsUtc(new Date('2026-09-22T14:00:00.000Z'))).toBe('20260922T140000Z')
    expect(icsUtc(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z')
  })

  it('escapes backslash first, so an escape is never itself escaped', () => {
    expect(escapeText('a\\;b')).toBe('a\\\\\\;b')
    expect(escapeText('one\r\ntwo\rthree')).toBe('one\\ntwo\\nthree')
    expect(escapeText('bell\u0007tab\tok')).toBe('belltab\tok')
  })

  it('leaves a short line alone and folds a 4-octet character whole', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short')
    const line = `SUMMARY:${'😀'.repeat(40)}`
    const folded = foldLine(line)
    expect(folded.replace(/\r\n /g, '')).toBe(line)
    for (const part of folded.split('\r\n')) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/)
    }
  })
})
