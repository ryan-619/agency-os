import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, erasureRecord, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Everything held about one person, as a JSON download — the answer to a
 * subject-access request, and the copy to keep before an erasure.
 *
 * `erasureRecord` reads the contact row, their consents with the evidence
 * each was recorded with, messages both ways, meetings, calls, notes, the
 * tasks hanging off their messages, the suppression rows that match them,
 * and the audit log's history of those suppression rows — which carry the
 * value they changed and outlive an erasure. Full rows, because the request
 * is for what is HELD. The file says what it does not include (chat
 * transcripts, the rest of the audit detail, the carrier's recordings) in its
 * own `notIncluded`.
 *
 * Gated on `contacts:read`, like the consent export: it names a person.
 * Audited as `contact.exported` BEFORE the file is produced, like every
 * export — a download nobody can see happened is data leaving unrecorded.
 * The audit row carries the id only (§2.3). The filename carries the id,
 * never a name: it lands in a downloads folder and a browser's history.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:read')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  // Another org's contact is a 404, not a 403: its existence is not this caller's to learn.
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such contact.' }, { status: 404 })

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const record = await erasureRecord(db, user.orgId, id, now)
  if (!record) return NextResponse.json({ error: 'No such contact.' }, { status: 404 })

  try {
    await appendAudit(db, {
      orgId: user.orgId,
      actor: user.id,
      action: 'contact.exported',
      subjectType: 'contact',
      subjectId: id,
      detail: { contactId: id },
    })
  } catch (err) {
    log.error('export not recorded', { view: 'contact_record', err: err instanceof Error ? err.name : 'unknown' })
    return NextResponse.json(
      { error: 'The download could not be recorded in the audit log, so it was not produced. Try again.' },
      { status: 503 },
    )
  }

  const filename = `contact-record-${id.toLowerCase()}-${now.toISOString().slice(0, 10)}.json`
  return new Response(`${JSON.stringify(record, null, 2)}\n`, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // A person's data: no shared cache, no browser cache, no content sniffing.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
