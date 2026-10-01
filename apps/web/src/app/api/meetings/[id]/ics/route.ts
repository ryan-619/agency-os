import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { readMeetingWithCompany, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { meetingToIcs } from '@/lib/ics'

/**
 * A meeting as an `.ics` file, for the signed-in team member's OWN calendar.
 *
 * A download, not an invitation (CLAUDE.md §2 "Not built: calendar
 * invitations"): `METHOD:PUBLISH` with no attendee is the shape a calendar
 * imports silently rather than offering to mail, and nothing is sent to
 * anyone by this route. `lib/ics.ts` says what the file carries and why it
 * carries nothing personal.
 *
 * Behind the cookie gate, then `deals:read`, then an org-scoped read — so
 * another org's meeting id is a 404 like one that does not exist, never a
 * 403 that confirms it does. The UID's host and the brief link come from
 * `AUTH_URL`, never the request's Host header.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:read')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such meeting.' }, { status: 404 })
  const found = await readMeetingWithCompany(getDb() as unknown as AgencyDb, user.orgId, id)
  if (!found) return NextResponse.json({ error: 'No such meeting.' }, { status: 404 })

  const origin = new URL(env().AUTH_URL)
  const body = meetingToIcs({
    meeting: found.meeting,
    company: found.company,
    host: origin.host,
    origin: origin.origin,
    now: new Date(),
  })
  return new Response(body, {
    status: 200,
    headers: {
      // The `method` parameter MUST match the file's METHOD (RFC 5545 §3.7.2).
      'content-type': 'text/calendar; charset=utf-8; method=PUBLISH',
      // ASCII only, so never the title: a quote or an accent breaks the header.
      'content-disposition': `attachment; filename="meeting-${found.meeting.id}.ics"`,
      // It names a company; no browser or proxy keeps a copy.
      'cache-control': 'private, no-store',
    },
  })
}
