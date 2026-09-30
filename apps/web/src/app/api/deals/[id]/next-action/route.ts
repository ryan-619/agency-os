import { NextResponse } from 'next/server'
import { assertCan, dealIsOverdue } from '@agency/core'
import { dealsSetNextActionAt, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Set or clear the date a deal's next action is due.
 *
 * `deals.next_action_at` had no writer until this route, and it is a route
 * of its own rather than another field on `PATCH /api/deals/[id]`: that one
 * moves cards and belongs to the board's other controls, and a due date is
 * a separate, separately audited fact (`deal.next_action_set { from, to }`,
 * written by `dealsSetNextActionAt` in the same transaction as the change).
 *
 * The body is `{ nextActionAt: ISO string | null }`. The board sends the END
 * of the chosen day in the viewer's own zone, so "overdue" means the day has
 * passed where the person who set it lives; `null` clears it. Nothing here
 * sends anything or tells anybody — it is a date on a card.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** A deal id is a uuid; anything else is not one of ours, and not a 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A due date outside this window is a typo, not a plan. */
const EARLIEST = Date.UTC(2000, 0, 1)
const LATEST = Date.UTC(2100, 0, 1)

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such deal.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'The body must be { nextActionAt: ISO date-time | null }' }, { status: 400 })
  }
  const raw = body as { nextActionAt?: unknown }
  // `undefined` is not "clear it": a body that forgot the field must not
  // wipe a date somebody set on purpose.
  if (!('nextActionAt' in raw) || raw.nextActionAt === undefined) {
    return NextResponse.json({ error: 'nextActionAt is required: a date, or null to clear it' }, { status: 400 })
  }
  let at: Date | null = null
  if (raw.nextActionAt !== null) {
    if (typeof raw.nextActionAt !== 'string' || raw.nextActionAt.length > 40) {
      return NextResponse.json({ error: 'nextActionAt must be an ISO date-time, or null' }, { status: 400 })
    }
    at = new Date(raw.nextActionAt)
    const ms = at.getTime()
    if (!Number.isFinite(ms) || ms < EARLIEST || ms >= LATEST) {
      return NextResponse.json({ error: 'nextActionAt must be a real date between 2000 and 2100' }, { status: 400 })
    }
  }

  const db = getDb() as unknown as AgencyDb
  const result = await dealsSetNextActionAt(db, { orgId: user.orgId, dealId: id, at, actor: user.id })
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'closed' ? 409 : 400
    return NextResponse.json({ error: result.message }, { status })
  }
  return NextResponse.json({
    id: result.deal.id,
    nextActionAt: result.deal.nextActionAt ? result.deal.nextActionAt.toISOString() : null,
    // Decided here, by core's rule, so the board never re-derives it.
    overdue: dealIsOverdue(result.deal.nextActionAt, new Date()),
    // The UPDATE touched the row, so the card's "untouched" count restarts.
    updatedAt: (result.deal.updatedAt ?? result.deal.createdAt).toISOString(),
  })
}
