import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, readContact, recordConsent, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Record consent for one channel (PROMPT.md §2.1).
 *
 * "Every contact row carries a `consent` record. `sms_consent` and
 * `voice_consent` are separate booleans with a `source` and `recorded_at`."
 * One row per channel, so a yes to email says nothing about SMS — and a
 * `source` is required by the schema, by this route, and by sense: a consent
 * nobody can say the origin of is not one.
 *
 * Recording a consent does NOT remove a suppression. Somebody who opted in
 * last month and asked to be left alone this morning is suppressed, and only
 * an owner removing the suppression changes that.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CHANNELS = new Set(['email', 'sms', 'voice', 'whatsapp'])

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  const db = getDb() as unknown as AgencyDb
  if (!(await readContact(db, user.orgId, id))) {
    return NextResponse.json({ error: 'No such contact.' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { channel, granted, source } = (body ?? {}) as { channel?: unknown; granted?: unknown; source?: unknown }
  if (typeof channel !== 'string' || !CHANNELS.has(channel)) {
    return NextResponse.json({ error: 'channel must be email, sms, voice or whatsapp' }, { status: 400 })
  }
  if (typeof granted !== 'boolean') {
    return NextResponse.json({ error: 'granted must be true or false' }, { status: 400 })
  }
  // Checked HERE, before the "(recorded by …)" suffix is appended: with the
  // suffix, a blank source is non-blank, and `recordConsent`'s own check —
  // the one the schema's `consents_source_is_not_blank` backs — never fires.
  // Found by review.
  if (typeof source !== 'string' || source.trim().length === 0) {
    return NextResponse.json({ error: 'Say where this consent came from — a form, a call, a reply.' }, { status: 400 })
  }

  const r = await recordConsent(db, {
    orgId: user.orgId,
    contactId: id,
    channel: channel as 'email' | 'sms' | 'voice' | 'whatsapp',
    granted,
    source: `${source.trim()} (recorded by ${user.email ?? user.id})`,
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: 400 })

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: granted ? 'consent.granted' : 'consent.declined',
    subjectType: 'contact',
    subjectId: id,
    detail: { channel, source: source.trim().slice(0, 200) },
  }).catch(() => {})
  return NextResponse.json({ channel, granted })
}
