/**
 * /settings/spend's three reads, summed by Postgres.
 *
 * `cost_usd` is `numeric`, which drizzle hands to JavaScript as a STRING, so
 * the failure these tests exist for is not a wrong number but a string that
 * LOOKS like one: "0.01" + "0.02" is "0.010.02". Every figure asserted here
 * is the database's arithmetic, compared as the text it returns.
 *
 * The other boundaries: another org's spend is never in this org's figures,
 * a message outside the window is not in the window, and an org that has
 * spent nothing gets zeros rather than nulls or a missing row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import {
  SPEND_WINDOW_DAYS, schema, spendByDay, spendByPerson, spendRunRate, spendTotal, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const DAY = 86_400_000

describe('spend', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let ownerId: string
  let memberId: string
  let ownerThread: string
  let memberThread: string
  let rivalThread: string

  /** One priced message, `daysAgo` days before the database's now(). */
  async function cost(sessionId: string, org: string, usd: string | null, daysAgo = 0) {
    await db.insert(schema.chatMessages).values({
      orgId: org,
      sessionId,
      role: 'assistant',
      costUsd: usd,
      createdAt: new Date(Date.now() - daysAgo * DAY),
    })
  }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'owner@agency.test', role: 'owner' },
        { orgId, email: 'member@agency.test', role: 'member' },
        { orgId: otherOrgId, email: 'owner@rival.test', role: 'owner' },
      ])
      .returning({ id: schema.users.id, email: schema.users.email })
    ownerId = users.find((u) => u.email === 'owner@agency.test')!.id
    memberId = users.find((u) => u.email === 'member@agency.test')!.id
    const rivalId = users.find((u) => u.email === 'owner@rival.test')!.id
    const threads = await db
      .insert(schema.chatSessions)
      .values([
        { orgId, userId: ownerId, title: 'owner' },
        { orgId, userId: memberId, title: 'member' },
        { orgId: otherOrgId, userId: rivalId, title: 'rival' },
      ])
      .returning({ id: schema.chatSessions.id, title: schema.chatSessions.title })
    ownerThread = threads.find((t) => t.title === 'owner')!.id
    memberThread = threads.find((t) => t.title === 'member')!.id
    rivalThread = threads.find((t) => t.title === 'rival')!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  describe('an org that has spent nothing', () => {
    it('gets zeros, not nulls, and empty tables', async () => {
      expect(await spendRunRate(db, orgId)).toEqual({
        last7Usd: '0.000000', perDayUsd: '0.000000', projectedMonthUsd: '0.000000',
      })
      expect(await spendTotal(db, orgId)).toEqual({ usd: '0.000000', turns: 0 })
      expect(await spendByDay(db, orgId)).toEqual([])
      expect(await spendByPerson(db, orgId)).toEqual([])
    })
  })

  describe('spendTotal', () => {
    it('sums as numbers, never as concatenated strings', async () => {
      await cost(ownerThread, orgId, '0.01')
      await cost(ownerThread, orgId, '0.02')
      const total = await spendTotal(db, orgId)
      expect(total.usd).toBe('0.030000')
      expect(total.usd).not.toContain('0.010.02')
      expect(total.turns).toBe(2)
    })

    it("excludes another org's spend", async () => {
      await cost(ownerThread, orgId, '0.5')
      await cost(rivalThread, otherOrgId, '9.25')
      expect((await spendTotal(db, orgId)).usd).toBe('0.500000')
      expect((await spendTotal(db, otherOrgId)).usd).toBe('9.250000')
    })

    /** tools/spend.sh's definition: a row with a positive cost is a turn. */
    it('counts only priced rows as turns', async () => {
      await cost(ownerThread, orgId, null)
      await cost(ownerThread, orgId, '0')
      await cost(ownerThread, orgId, '0.1')
      expect(await spendTotal(db, orgId)).toEqual({ usd: '0.100000', turns: 1 })
    })
  })

  describe('spendByDay', () => {
    it('buckets by UTC day, newest first, as numeric text', async () => {
      await cost(ownerThread, orgId, '0.01')
      await cost(memberThread, orgId, '0.02')
      await cost(ownerThread, orgId, '1.5', 2)
      const days = await spendByDay(db, orgId)
      expect(days).toHaveLength(2)
      const today = new Date().toISOString().slice(0, 10)
      expect(days[0]).toEqual({ day: today, usd: '0.030000', turns: 2 })
      expect(days[1]!.usd).toBe('1.500000')
      expect(days[1]!.day < days[0]!.day).toBe(true)
    })

    it('leaves out anything older than the window', async () => {
      await cost(ownerThread, orgId, '0.25', 1)
      await cost(ownerThread, orgId, '7', SPEND_WINDOW_DAYS + 3)
      const days = await spendByDay(db, orgId)
      expect(days.map((d) => d.usd)).toEqual(['0.250000'])
      // A wider window reaches it.
      expect((await spendByDay(db, orgId, SPEND_WINDOW_DAYS + 10)).map((d) => d.usd)).toContain('7.000000')
    })

    it("excludes another org's spend", async () => {
      await cost(rivalThread, otherOrgId, '3')
      expect(await spendByDay(db, orgId)).toEqual([])
    })

    it('clamps a nonsense window rather than letting it mean something else', async () => {
      await cost(ownerThread, orgId, '0.25', 1)
      // NaN is the default thirty days; a negative window is one day (today),
      // never an inverted range that reaches into the future or the past.
      expect(await spendByDay(db, orgId, Number.NaN)).toHaveLength(1)
      expect(await spendByDay(db, orgId, -5)).toHaveLength(0)
    })
  })

  describe('spendByPerson', () => {
    it('attributes spend through the thread, highest first by the numeric sum', async () => {
      // As text '9.5' sorts above '10.25'; as numbers it does not.
      await cost(ownerThread, orgId, '9.5')
      await cost(memberThread, orgId, '10')
      await cost(memberThread, orgId, '0.25')
      const people = await spendByPerson(db, orgId)
      expect(people.map((p) => [p.email, p.usd, p.turns])).toEqual([
        ['member@agency.test', '10.250000', 2],
        ['owner@agency.test', '9.500000', 1],
      ])
      expect(people[0]!.userId).toBe(memberId)
      expect(people[0]!.revoked).toBe(false)
    })

    it("never lists another org's people or their spend", async () => {
      await cost(ownerThread, orgId, '1')
      await cost(rivalThread, otherOrgId, '100')
      const people = await spendByPerson(db, orgId)
      expect(people.map((p) => p.email)).toEqual(['owner@agency.test'])
    })

    it('keeps a revoked person, marked, because the spend is still theirs', async () => {
      await cost(memberThread, orgId, '0.4')
      await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, memberId))
      const [p] = await spendByPerson(db, orgId)
      expect(p).toMatchObject({ email: 'member@agency.test', revoked: true, usd: '0.400000' })
    })

    it('leaves out spend older than the window', async () => {
      await cost(ownerThread, orgId, '5', SPEND_WINDOW_DAYS + 2)
      expect(await spendByPerson(db, orgId)).toEqual([])
    })
  })

  describe('spendRunRate', () => {
    it('is the last seven days, divided and projected by the database', async () => {
      await cost(ownerThread, orgId, '0.7', 1)
      await cost(memberThread, orgId, '0.7', 6)
      // Outside the seven days, inside the thirty.
      await cost(ownerThread, orgId, '50', 9)
      await cost(rivalThread, otherOrgId, '70', 1)
      expect(await spendRunRate(db, orgId)).toEqual({
        last7Usd: '1.400000',
        perDayUsd: '0.200000',
        projectedMonthUsd: '6.090000',
      })
    })
  })
})
