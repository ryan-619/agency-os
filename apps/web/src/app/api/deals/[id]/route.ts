import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { assertCan } from '@agency/core'
import { DEAL_STAGES, appendAudit, schema, setDealStage, type AgencyDb, type DealStage } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Move a deal on the board (PROMPT.md §8.6).
 *
 * A person dragging a card is the one caller allowed to move a deal in
 * EITHER direction, so this goes through `setDealStage`, not `advanceDeal`.
 * A drop on `lost` needs a reason — the only thing anyone learns from a
 * lost deal — and the board asks before it calls here. Every move writes
 * an audit row naming the person, the stage it left and the stage it
 * reached: the pipeline's history is the audit log, not a column.
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
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  const db = getDb() as unknown as AgencyDb
  const [current] = await db
    .select()
    .from(schema.deals)
    .where(and(eq(schema.deals.orgId, user.orgId), eq(schema.deals.id, id)))
    .limit(1)
  if (!current) return NextResponse.json({ error: 'No such deal.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { stage, lostReason, nextAction, valueCents } = (body ?? {}) as {
    stage?: unknown; lostReason?: unknown; nextAction?: unknown; valueCents?: unknown
  }

  // Details first — they do not need a stage change and cannot fail on one.
  const details: { nextAction?: string | null; valueCents?: number | null } = {}
  if (nextAction !== undefined) {
    if (nextAction !== null && typeof nextAction !== 'string') {
      return NextResponse.json({ error: 'nextAction must be text' }, { status: 400 })
    }
    details.nextAction = nextAction === null ? null : nextAction.trim().slice(0, 300) || null
  }
  if (valueCents !== undefined) {
    if (valueCents !== null && (typeof valueCents !== 'number' || !Number.isInteger(valueCents) || valueCents < 0)) {
      return NextResponse.json({ error: 'valueCents must be a whole number of cents, or null' }, { status: 400 })
    }
    details.valueCents = valueCents as number | null
  }
  if (Object.keys(details).length > 0) {
    await db.update(schema.deals).set(details).where(eq(schema.deals.id, current.id))
  }

  let moved = current
  if (stage !== undefined) {
    if (typeof stage !== 'string' || !(DEAL_STAGES as readonly string[]).includes(stage)) {
      return NextResponse.json({ error: `stage must be one of ${DEAL_STAGES.join(', ')}` }, { status: 400 })
    }
    if (stage === 'lost' && (typeof lostReason !== 'string' || !lostReason.trim())) {
      return NextResponse.json({ error: 'A lost deal needs a reason. It is the only thing anyone learns from one.' }, { status: 400 })
    }
    if (stage !== current.stage || current.closedAt) {
      // A second OPEN deal for the company would violate `deals_one_open_per_company`
      // (0012) if this one is being reopened; surface that as a sentence.
      try {
        const row = await setDealStage(db, {
          orgId: user.orgId,
          dealId: current.id,
          stage: stage as DealStage,
          lostReason: typeof lostReason === 'string' ? lostReason.trim().slice(0, 500) : null,
        })
        if (!row) return NextResponse.json({ error: 'No such deal.' }, { status: 404 })
        moved = row
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/deals_one_open_per_company/.test(message)) {
          return NextResponse.json(
            { error: 'This company already has an open deal. Close that one before reopening this.' },
            { status: 409 },
          )
        }
        return NextResponse.json({ error: message.slice(0, 300) }, { status: 400 })
      }
    }
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: stage !== undefined && stage !== current.stage ? `deal.moved` : 'deal.updated',
    subjectType: 'deal',
    subjectId: current.id,
    detail: {
      companyId: current.companyId,
      from: current.stage,
      to: moved.stage,
      ...(moved.lostReason ? { lostReason: moved.lostReason } : {}),
      ...(details.nextAction !== undefined ? { nextAction: details.nextAction } : {}),
      ...(details.valueCents !== undefined ? { valueCents: details.valueCents } : {}),
    },
  }).catch(() => {})
  return NextResponse.json({
    id: current.id,
    stage: moved.stage,
    closedAt: moved.closedAt ? moved.closedAt.toISOString() : null,
    nextAction: details.nextAction !== undefined ? details.nextAction : moved.nextAction,
    valueCents: details.valueCents !== undefined ? details.valueCents : moved.valueCents,
  })
}
