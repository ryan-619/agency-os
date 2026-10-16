import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  appendAudit, contactDelete, contactPatchInput, contactPauseByHand, contactResumeByHand, contactsUpdate,
  readContact, updateContactTimeZone, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { deleteAnswer } from '@/lib/delete-answer'
import { log } from '@/lib/logger'

/**
 * Change a contact (PROMPT.md §8.4).
 *
 * Four edits, each with a reason to exist on its own:
 *
 *  - `pause` with a reason. What a reply does automatically, done by hand —
 *    "they emailed me directly", "out of office until March". Over a
 *    reply's pause it REPLACES the reply's reason, so answering that reply
 *    cannot lift the teammate's hold; over any other pause it is refused
 *    with a sentence (409) and that pause stands (`contactPauseByHand`).
 *  - `resume` with `pausedReason`, the pause the page SHOWED (its reason's
 *    text). A person deciding a paused contact may be written to
 *    again. Deliberate, audited, and the ONLY way a pause ends — except the
 *    two a person may not lift: an opt-out nobody could record, and an
 *    erasure that did not finish, which are recorded or finished instead
 *    (`contactResumeByHand`, 409 with its sentence). It lifts the pause the
 *    page showed and no other (review round 4): this route used to judge
 *    and lift the pause IT read after the click, so a teammate's hold
 *    written after the page loaded was lifted from a stale tab. A pause
 *    that changed since is a 409 saying to reload. The `contact.resumed`
 *    row is written by `contactResumeByHand`, in the resume's own
 *    transaction, never here.
 *  - `timeZone`. The thing that unblocks a contact the send path has been
 *    refusing as `unknown_timezone`.
 *  - `update`: name, title and addresses (`contactPatchInput`). The email is
 *    folded, a duplicate is refused with a sentence, a changed address is
 *    recorded as typed by a teammate (`person`, 0029), and an address a
 *    suppression row matches cannot be edited away (`contactsUpdate` says
 *    why) — nor, until the number is recorded, the phone of a contact held
 *    because a number they share asked to stop (review round 9). The audit
 *    row names the fields that changed and never their values — an address
 *    in an audit detail is an address in every export of the audit log
 *    (§2.3).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const { action, reason, timeZone, pausedReason } = (body ?? {}) as {
    action?: unknown
    reason?: unknown
    timeZone?: unknown
    pausedReason?: unknown
  }

  if (action === 'pause') {
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (!why) return NextResponse.json({ error: 'Say why — a pause with no reason gets cleared.' }, { status: 400 })
    const r = await contactPauseByHand(db, {
      orgId: user.orgId, contactId: id, reason: `${why} (by ${user.email ?? user.id})`,
    })
    if (!r.ok) {
      return NextResponse.json({ error: r.message, reason: r.reason }, { status: r.reason === 'not_found' ? 404 : 409 })
    }
    await appendAudit(db, {
      orgId: user.orgId, actor: user.id, action: 'contact.paused', subjectType: 'contact', subjectId: id,
      // `alreadyPaused` stays false: a pause that changed nothing is now a
      // 409, never a row. `replacedPauseFor` names the reply's pause this one
      // replaced — its class, never its text.
      detail: { reason: why.slice(0, 200), alreadyPaused: false, ...(r.replaced ? { replacedPauseFor: r.replaced } : {}) },
    }).catch(() => {})
    return NextResponse.json({ paused: true, replaced: r.replaced })
  }

  if (action === 'resume') {
    // The pause the page showed, sent back by the button: its reason's text,
    // or null for a pause with no reason. Absent — a page from before this
    // rule — is refused, 400, with nothing changed: there is no pause to
    // name, and lifting whatever pause this route reads instead is exactly
    // what the rule replaced. There is no fallback.
    if (pausedReason !== null && typeof pausedReason !== 'string') {
      return NextResponse.json(
        { error: 'Resume names the pause it lifts. Reload the page and try again. Nothing was changed.' },
        { status: 400 },
      )
    }
    const r = await contactResumeByHand(db, {
      orgId: user.orgId, contact, expectedReason: pausedReason, actor: user.id,
    })
    if (!r.ok) {
      return NextResponse.json({ error: r.message, reason: r.reason }, { status: r.reason === 'not_found' ? 404 : 409 })
    }
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
    // A teammate typed whatever address this changes (0029): `person`, from
    // the session and never the body, which could otherwise claim a page or
    // the assistant. `contactsUpdate` reads a source only for an address that
    // CHANGES, so an edit to a title leaves an imported email's source alone.
    const r = await contactsUpdate(db, user.orgId, id, { ...parsed.data, emailSource: 'person', phoneSource: 'person' })
    if (!r.ok) {
      // `shared_number_hold` (review round 9): a phone held for a shared
      // number's unrecorded STOP is a conflict with state, like `suppressed`,
      // and its sentence says what to record first.
      const conflict = ['duplicate', 'changed_meanwhile', 'suppressed', 'shared_number_hold'].includes(r.reason)
      const status = r.reason === 'no_such_contact' ? 404 : conflict ? 409 : 400
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

/**
 * Delete a person nothing ever went to or came from (2026-10-15) — any
 * member who may change contacts, as adding one is. `contactDelete` refuses
 * everybody else with a sentence (409): a message went or may have, a reply
 * or a call came in, they said no, or an opt-out of theirs could not be
 * recorded — each a case for an owner's erasure, which keeps their
 * addresses on the suppression list. The audit row is the writer's, in its
 * own transaction.
 */
export async function DELETE(
  _request: Request,
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
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found', message: 'No such contact.' }, { status: 404 })
  // Lower-cased, as the database prints an id — and the writer does it again
  // (review, 2026-10-15): an id in capitals skipped every keep reason.
  const a = await deleteAnswer(
    'contact',
    () => contactDelete(getDb() as unknown as AgencyDb, { orgId: user.orgId, contactId: id.toLowerCase(), actor: user.id }),
    log,
  )
  return NextResponse.json(a.body, { status: a.status })
}
