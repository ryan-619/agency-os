import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  appendAudit, contactPatchInput, contactsUpdate, pauseContact, pauseReasonClass, readContact, resumeContact,
  updateContactTimeZone, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Change a contact (PROMPT.md §8.4).
 *
 * Four edits, each with a reason to exist on its own:
 *
 *  - `pause` with a reason. What a reply does automatically, done by hand —
 *    "they emailed me directly", "out of office until March".
 *  - `resume`. A person deciding a paused contact may be written to again.
 *    Deliberate, audited, and the ONLY way a pause ends.
 *  - `timeZone`. The thing that unblocks a contact the send path has been
 *    refusing as `unknown_timezone`.
 *  - `update`: name, title and addresses (`contactPatchInput`). The email is
 *    folded, a duplicate is refused with a sentence, and an address a
 *    suppression row matches cannot be edited away (`contactsUpdate` says
 *    why). The audit row names the fields that changed and never their
 *    values — an address in an audit detail is an address in every export
 *    of the audit log (§2.3).
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
      // The CLASS of the pause, never its text: a manual reason carries a
      // teammate's address and, often, the contact's own words, and the audit
      // log is append-only — an erasure cannot scrub it.
      detail: { pausedFor: pauseReasonClass(contact.pausedReason) },
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

  if (action === 'update') {
    const parsed = contactPatchInput.safeParse(body)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return NextResponse.json(
        { error: `${first?.path.join('.') ?? 'input'}: ${first?.message ?? 'Invalid.'}` },
        { status: 400 },
      )
    }
    const r = await contactsUpdate(db, user.orgId, id, parsed.data)
    if (!r.ok) {
      const status =
        r.reason === 'no_such_contact' ? 404 : r.reason === 'duplicate' || r.reason === 'changed_meanwhile' || r.reason === 'suppressed' ? 409 : 400
      return NextResponse.json({ error: r.message, reason: r.reason }, { status })
    }
    if (r.changed.length > 0) {
      await appendAudit(db, {
        orgId: user.orgId, actor: user.id, action: 'contact.updated', subjectType: 'contact', subjectId: id,
        detail: { fields: r.changed },
      }).catch(() => {})
    }
    return NextResponse.json({ changed: r.changed })
  }

  return NextResponse.json({ error: 'action must be pause, resume, timeZone or update' }, { status: 400 })
}
