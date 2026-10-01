import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { NOTE_MAX_CHARS, notesAdd, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Add a note to a company, optionally about one of its contacts.
 *
 * A note is a teammate's words (§2.2): it is stored beside the evidence and
 * never becomes evidence — nothing that writes a proposal or a brief reads
 * it. The author is the signed-in person, never a field in the body, so a
 * note cannot be put in somebody else's mouth. Nothing is sent.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'companies:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const b = (body ?? {}) as { companyId?: unknown; contactId?: unknown; body?: unknown }
  if (typeof b.companyId !== 'string' || !UUID.test(b.companyId)) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }
  if (b.contactId !== undefined && b.contactId !== null && (typeof b.contactId !== 'string' || !UUID.test(b.contactId))) {
    return NextResponse.json({ error: 'contactId must be an id' }, { status: 400 })
  }
  if (typeof b.body !== 'string') {
    return NextResponse.json({ error: 'A note needs some words in it.' }, { status: 400 })
  }
  // A cheap bound before the database is asked anything. `notesAdd` counts
  // characters exactly; this only stops a body that cannot possibly fit,
  // since one character is at most two UTF-16 units.
  if (b.body.length > NOTE_MAX_CHARS * 2) {
    return NextResponse.json({ error: `A note is at most ${NOTE_MAX_CHARS.toLocaleString('en-US')} characters.` }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const r = await notesAdd(db, {
    orgId: user.orgId,
    companyId: b.companyId,
    contactId: typeof b.contactId === 'string' ? b.contactId : null,
    authorUserId: user.id,
    body: b.body,
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'not_found' ? 404 : 400 })
  return NextResponse.json(
    { id: r.note.id, note: 'Saved. A note is never quoted as evidence, and nothing was sent.' },
    { status: 201 },
  )
}
