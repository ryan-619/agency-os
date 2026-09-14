import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  appendAudit, pauseContact, readContact, resumeContact, updateContactTimeZone, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Change a contact (PROMPT.md §8.4).
 *
 * Three edits, each with a reason to exist on its own:
 *
 *  - `pause` with a reason. What a reply does automatically, done by hand —
 *    "they emailed me directly", "out of office until March".
 *  - `resume`. A person deciding a paused contact may be written to again.
 *    Deliberate, audited, and the ONLY way a pause ends.
 *  - `timeZone`. The thing that unblocks a contact the send path has been
 *    refusing as `unknown_timezone`.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(
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
  const contact = await readContact(db, user.orgId, id)
  if (!contact) return NextResponse.json({ error: 'No such contact.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { action, reason, timeZone } = (body ?? {}) as { action?: unknown; reason?: unknown; timeZone?: unknown }

  if (action === 'pause') {
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (!why) return NextResponse.json({ error: 'Say why — a pause with no reason gets cleared.' }, { status: 400 })
    const paused = await pauseContact(db, user.orgId, id, `${why} (by ${user.email ?? user.id})`)
    await appendAudit(db, {
      orgId: user.orgId, actor: user.id, action: 'contact.paused', subjectType: 'contact', subjectId: id,
      detail: { reason: why.slice(0, 200), alreadyPaused: !paused },
    }).catch(() => {})
    return NextResponse.json({ paused: true })
  }

  if (action === 'resume') {
    await resumeContact(db, user.orgId, id)
    await appendAudit(db, {
      orgId: user.orgId, actor: user.id, action: 'contact.resumed', subjectType: 'contact', subjectId: id,
      detail: { hadReason: contact.pausedReason },
    }).catch(() => {})
    return NextResponse.json({ paused: false })
  }

  if (action === 'timeZone') {
    const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : null
    const r = await updateContactTimeZone(db, user.orgId, id, zone)
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: 400 })
    await appendAudit(db, {
      orgId: user.orgId, actor: user.id, action: 'contact.timezone_set', subjectType: 'contact', subjectId: id,
      detail: { timeZone: zone },
    }).catch(() => {})
    return NextResponse.json({ timeZone: zone })
  }

  return NextResponse.json({ error: 'action must be pause, resume or timeZone' }, { status: 400 })
}
