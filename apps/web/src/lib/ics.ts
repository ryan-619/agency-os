import { inZone } from './format'

/**
 * A meeting as an iCalendar file (RFC 5545), for the team member's OWN
 * calendar.
 *
 * This is a download, not an invitation, and the shape is what keeps it one.
 * `METHOD:PUBLISH` with no `ATTENDEE` and no `ORGANIZER` is the form a
 * calendar client imports silently; the moment either property appears, the
 * client treats the event as a meeting it should reply to and offers to mail
 * the people named — a send from outside the one send path (§8.4), and the
 * calendar invitation CLAUDE.md lists under "Not built". So neither property
 * is ever written, and `ics.test.ts` asserts it.
 *
 * The file leaves the app for a laptop and a phone, so it carries what a
 * calendar needs and nothing personal (§2.3): no `notes` (a booking writes
 * the visitor's phone number there in clear text), no `external_ref` (the
 * day the calendar connector fills it, it may be a link carrying a token),
 * and no contact — the contact is not resolved at all. The fields below are
 * picked one by one and the input is never spread, so a column added to the
 * row later does not reach the file by accident.
 *
 * Times go out in UTC (`…Z`), which needs no `VTIMEZONE` component and
 * cannot be misread; the meeting's own zone is written into the description
 * with `inZone()`, so the reader still sees "15:00 (Europe/London)".
 *
 * Pure: no `env()`, no `next/*`, no Node built-ins — octets are counted with
 * `TextEncoder` — so it is tested like `wall-clock.ts`. The host and origin
 * are arguments (`env().AUTH_URL`, never the Host header).
 */

/** What a meeting with no recorded end is assumed to last. The booking page
 *  and `book_meeting` both default to this, so it is the honest guess — and
 *  the description says it is a guess. */
export const DEFAULT_DURATION_MINUTES = 30

export const ICS_PRODID = '-//Agency OS//meetings//EN'

export interface IcsMeeting {
  readonly id: string
  readonly title: string | null
  readonly startsAt: Date
  readonly endsAt: Date | null
  readonly timeZone: string
  readonly source: string
  readonly cancelledAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date | null
}

export interface IcsInput {
  readonly meeting: IcsMeeting
  readonly company: { readonly domain: string; readonly name: string | null }
  /** `new URL(AUTH_URL).host` — the right-hand side of the UID. */
  readonly host: string
  /** `AUTH_URL`'s origin, for the link back to the brief. */
  readonly origin: string
  /** When the file is generated: DTSTAMP, per §3.8.7.2 with a METHOD. */
  readonly now: Date
}

/** 2026-09-22T14:00:00.000Z → 20260922T140000Z (RFC 5545 §3.3.5, form #2). */
export function icsUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
}

/**
 * A TEXT value (§3.3.11): backslash, semicolon and comma escaped, a line
 * break written as `\n`, and a colon left alone. The other control
 * characters are not allowed in TEXT at all (TSAFE-CHAR excludes every CTL
 * but HTAB), so they are dropped rather than written raw.
 */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

const encoder = new TextEncoder()
const MAX_OCTETS = 75

/**
 * Fold a content line to at most 75 OCTETS per physical line (§3.1), each
 * continuation starting with one space — which counts, so a continuation
 * carries 74 octets of content.
 *
 * Octets, not `.length`: `.length` counts UTF-16 units, so an accented line
 * of 75 "characters" is well over 75 octets, and cutting by units can split
 * a surrogate pair. The RFC warns that "very simple implementations"
 * fold in the middle of a UTF-8 sequence; iterating with `for…of` walks code
 * points, so a fold only ever lands between two of them.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line
  const parts: string[] = []
  let current = ''
  let octets = 0
  let limit = MAX_OCTETS
  for (const ch of line) {
    const n = encoder.encode(ch).length
    if (octets + n > limit) {
      parts.push(current)
      current = ''
      octets = 0
      limit = MAX_OCTETS - 1
    }
    current += ch
    octets += n
  }
  parts.push(current)
  return parts.join('\r\n ')
}

/**
 * The company as the file may name it. A free-mail lead's company row is
 * `<address>.inbound`, named after the person — the address and the name in
 * disguise — so neither is written; the brief page behind the login says who.
 */
function companyLabel(company: IcsInput['company']): string {
  if (company.domain.endsWith('.inbound')) return 'an inbound lead'
  return company.name?.trim() || company.domain
}

/**
 * The event's title. A person's own title is kept — they chose the words for
 * their own calendar. A booking-page title is not a person's choice: the
 * system writes it from the visitor's name ("Intro call with <name>"), so it
 * is rebuilt from the company instead.
 */
function eventTitle(meeting: IcsMeeting, who: string): string {
  if (meeting.source === 'booking_page') return `Intro call with ${who}`
  return meeting.title?.trim() || `Meeting with ${who}`
}

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  manual: 'Recorded by a teammate in Agency OS.',
  agent: 'Recorded by the agent in Agency OS.',
  booking_page: 'Booked through the public booking page.',
}

/** The whole file, every line CRLF-terminated (§3.1). */
export function meetingToIcs(input: IcsInput): string {
  const { meeting, company, host, now } = input
  const cancelled = meeting.cancelledAt !== null
  const who = companyLabel(company)
  const brief = `${input.origin.replace(/\/+$/, '')}/meetings/${meeting.id}`
  const modified = meeting.updatedAt ?? meeting.cancelledAt

  const description = [
    `Meeting with ${who}, ${inZone(meeting.startsAt, meeting.timeZone)}.`,
    meeting.endsAt ? null : `No end time was recorded; ${DEFAULT_DURATION_MINUTES} minutes assumed.`,
    cancelled ? 'This meeting was cancelled.' : null,
    SOURCE_WORDS[meeting.source] ?? `Source: ${meeting.source.replace(/_/g, ' ')}.`,
    'This file adds the meeting to your own calendar. Nobody is invited by it.',
    `Brief: ${brief}`,
  ].filter((l): l is string => l !== null).join('\n')

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // The same UID on every download of this meeting is what lets a calendar
    // update the event rather than add a second — and what lets the
    // cancelled file cancel the event already imported.
    `UID:${meeting.id}@${host}`,
    `DTSTAMP:${icsUtc(now)}`,
    `CREATED:${icsUtc(meeting.createdAt)}`,
    ...(modified ? [`LAST-MODIFIED:${icsUtc(modified)}`] : []),
    `DTSTART:${icsUtc(meeting.startsAt)}`,
    // DTEND or DURATION, never both (§3.6.1).
    meeting.endsAt ? `DTEND:${icsUtc(meeting.endsAt)}` : `DURATION:PT${DEFAULT_DURATION_MINUTES}M`,
    // No sequence column exists: cancellation is the one revision this system
    // records, so 0 and 1 are deterministic and monotone (§3.8.7.4).
    `SEQUENCE:${cancelled ? 1 : 0}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    // Many clients show STATUS poorly; the title says it too.
    `SUMMARY:${escapeText(`${cancelled ? 'Cancelled: ' : ''}${eventTitle(meeting, who)}`)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${brief}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
