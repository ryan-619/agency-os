/**
 * The facts deal health reads (2026-10-09), gathered for a board: replies
 * nobody handled and drafts waiting, the last message sent, the newest sent
 * quote, the next meeting not cancelled — per company, in this org only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { migratedDb, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import type { AgencyDb } from '../src/repository.js'
import { dealHealthFacts } from '../src/deal-health.js'

const NOW = new Date('2026-10-09T12:00:00.000Z')
const DAY = 86_400_000

describe('dealHealthFacts', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let a: string
  let b: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'o@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    a = (await db.insert(schema.companies).values({ orgId, domain: 'a.in', name: 'A' }).returning({ id: schema.companies.id }))[0]!.id
    b = (await db.insert(schema.companies).values({ orgId, domain: 'b.in', name: 'B' }).returning({ id: schema.companies.id }))[0]!.id
  }, 30_000)
  afterEach(async () => {
    await test.close()
  })

  const quote = (over: Partial<typeof schema.quotes.$inferInsert>) =>
    db.insert(schema.quotes).values({
      orgId, companyId: a, number: 'Q-2026-0099', title: 'Website', status: 'sent',
      items: [{ serviceId: null, name: 'Website', description: null, quantity: 1, unit: 'one_off', unitPrice: 20_000 }],
      subtotal: 20_000, total: 20_000, sentAt: new Date(NOW.getTime() - 4 * DAY), validUntil: '2026-10-20',
      seller: { name: 'Accemy' }, ...over,
    })

  it('counts and dates per company, and reads nothing for a company with nothing', async () => {
    const sentAt = new Date(NOW.getTime() - 2 * DAY)
    await db.insert(schema.touches).values([
      { orgId, companyId: a, channel: 'email', direction: 'out', status: 'sent', body: 'hi', recipient: 'x@a.in', sentAt: new Date(NOW.getTime() - 9 * DAY) },
      { orgId, companyId: a, channel: 'email', direction: 'out', status: 'sent', body: 'hi again', recipient: 'x@a.in', sentAt },
      { orgId, companyId: a, channel: 'email', direction: 'in', status: 'replied', body: 'tell me more', recipient: 'x@a.in' },
      { orgId, companyId: a, channel: 'email', direction: 'in', status: 'replied', body: 'ok', recipient: 'x@a.in', handledAt: NOW, handledBy: ownerId },
      { orgId, companyId: a, channel: 'email', direction: 'out', status: 'awaiting_approval', body: 'draft', recipient: 'x@a.in' },
      { orgId, companyId: b, channel: 'email', direction: 'out', status: 'queued', body: 'queued', recipient: 'y@b.in' },
    ])
    // The newest SENT quote is the one read; a draft and an older sent one are not.
    await quote({ number: 'Q-2026-0001', validUntil: '2026-10-15', sentAt: new Date(NOW.getTime() - 8 * DAY) })
    await quote({ number: 'Q-2026-0002', validUntil: '2026-10-20' })
    await quote({ number: 'Q-2026-0003', status: 'draft', sentAt: null, seller: null, validUntil: '2026-10-30' })
    await db.insert(schema.meetings).values([
      { orgId, companyId: a, startsAt: new Date(NOW.getTime() - DAY), timeZone: 'Asia/Kolkata' },
      { orgId, companyId: a, startsAt: new Date(NOW.getTime() + 3 * DAY), timeZone: 'Asia/Kolkata', cancelledAt: NOW },
      { orgId, companyId: a, startsAt: new Date(NOW.getTime() + 5 * DAY), timeZone: 'Asia/Kolkata' },
    ])

    const facts = await dealHealthFacts(db, { orgId, companyIds: [a, b], now: NOW })
    expect(facts.get(a)).toEqual({
      unhandledReplies: 1,
      awaitingDrafts: 1,
      lastSentAt: sentAt,
      sentQuote: { sentAt: new Date(NOW.getTime() - 4 * DAY), validUntil: '2026-10-20' },
      nextMeetingAt: new Date(NOW.getTime() + 5 * DAY),
    })
    expect(facts.get(b)).toEqual({ unhandledReplies: 0, awaitingDrafts: 0, lastSentAt: null, sentQuote: null, nextMeetingAt: null })
    expect(await dealHealthFacts(db, { orgId, companyIds: [], now: NOW })).toEqual(new Map())
  })

  it('reads another org’s rows for nobody', async () => {
    const other = (await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id }))[0]!.id
    const c = (await db.insert(schema.companies).values({ orgId: other, domain: 'c.in', name: 'C' }).returning({ id: schema.companies.id }))[0]!.id
    await db.insert(schema.touches).values({ orgId: other, companyId: c, channel: 'email', direction: 'in', status: 'replied', body: 'hello', recipient: 'z@c.in' })
    const facts = await dealHealthFacts(db, { orgId, companyIds: [c], now: NOW })
    expect(facts.get(c)).toEqual({ unhandledReplies: 0, awaitingDrafts: 0, lastSentAt: null, sentQuote: null, nextMeetingAt: null })
  })
})
