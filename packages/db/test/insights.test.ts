/**
 * What's working (2026-10-08), against a real migrated database: who replied
 * by kind of business, city and campaign, after which message, and what
 * links and quotes became — from what was recorded, nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { INSIGHTS_MIN, lookalikeSearches, nightSearchAdd, rateWords, schema, whatsWorking, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

describe('what’s working', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let campaignId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'o@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    campaignId = (await db.insert(schema.campaigns).values({ orgId, name: 'Clinics', channel: 'email', status: 'active' }).returning({ id: schema.campaigns.id }))[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const person = async (domain: string, category: string, city: string) => {
    const [co] = await db.insert(schema.companies).values({ orgId, domain, name: domain, googleCategory: category, city }).returning({ id: schema.companies.id })
    const [ct] = await db.insert(schema.contacts).values({ orgId, companyId: co!.id, email: `hi@${domain}` }).returning({ id: schema.contacts.id })
    return { companyId: co!.id, contactId: ct!.id }
  }
  const sent = (p: { companyId: string; contactId: string }, at: Date) =>
    db.insert(schema.touches).values({
      orgId, campaignId, contactId: p.contactId, companyId: p.companyId, channel: 'email', direction: 'out', status: 'sent',
      subject: 'Hi', body: 'Hello', recipient: 'x@y.in', sentAt: at, approvedBy: userId, approvedAt: at,
    })
  const reply = (p: { companyId: string; contactId: string }, at: Date, replyKind: string) =>
    db.insert(schema.touches).values({ orgId, contactId: p.contactId, companyId: p.companyId, channel: 'email', direction: 'in', status: 'replied', body: 'x', replyKind, createdAt: at })

  it('counts each person once, by what came of their first message, and which message drew the reply', async () => {
    const d1 = await person('smile.in', 'dentist', 'bengaluru ')
    const d2 = await person('bright.in', 'dentist', 'Bengaluru')
    const b1 = await person('cakes.in', 'bakery', 'Pune')
    await sent(d1, ago(20))
    await sent(d1, ago(15))
    await reply(d1, ago(14), 'interested')
    await db.insert(schema.deals).values({ orgId, companyId: d1.companyId, stage: 'won', closedAt: ago(2) })
    await sent(d2, ago(10))
    await reply(d2, ago(9), 'auto_reply')
    await sent(b1, ago(5))
    await reply(b1, ago(4), 'opted_out')
    // Outside the window: not counted.
    const old = await person('old.in', 'dentist', 'Bengaluru')
    await sent(old, ago(200))

    const w = await whatsWorking(db, { orgId, now: NOW })
    expect(w.byKind).toEqual([
      { key: 'dentist', written: 2, replied: 1, interested: 1, optedOut: 0, won: 1 },
      { key: 'bakery', written: 1, replied: 1, interested: 0, optedOut: 1, won: 0 },
    ])
    expect(w.byCity.map((r) => [r.key, r.written])).toEqual([['Bengaluru', 2], ['Pune', 1]])
    expect(w.byCampaign).toEqual([
      expect.objectContaining({ name: 'Clinics', written: 3, replied: 2, interested: 1, optedOut: 1, won: 1, afterMessage: [{ n: 1, replied: 1 }, { n: 2, replied: 1 }] }),
    ])
  })

  it('counts links made and opened, and what quotes became', async () => {
    const d1 = await person('smile.in', 'dentist', 'Bengaluru')
    await db.insert(schema.shareLinks).values([
      { orgId, kind: 'report', companyId: d1.companyId, tokenHash: 'a'.repeat(64), expiresAt: new Date(NOW.getTime() + 10 * DAY), viewCount: 2, firstViewedAt: ago(1), lastViewedAt: ago(1) },
      { orgId, kind: 'report', companyId: d1.companyId, tokenHash: 'b'.repeat(64), expiresAt: new Date(NOW.getTime() + 10 * DAY) },
    ])
    const w = await whatsWorking(db, { orgId, now: NOW })
    expect(w.pages).toEqual([{ kind: 'report', made: 2, opened: 1 }])
    expect(w.quotes).toEqual({ sent: 0, accepted: 0, declined: 0, acceptedValue: 0 })
  })

  it('suggests searches for more of what was won, most wins first, never one already saved', async () => {
    expect(await lookalikeSearches(db, orgId)).toEqual([])
    for (const [domain, category, city] of [['a.in', 'dentist', 'bengaluru'], ['b.in', 'dentist', 'Bengaluru'], ['c.in', 'beauty_salon', 'Pune']] as const) {
      const p = await person(domain, category, city)
      await db.insert(schema.deals).values({ orgId, companyId: p.companyId, stage: 'won', closedAt: ago(1) })
    }
    expect(await lookalikeSearches(db, orgId)).toEqual([
      { query: 'dentist in Bengaluru', city: 'Bengaluru', won: 2 },
      { query: 'beauty salon in Pune', city: 'Pune', won: 1 },
    ])
    await nightSearchAdd(db, { orgId, query: 'Dentist in Bengaluru', region: null, city: null, createdBy: userId, actor: userId })
    expect((await lookalikeSearches(db, orgId)).map((r) => r.query)).toEqual(['beauty salon in Pune'])
  })

  it('says a rate over too few people is too few to tell', () => {
    expect(INSIGHTS_MIN).toBe(5)
    expect(rateWords(1, 4)).toBe('too few to tell (1 of 4)')
    expect(rateWords(9, 50)).toBe('18% (9 of 50)')
  })
})
