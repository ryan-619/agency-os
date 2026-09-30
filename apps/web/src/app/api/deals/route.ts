import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { assertCan } from '@agency/core'
import { DEAL_STAGES, advanceDeal, appendAudit, schema, type AgencyDb, type DealStage } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Put a company on the board (PROMPT.md §8.6).
 *
 * A company has no deal until something happens to it — a send, a reply, or
 * a person deciding it is worth working. This is the last of those. It goes
 * through `advanceDeal`, so a company that already has an open deal is not
 * given a second one, and a deal already further along is left where it is.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { companyId, stage, nextAction } = (body ?? {}) as { companyId?: unknown; stage?: unknown; nextAction?: unknown }
  if (typeof companyId !== 'string' || !UUID.test(companyId)) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }
  const to = typeof stage === 'string' && (DEAL_STAGES as readonly string[]).includes(stage) ? (stage as DealStage) : 'new'
  if (to === 'won' || to === 'lost') {
    return NextResponse.json({ error: 'A deal is not created closed. Create it, then close it.' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb

  // `deals.company_id` is a plain FK to `companies(id)`, NOT a composite on
  // (id, org_id) — so the database would happily accept another org's company
  // under this org's id, and `listDealsForBoard` joins companies by id alone
  // and would then print that company's domain on this org's board. Checked
  // here, the way `createMeeting` and `generateProposal` already check.
  const [company] = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, user.orgId), eq(schema.companies.id, companyId)))
    .limit(1)
  if (!company) return NextResponse.json({ error: 'That company is not in the CRM.' }, { status: 404 })

  let moved
  try {
    moved = await advanceDeal(db, {
      orgId: user.orgId,
      companyId,
      to,
      nextAction: typeof nextAction === 'string' ? nextAction.slice(0, 300) : null,
    })
  } catch {
    return NextResponse.json({ error: 'That company is not in the CRM.' }, { status: 404 })
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: `deal.${moved.outcome}`,
    subjectType: 'deal',
    subjectId: moved.deal.id,
    detail: { companyId, stage: moved.deal.stage },
  }).catch(() => {})
  return NextResponse.json({ id: moved.deal.id, stage: moved.deal.stage, outcome: moved.outcome }, { status: moved.outcome === 'created' ? 201 : 200 })
}
