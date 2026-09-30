import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertCan } from '@agency/core'
import { replyMarkHandled, replyReclassify, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { INBOX_MAX_REQUEST_BYTES, RECLASSIFY_HINT, firstIssue, inboxActionSchema } from '@/lib/inbox-view'

/**
 * A person acts on a reply (PROMPT.md §8.4).
 *
 *  - `handled`: somebody read it and dealt with it. Named and timed, once —
 *    the second of two clicks is a 409 that says so, not a 500.
 *  - `reclassify`: a person disagrees with the deterministic kind. Any of the
 *    five, and never `opted_out` in either direction (§2.1): the zod enum
 *    refuses it here, and `replyReclassify`'s predicate refuses it again in
 *    the UPDATE, so a caller that skipped this route still cannot. A reply
 *    from somebody on the suppression list, or an unclassified one whose own
 *    words read as a stop, keeps its kind too — both a 409.
 *
 * Neither sends anything. Neither ends a pause — that is the contacts route,
 * and a separate button, on purpose. One reclassification STARTS one: moving
 * a reply off "automatic reply" pauses the person and cancels what was queued
 * for them, as the reply would have if it had been read as theirs.
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

  // An id that is not a uuid is a reply that does not exist — not a query
  // for Postgres to reject with a 500.
  const { id } = await context.params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'That reply is not in this inbox.' }, { status: 404 })

  const raw = await request.text()
  if (raw.length > INBOX_MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = inboxActionSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 })

  const db = getDb() as unknown as AgencyDb

  if (parsed.data.action === 'handled') {
    const r = await replyMarkHandled(db, { orgId: user.orgId, touchId: id, userId: user.id })
    if (!r.ok) {
      return r.reason === 'not_found'
        ? NextResponse.json({ error: 'That reply is not in this inbox.', reason: r.reason }, { status: 404 })
        : NextResponse.json({ error: 'Someone already marked this handled.', reason: r.reason }, { status: 409 })
    }
    return NextResponse.json({ handled: true })
  }

  const r = await replyReclassify(db, { orgId: user.orgId, touchId: id, kind: parsed.data.kind, actor: user.id })
  if (!r.ok) {
    switch (r.reason) {
      case 'not_found':
        return NextResponse.json({ error: 'That reply is not in this inbox.', reason: r.reason }, { status: 404 })
      case 'suppressed':
        return NextResponse.json({ error: RECLASSIFY_SUPPRESSED, reason: r.reason }, { status: 409 })
      case 'reads_as_opt_out':
        return NextResponse.json({ error: RECLASSIFY_READS_AS_OPT_OUT, reason: r.reason }, { status: 409 })
      default:
        return NextResponse.json(
          { error: `This reply asked to stop, and ${RECLASSIFY_HINT.replace(/\.$/, '')}.`, reason: r.reason },
          { status: 409 },
        )
    }
  }
  return NextResponse.json({ kind: parsed.data.kind, from: r.from, paused: r.paused, cancelled: r.cancelled })
}

const RECLASSIFY_SUPPRESSED =
  'This person is on the suppression list, so this reply keeps its kind: relabelling it would make a reply from ' +
  'somebody who asked to stop read as something else.'

const RECLASSIFY_READS_AS_OPT_OUT =
  'This reply was never classified, and its own words read as a request to stop, so its kind is not changed here. ' +
  'If it is one, put the address on the suppression list.'

