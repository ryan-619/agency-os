import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, decideApproval } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import type { AgencyDb } from '@agency/db/queries'

/**
 * A human decides (PROMPT.md §2.4).
 *
 * This is the other end of the approval gate: the agent worker is parked on a
 * row, and this is what changes it. There is no direct call between the two
 * processes — the worker polls the row — so this route's only job is to write
 * a decision that is unambiguous about WHO made it and WHEN.
 *
 * All four outcomes below are ordinary, and none of them is a 500:
 *
 *   200  the decision was recorded
 *   409  someone else decided first — the response names them, so the loser's
 *        card can re-render as "Priya approved this" instead of an error
 *   410  it expired while the tab was open
 *   404  no such approval in this org
 *
 * The 409 is the one worth designing for. Two people looking at the same queue
 * is the normal case in a five-person agency, and a race that surfaces as a
 * stack trace teaches them to stop trusting the screen.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  try {
    // The same function the UI uses to decide whether to render the buttons.
    // Hiding a button is not access control.
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'approvals:decide')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { decision, reason } = (body ?? {}) as { decision?: unknown; reason?: unknown }
  if (decision !== 'approved' && decision !== 'denied') {
    return NextResponse.json({ error: 'decision must be "approved" or "denied"' }, { status: 400 })
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
    return NextResponse.json({ error: 'reason must be a string under 500 characters' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const outcome = await decideApproval(db, {
    orgId: user.orgId,
    id,
    decision,
    decidedBy: user.id,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
  })

  if (outcome.ok) {
    // §5.4: approval decides, the audit log remembers. Written here rather
    // than inside decideApproval so the row records the HUMAN as the actor —
    // the worker's own audit rows are written by 'agent'.
    await appendAudit(db, {
      orgId: user.orgId,
      actor: user.id,
      action: decision === 'approved' ? 'approval.approved' : 'approval.denied',
      subjectType: 'approval',
      subjectId: id,
      detail: { toolName: outcome.row.toolName, risk: outcome.row.risk },
    }).catch(() => {
      // A failed audit write must not undo a decision a person made. The row
      // itself is the record that matters; this is the narrative beside it.
    })
    return NextResponse.json({ status: outcome.row.status, decidedAt: outcome.row.decidedAt })
  }

  switch (outcome.reason) {
    case 'already_decided':
      return NextResponse.json(
        {
          error: 'already_decided',
          status: outcome.row.status,
          decidedAt: outcome.row.decidedAt,
          decidedBy: outcome.row.decidedBy,
        },
        { status: 409 },
      )
    case 'expired':
      return NextResponse.json({ error: 'expired', expiresAt: outcome.row.expiresAt }, { status: 410 })
    case 'not_permitted':
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
}
