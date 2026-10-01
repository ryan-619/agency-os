/**
 * The recorded moves behind /pipeline/analytics, read from the audit log.
 *
 * The rows these tests read are written by the REAL writers wherever one
 * exists — `advanceDeal` for the automatic moves — and shaped exactly like
 * `PATCH /api/deals/[id]`'s `deal.moved` otherwise. A test that pinned action
 * names nothing writes would prove nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { pipelineMetrics } from '@agency/core'
import {
  analyticsTransitions, advanceDeal, appendAudit, listDeals, schema, setDealStage, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('analyticsTransitions', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** Exactly what `PATCH /api/deals/[id]` writes when a person drags a card. */
  const boardMove = async (org: string, dealId: string, from: string, to: string): Promise<void> => {
    await setDealStage(db, { orgId: org, dealId, stage: to as 'meeting', lostReason: to === 'lost' ? 'went quiet' : null })
    await appendAudit(db, {
      orgId: org, actor: 'user-1', action: 'deal.moved', subjectType: 'deal', subjectId: dealId,
      detail: { companyId, from, to },
    })
  }

  it('reads the automatic moves advanceDeal records and the board’s moves, oldest first', async () => {
    const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    await advanceDeal(db, { orgId, companyId, to: 'replied' })
    await boardMove(orgId, deal.id, 'replied', 'meeting')

    const moves = await analyticsTransitions(db, orgId)
    expect(moves.map((m) => [m.dealId, m.from, m.to])).toEqual([
      [deal.id, null, 'contacted'],
      [deal.id, 'contacted', 'replied'],
      [deal.id, 'replied', 'meeting'],
    ])
    expect(moves.every((m) => m.at instanceof Date)).toBe(true)
    expect(moves.skipped).toBe(0)
  })

  it('reads only this org’s rows', async () => {
    const [theirCompany] = await db
      .insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.test' })
      .returning({ id: schema.companies.id })
    const theirs = await advanceDeal(db, { orgId: otherOrgId, companyId: theirCompany!.id, to: 'contacted' })
    await boardMove(otherOrgId, theirs.deal.id, 'contacted', 'meeting')
    const mine = await advanceDeal(db, { orgId, companyId, to: 'new' })

    const moves = await analyticsTransitions(db, orgId)
    expect(moves.map((m) => m.dealId)).toEqual([mine.deal.id])
    expect(moves.skipped).toBe(0)
  })

  /**
   * jsonb that nothing validates on the way in. A shape that is not a move
   * is skipped and COUNTED, so the page can say how many it could not read.
   */
  it('skips a malformed detail and counts it', async () => {
    const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    const bad = (action: string, detail: unknown, subjectId: string | null = deal.id) =>
      appendAudit(db, {
        orgId, actor: 'user-1', action, subjectType: 'deal', subjectId,
        detail: detail as Record<string, unknown>,
      })
    await bad('deal.moved', { from: 'contacted', to: 'negotiating' }) // not a stage
    await bad('deal.moved', { from: 'contacted', to: 7 }) // not a string
    await bad('deal.moved', { to: 'replied' }) // a person's move always names where it left
    await bad('deal.moved', { from: 'toString', to: 'replied' }) // not an own stage
    await bad('deal.advanced', { from: 3, to: 'replied' })
    await bad('deal.moved', ['contacted', 'replied']) // not an object
    await bad('deal.moved', { from: 'contacted', to: 'replied' }, null) // no deal named

    const moves = await analyticsTransitions(db, orgId)
    expect(moves.map((m) => m.to)).toEqual(['contacted'])
    expect(moves.skipped).toBe(7)
  })

  /**
   * `POST /api/deals` writes `deal.created` beside the row advanceDeal wrote
   * for the same move, shaped `{ companyId, stage }`. That is one move said
   * twice: not read, and not counted as unreadable either.
   */
  it('ignores the company page’s companion row rather than counting it twice or as broken', async () => {
    const created = await advanceDeal(db, { orgId, companyId, to: 'new' })
    await appendAudit(db, {
      orgId, actor: 'user-1', action: `deal.${created.outcome}`, subjectType: 'deal', subjectId: created.deal.id,
      detail: { companyId, stage: created.deal.stage },
    })
    // A stage edit that did not move the deal, and a detail-only update.
    await appendAudit(db, {
      orgId, actor: 'user-1', action: 'deal.updated', subjectType: 'deal', subjectId: created.deal.id,
      detail: { companyId, from: 'new', to: 'new', nextAction: 'call them' },
    })
    const moves = await analyticsTransitions(db, orgId)
    expect(moves).toHaveLength(1)
    expect(moves.skipped).toBe(0)
  })

  it('bounds the window by sinceDays, and refuses a window that is not one', async () => {
    const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    await test.pg.query(
      `INSERT INTO audit_log (org_id, actor, action, subject_type, subject_id, detail, created_at)
       VALUES ($1, 'user-1', 'deal.moved', 'deal', $2, $3, now() - interval '40 days')`,
      [orgId, deal.id, JSON.stringify({ companyId, from: 'new', to: 'contacted' })],
    )
    expect(await analyticsTransitions(db, orgId)).toHaveLength(2)
    expect(await analyticsTransitions(db, orgId, { sinceDays: 30 })).toHaveLength(1)
    await expect(analyticsTransitions(db, orgId, { sinceDays: 0 })).rejects.toThrow(RangeError)
    await expect(analyticsTransitions(db, orgId, { sinceDays: 1.5 })).rejects.toThrow(RangeError)
  })

  /** The two halves together, the way the page and the agent's tool use them. */
  it('feeds pipelineMetrics straight from listDeals', async () => {
    const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    await advanceDeal(db, { orgId, companyId, to: 'replied' })
    await boardMove(orgId, deal.id, 'replied', 'meeting')

    const m = pipelineMetrics(await listDeals(db, orgId), await analyticsTransitions(db, orgId), new Date(), { minSample: 1 })
    expect(m.conversion.find((c) => c.from === 'contacted')).toMatchObject({ entered: 1, advanced: 1, rate: 1 })
    expect(m.conversion.find((c) => c.from === 'meeting')).toMatchObject({ entered: 1, advanced: 0 })
    expect(m.medianDaysInStage.find((s) => s.stage === 'contacted')!.sample).toBe(1)
    expect(m.perStage.find((s) => s.stage === 'meeting')).toEqual({ stage: 'meeting', open: 1, total: 1 })
  })
})
