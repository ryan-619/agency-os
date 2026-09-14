/**
 * Deals: one row per company saying where the conversation is.
 *
 * Phase 4 needs `advanceDeal` for §8.4's "flips the deal to `replied`", and
 * the property that matters is that it only ever moves FORWARD: a reply that
 * arrives after a meeting was booked must not knock the deal back. Phase 5's
 * board moves deals in either direction, through `setDealStage`, because a
 * person said so.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  DEAL_STAGES, advanceDeal, listDeals, openDealFor, schema, setDealStage, type AgencyDb,
} from '../src/index.js'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'

describe('deals', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /**
   * An imported company has no deal until something happens to it. A deal in
   * `new` for every row would make the pipeline a copy of the CRM.
   */
  it('has no deal for a company nobody has done anything about', async () => {
    expect(await openDealFor(db, orgId, companyId)).toBeNull()
  })

  it('creates the deal the first time something happens', async () => {
    const r = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    expect(r.outcome).toBe('created')
    expect(r.deal.stage).toBe('contacted')
  })

  it('advances a deal forward', async () => {
    await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    const r = await advanceDeal(db, { orgId, companyId, to: 'replied', nextAction: 'answer them' })
    expect(r.outcome).toBe('advanced')
    expect(r.deal.stage).toBe('replied')
    expect(r.deal.nextAction).toBe('answer them')
  })

  /**
   * THE property. A reply arriving after the meeting was booked is still
   * recorded as a touch; the deal stays at `meeting`, because that is the
   * truer statement of where things are.
   */
  it('never moves a deal backwards', async () => {
    await advanceDeal(db, { orgId, companyId, to: 'meeting' })
    const r = await advanceDeal(db, { orgId, companyId, to: 'replied' })
    expect(r.outcome).toBe('unchanged')
    expect(r.deal.stage).toBe('meeting')
  })

  it('leaves the same stage unchanged rather than rewriting it', async () => {
    await advanceDeal(db, { orgId, companyId, to: 'replied', nextAction: 'first' })
    const r = await advanceDeal(db, { orgId, companyId, to: 'replied', nextAction: 'second' })
    expect(r.outcome).toBe('unchanged')
    expect(r.deal.nextAction).toBe('first')
  })

  it('opens a NEW deal for a company whose last deal was closed', async () => {
    const first = await advanceDeal(db, { orgId, companyId, to: 'proposal' })
    await setDealStage(db, { orgId, dealId: first.deal.id, stage: 'lost', lostReason: 'no budget' })
    const again = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    expect(again.outcome).toBe('created')
    expect(again.deal.id).not.toBe(first.deal.id)
    expect((await listDeals(db, orgId)).length).toBe(2)
  })

  describe('setDealStage', () => {
    it('moves in either direction when a person says so', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'meeting' })
      const back = await setDealStage(db, { orgId, dealId: deal.id, stage: 'replied' })
      expect(back!.stage).toBe('replied')
    })

    it('closes a won deal', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'proposal' })
      const won = await setDealStage(db, { orgId, dealId: deal.id, stage: 'won' })
      expect(won!.closedAt).not.toBeNull()
      expect(await openDealFor(db, orgId, companyId)).toBeNull()
    })

    /** The only thing anyone learns from a lost deal. */
    it('refuses to lose a deal without a reason', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'proposal' })
      await expect(setDealStage(db, { orgId, dealId: deal.id, stage: 'lost' })).rejects.toThrow(/reason/)
      await expect(
        setDealStage(db, { orgId, dealId: deal.id, stage: 'lost', lostReason: '  ' }),
      ).rejects.toThrow(/reason/)
    })

    it('reopens a closed deal if a person moves it back to an open stage', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'proposal' })
      await setDealStage(db, { orgId, dealId: deal.id, stage: 'lost', lostReason: 'timing' })
      const reopened = await setDealStage(db, { orgId, dealId: deal.id, stage: 'proposal' })
      expect(reopened!.closedAt).toBeNull()
      expect(reopened!.lostReason).toBeNull()
    })

    it('will not touch another org’s deal', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await setDealStage(db, { orgId: other!.id, dealId: deal.id, stage: 'replied' })).toBeNull()
    })
  })

  it('lists the stages in pipeline order', () => {
    expect(DEAL_STAGES).toEqual(['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'])
  })
})
