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
  DEAL_STAGES, advanceDeal, dealsDue, dealsSetNextActionAt, listDeals, listDealsForBoard, openDealFor,
  schema, setDealOwner, setDealStage, type AgencyDb,
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
  /**
   * The pipeline's history is the audit log. A person's move writes
   * `deal.moved` from the route; the moves nobody made by hand — a send, a
   * reply, a booking, a proposal — are `advanceDeal`'s, so it writes its own
   * row naming the stage it LEFT. Before it did, /pipeline/analytics could not
   * count a conversion it never saw.
   */
  describe('the audit row every automatic move writes', () => {
    const moves = async () =>
      (await db.select().from(schema.auditLog))
        .filter((a) => a.action === 'deal.created' || a.action === 'deal.advanced')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

    it('records a creation from nothing and an advance from the stage it left', async () => {
      const created = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      await advanceDeal(db, { orgId, companyId, to: 'replied' })
      const rows = await moves()
      expect(rows.map((r) => [r.action, r.actor, r.subjectType, r.subjectId, r.detail])).toEqual([
        ['deal.created', 'system', 'deal', created.deal.id, { companyId, from: null, to: 'contacted' }],
        ['deal.advanced', 'system', 'deal', created.deal.id, { companyId, from: 'contacted', to: 'replied' }],
      ])
    })

    it('writes nothing when nothing moved', async () => {
      await advanceDeal(db, { orgId, companyId, to: 'meeting' })
      await advanceDeal(db, { orgId, companyId, to: 'replied' })
      await advanceDeal(db, { orgId, companyId, to: 'meeting' })
      expect((await moves()).map((r) => r.action)).toEqual(['deal.created'])
    })

    it('names the actor a caller gives it', async () => {
      await advanceDeal(db, { orgId, companyId, to: 'new', actor: 'agent' })
      expect((await moves())[0]!.actor).toBe('agent')
    })

    /** The race's loser re-reads and advances; one creation, not two. */
    it('records one creation when two callers race', async () => {
      await Promise.all([
        advanceDeal(db, { orgId, companyId, to: 'contacted' }),
        advanceDeal(db, { orgId, companyId, to: 'replied' }),
      ])
      const rows = await moves()
      expect(rows.filter((r) => r.action === 'deal.created')).toHaveLength(1)
      expect(rows.at(-1)!.detail).toMatchObject({ to: 'replied' })
    })
  })

  /**
   * `deals.next_action_at` existed since 0003 and nothing wrote it. A column
   * nobody can set teaches a shape the product does not have.
   */
  describe('dealsSetNextActionAt', () => {
    const due = new Date('2026-10-02T23:59:59.999Z')

    it('sets the date and audits where it came from and where it went', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      const set = await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: due, actor: 'user-1' })
      expect(set.ok && set.deal.nextActionAt?.toISOString()).toBe(due.toISOString())
      expect(set.ok && set.from).toBeNull()

      const later = new Date('2026-10-09T23:59:59.999Z')
      const moved = await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: later, actor: 'user-1' })
      expect(moved.ok && moved.from?.toISOString()).toBe(due.toISOString())

      const audit = (await db.select().from(schema.auditLog))
        .filter((a) => a.action === 'deal.next_action_set')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      expect(audit.map((a) => [a.actor, a.subjectId, a.detail])).toEqual([
        ['user-1', deal.id, { companyId, from: null, to: due.toISOString() }],
        ['user-1', deal.id, { companyId, from: due.toISOString(), to: later.toISOString() }],
      ])
    })

    it('clears the date with null, and audits the clearing', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: due, actor: 'user-1' })
      const cleared = await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: null, actor: 'user-1' })
      expect(cleared.ok && cleared.deal.nextActionAt).toBeNull()
      const [row] = await db.select().from(schema.deals).where(eq(schema.deals.id, deal.id))
      expect(row!.nextActionAt).toBeNull()
      const last = (await db.select().from(schema.auditLog))
        .filter((a) => a.action === 'deal.next_action_set')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .at(-1)
      expect(last!.detail).toEqual({ companyId, from: due.toISOString(), to: null })
    })

    /** It is a change to the deal, so it is what "untouched" measures from. */
    it('touches the deal', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: due, actor: 'user-1' })
      const [row] = await db.select().from(schema.deals).where(eq(schema.deals.id, deal.id))
      expect(row!.updatedAt).not.toBeNull()
    })

    it('refuses a date on a closed deal, but lets it be cleared', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'proposal' })
      await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: due, actor: 'user-1' })
      await setDealStage(db, { orgId, dealId: deal.id, stage: 'won' })
      const refused = await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: due, actor: 'user-1' })
      expect(refused).toMatchObject({ ok: false, reason: 'closed' })
      const cleared = await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: null, actor: 'user-1' })
      expect(cleared.ok).toBe(true)
    })

    it('will not touch another org’s deal, and writes no audit row for it', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const r = await dealsSetNextActionAt(db, { orgId: other!.id, dealId: deal.id, at: due, actor: 'user-2' })
      expect(r).toMatchObject({ ok: false, reason: 'not_found' })
      const [row] = await db.select().from(schema.deals).where(eq(schema.deals.id, deal.id))
      expect(row!.nextActionAt).toBeNull()
      expect((await db.select().from(schema.auditLog)).filter((a) => a.action === 'deal.next_action_set')).toEqual([])
    })

    it('refuses a date that is not one', async () => {
      const { deal } = await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      const r = await dealsSetNextActionAt(db, { orgId, dealId: deal.id, at: new Date('nope'), actor: 'user-1' })
      expect(r).toMatchObject({ ok: false, reason: 'invalid_date' })
    })
  })

  describe('dealsDue', () => {
    const now = new Date('2026-09-30T12:00:00.000Z')
    const hours = (n: number): Date => new Date(now.getTime() + n * 3_600_000)
    const company = async (org: string, domain: string): Promise<string> => {
      const [c] = await db.insert(schema.companies).values({ orgId: org, domain }).returning({ id: schema.companies.id })
      return c!.id
    }
    const dealAt = async (org: string, domain: string, at: Date | null): Promise<string> => {
      const { deal } = await advanceDeal(db, { orgId: org, companyId: await company(org, domain), to: 'contacted' })
      if (at) await dealsSetNextActionAt(db, { orgId: org, dealId: deal.id, at, actor: 'user-1' })
      return deal.id
    }

    it('lists open deals due by the cutoff, most overdue first, with the company', async () => {
      const overdue = await dealAt(orgId, 'late.test', hours(-48))
      const today = await dealAt(orgId, 'today.test', hours(6))
      await dealAt(orgId, 'next-week.test', hours(24 * 7))
      await dealAt(orgId, 'no-date.test', null)
      const due = await dealsDue(db, orgId, hours(24))
      expect(due.map((d) => d.id)).toEqual([overdue, today])
      expect(due[0]!.companyDomain).toBe('late.test')
    })

    /** An outcome has no next step. */
    it('excludes closed deals, won and lost alike', async () => {
      const won = await dealAt(orgId, 'won.test', hours(-2))
      const lost = await dealAt(orgId, 'lost.test', hours(-2))
      const open = await dealAt(orgId, 'open.test', hours(-2))
      await setDealStage(db, { orgId, dealId: won, stage: 'won' })
      await setDealStage(db, { orgId, dealId: lost, stage: 'lost', lostReason: 'went quiet' })
      expect((await dealsDue(db, orgId, hours(24))).map((d) => d.id)).toEqual([open])
    })

    it('excludes another org’s deals', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      await dealAt(other!.id, 'theirs.test', hours(-2))
      const mine = await dealAt(orgId, 'mine.test', hours(-2))
      expect((await dealsDue(db, orgId, hours(24))).map((d) => d.id)).toEqual([mine])
    })
  })
})