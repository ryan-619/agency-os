import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { createMeeting, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Book a meeting from inside the app (PROMPT.md §8.6).
 *
 * Records the meeting and moves the deal forward to `meeting`. It does NOT
 * send an invitation: the calendar sits behind the Google Calendar MCP
 * connector, which the agent reaches through the gate, and a person who
 * booked by hand sends their own invite. Saying so in the response keeps
 * the UI from implying otherwise.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const b = (body ?? {}) as {
    companyId?: unknown; contactId?: unknown; title?: unknown; startsAt?: unknown
    endsAt?: unknown; timeZone?: unknown; notes?: unknown
  }
  if (typeof b.companyId !== 'string' || !UUID.test(b.companyId)) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }
  if (b.contactId !== undefined && b.contactId !== null && (typeof b.contactId !== 'string' || !UUID.test(b.contactId))) {
    return NextResponse.json({ error: 'contactId must be an id' }, { status: 400 })
  }
  if (typeof b.startsAt !== 'string' || Number.isNaN(Date.parse(b.startsAt))) {
    return NextResponse.json({ error: 'startsAt must be an ISO-8601 time' }, { status: 400 })
  }
  if (b.endsAt !== undefined && b.endsAt !== null && (typeof b.endsAt !== 'string' || Number.isNaN(Date.parse(b.endsAt)))) {
    return NextResponse.json({ error: 'endsAt must be an ISO-8601 time' }, { status: 400 })
  }
  if (typeof b.timeZone !== 'string' || !b.timeZone.trim()) {
    return NextResponse.json({ error: 'timeZone is required — the meeting is at a wall-clock time somewhere' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const r = await createMeeting(db, {
    orgId: user.orgId,
    companyId: b.companyId,
    contactId: typeof b.contactId === 'string' ? b.contactId : null,
    title: typeof b.title === 'string' ? b.title.slice(0, 200) : null,
    startsAt: new Date(b.startsAt),
    endsAt: typeof b.endsAt === 'string' ? new Date(b.endsAt) : null,
    timeZone: b.timeZone.trim(),
    source: 'manual',
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : null,
    createdBy: user.id,
    actor: user.id,
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: 400 })
  return NextResponse.json(
    { id: r.meeting.id, deal: r.deal, note: 'Recorded. No invitation was sent — send one from your calendar.' },
    { status: 201 },
  )
}
