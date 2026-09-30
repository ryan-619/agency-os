import { NextResponse } from 'next/server'
import { ENROL_LIMIT_MAX, assertCan, enrolSkipCounts } from '@agency/core'
import { enrolCampaign, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Enrol a campaign: one draft per enrollable contact (PROMPT.md §8.4).
 *
 * `{ dryRun: true }` is the preview — the same plan, nothing written — and
 * the campaign card asks for it before it offers to queue anything, in the
 * spirit of the proposal button that says why before it is pressed.
 *
 * Everything this writes is a draft parked on a person (or `queued`, when
 * the campaign auto-sends). NOTHING is sent here: the worker sends, through
 * the single send path, after re-checking every rule at the moment of
 * sending. That is also why enrolment never reads the suppression list —
 * §2.1 puts that check in the send path, never in the campaign builder.
 *
 * The work, the refusals and the audit row are all `enrolCampaign`'s; this
 * checks who is asking and what they asked for. The response carries counts,
 * never ids or addresses.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'campaigns:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such campaign.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { dryRun, limit } = (body ?? {}) as { dryRun?: unknown; limit?: unknown }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return NextResponse.json({ error: 'dryRun must be true or false, or left out.' }, { status: 400 })
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > ENROL_LIMIT_MAX)) {
    return NextResponse.json(
      { error: `limit must be a whole number from 1 to ${ENROL_LIMIT_MAX}, or left out.` },
      { status: 400 },
    )
  }

  const db = getDb() as unknown as AgencyDb
  const r = await enrolCampaign(db, {
    orgId: user.orgId,
    campaignId: id,
    actor: user.id,
    senderName: user.name?.trim() || null,
    dryRun: dryRun === true,
    ...(typeof limit === 'number' ? { limit } : {}),
  })
  if (!r.ok) {
    return NextResponse.json(
      { error: r.message, reason: r.reason },
      { status: r.reason === 'no_such_campaign' ? 404 : 409 },
    )
  }

  return NextResponse.json(
    {
      dryRun: r.dryRun,
      status: r.status,
      queued: r.queued.length,
      skipped: enrolSkipCounts(r.skipped),
      skippedTotal: r.skipped.length,
      truncated: r.truncated,
      limit: r.limit,
      suppressedHint: r.suppressedHint,
    },
    { status: r.dryRun ? 200 : 201 },
  )
}
