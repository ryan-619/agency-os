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
import { eq } from 'drizzle-orm'
import {
  DEAL_STAGES, advanceDeal, listDeals, listDealsForBoard, openDealFor, schema, setDealOwner,
  setDealStage, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('deals', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
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

  /**
   * A send and a reply landing together both find no deal and both insert.
   * `deals_one_open_per_company` (0012) makes one of them lose, and the loser
   * re-reads and advances instead. One open deal, at the further stage.
   */
  it('creates one open deal when two callers race, at the further stage', async () => {
    const [a, b] = await Promise.all([
      advanceDeal(db, { orgId, companyId, to: 'contacted' }),
      advanceDeal(db, { orgId, companyId, to: 'replied' }),
    ])
    expect(a.deal.id).toBe(b.deal.id)
    const open = await db.select().from(schema.deals)
    expect(open).toHaveLength(1)
    expect(open[0]!.stage).toBe('replied')
  })

  it('refuses a second open deal for a company at the database', async () => {
    await advanceDeal(db, { orgId, companyId, to: 'contacted' })
    await expect(db.insert(schema.deals).values({ orgId, companyId, stage: 'new' })).rejects.toThrow()
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

  /**
   * `deals.owner_user_id` existed since 0003 and nothing wrote it — the
   * column was added and then left, because a two-person agency closes deals
   * by talking to each other. At three or four that stops being true.
   */
  describe('ownership', () => {
    const member = async (orgFor: string, email: string): Promise<string> => {
      const [u] = await db
        .insert(schema.users)
        .values({ orgId: orgFor, email, role: 'member' })
        .returning({ id: schema.users.id })
      return u!.id
    }

    it('assigns a deal to somebody on the team, and unassigns again', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      const priya = await member(orgId, 'priya@agency.test')

      const assigned = await setDealOwner(db, { orgId, dealId: deal.id, ownerUserId: priya })
      expect(assigned.ok && assigned.deal.ownerUserId).toBe(priya)

      // Null is a real state — a deal nobody has taken — not a missing one.
      const cleared = await setDealOwner(db, { orgId, dealId: deal.id, ownerUserId: null })
      expect(cleared.ok && cleared.deal.ownerUserId).toBeNull()
    })

    /**
     * THE check, and the reason it lives in the query rather than the route.
     * `owner_user_id` is a plain FK to a GLOBAL users table: nothing in the
     * schema says the assignee belongs to the same agency as the deal, so a
     * guessed uuid from another org is a perfectly storable row — and that
     * row puts a stranger's name on a customer's pipeline.
     */
    it('refuses somebody from another agency, and writes nothing', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      const [other] = await db
        .insert(schema.orgs).values({ name: 'Somebody Else' }).returning({ id: schema.orgs.id })
      const stranger = await member(other!.id, 'stranger@elsewhere.test')

      const result = await setDealOwner(db, { orgId, dealId: deal.id, ownerUserId: stranger })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/not on this team/i)

      const [after] = await db.select().from(schema.deals).where(eq(schema.deals.id, deal.id))
      expect(after!.ownerUserId).toBeNull()
    })

    it('refuses a deal that belongs to another agency', async () => {
      const [other] = await db
        .insert(schema.orgs).values({ name: 'Somebody Else' }).returning({ id: schema.orgs.id })
      const [theirCompany] = await db
        .insert(schema.companies).values({ orgId: other!.id, domain: 'theirs.test' })
        .returning({ id: schema.companies.id })
      const { deal: theirDeal } = await advanceDeal(db, {
        orgId: other!.id, companyId: theirCompany!.id, to: 'contacted',
      })
      const mine = await member(orgId, 'me@agency.test')

      const result = await setDealOwner(db, { orgId, dealId: theirDeal.id, ownerUserId: mine })
      expect(result.ok).toBe(false)
    })

    /**
     * LEFT joined, not inner. An unowned deal is the common case on a fresh
     * board, and an inner join would hide every one of them.
     */
    it('shows the owner on the board, and still shows unowned deals', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      let board = await listDealsForBoard(db, orgId)
      expect(board).toHaveLength(1)
      expect(board[0]!.ownerEmail).toBeNull()

      const priya = await member(orgId, 'priya@agency.test')
      await setDealOwner(db, { orgId, dealId: deal.id, ownerUserId: priya })
      board = await listDealsForBoard(db, orgId)
      expect(board[0]!.ownerEmail).toBe('priya@agency.test')
    })
  })
})