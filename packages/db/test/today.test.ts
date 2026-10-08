/**
 * Today's top actions (2026-10-08), against a real migrated database: a call
 * raised by a business reading its link comes first, then replies, quotes
 * about to lapse and quotes nobody answered, then drafts and other tasks —
 * and never a teammate's task, a finished one, or one not yet due.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { TODAY_ACTIONS_MAX, schema, todayActions, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const H = 3_600_000
const D = 24 * H

describe('today’s top actions', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let me: string
  let teammate: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ;[me, teammate] = (
      await db.insert(schema.users).values([
        { orgId, email: 'me@accemy.test', role: 'owner' },
        { orgId, email: 'them@accemy.test', role: 'member' },
      ]).returning({ id: schema.users.id })
    ).map((r) => r.id) as [string, string]
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental' }).returning({ id: schema.companies.id }))[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const task = (over: Partial<typeof schema.tasks.$inferInsert>) =>
    db.insert(schema.tasks).values({ orgId, companyId, kind: 'todo', title: 'A task', dueAt: NOW, ...over })
  const quote = (over: Partial<typeof schema.quotes.$inferInsert>) =>
    db.insert(schema.quotes).values({
      orgId, companyId, number: 'Q-2026-0099', title: 'Website', status: 'sent',
      items: [{ serviceId: null, name: 'Website', description: null, quantity: 1, unit: 'one_off', unitPrice: 20_000 }],
      subtotal: 20_000, total: 20_000, sentAt: new Date(NOW.getTime() - 4 * D), validUntil: '2026-10-20',
      seller: { name: 'Accemy' }, ...over,
    })

  it('is nothing on a quiet day', async () => {
    expect(await todayActions(db, { orgId, userId: me, now: NOW })).toEqual([])
  })

  it('puts the freshest call first, then replies, lapsing quotes, unanswered quotes, drafts and other tasks', async () => {
    await task({ kind: 'todo', title: 'Send the brochure', assigneeUserId: me, dueAt: new Date(NOW.getTime() - H) })
    await task({ kind: 'call', title: 'Call Kumar Dental — your audit page link was just opened', assigneeUserId: me, dueAt: new Date(NOW.getTime() - 60_000) })
    await task({ kind: 'call', title: 'Call an old lead', assigneeUserId: null, dueAt: new Date(NOW.getTime() - 3 * D) })
    await db.insert(schema.touches).values({ orgId, companyId, channel: 'email', direction: 'in', status: 'replied', body: 'Yes, call me' })
    await db.insert(schema.touches).values({ orgId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval', subject: 'Hi', body: 'Hello' })
    await quote({ number: 'Q-2026-0001', validUntil: '2026-10-09' })
    await quote({ number: 'Q-2026-0002', validUntil: '2026-10-20' })
    await quote({ number: 'Q-2026-0003', validUntil: '2026-10-20', sentAt: new Date(NOW.getTime() - D) })

    const actions = await todayActions(db, { orgId, userId: me, now: NOW })
    expect(actions.map((a) => [a.kind, a.title])).toEqual([
      ['call', 'Call Kumar Dental — your audit page link was just opened'],
      ['call', 'Call an old lead'],
      ['replies', 'Answer the reply waiting in the inbox'],
      ['quote_lapsing', 'Q-2026-0001 for Kumar Dental lapses tomorrow'],
      ['quote_follow_up', 'Follow up on Q-2026-0002 for Kumar Dental — sent 4 days ago, no answer yet'],
      ['drafts', 'Approve or deny the draft waiting'],
      ['task', 'Send the brochure'],
    ])
    expect(actions.find((a) => a.kind === 'quote_lapsing')!.href).toMatch(/^\/quotes\/[0-9a-f-]{36}$/)
  })

  it('leaves out a teammate’s task, a finished one, one not due today, and a lapsed or answered quote', async () => {
    await task({ kind: 'call', title: 'Their call', assigneeUserId: teammate })
    await task({ kind: 'call', title: 'Done already', assigneeUserId: me, doneAt: NOW, doneBy: me })
    await task({ kind: 'visit', title: 'Next week', assigneeUserId: me, dueAt: new Date(NOW.getTime() + 7 * D) })
    await task({ kind: 'todo', title: 'Undated', assigneeUserId: me, dueAt: null })
    await quote({ number: 'Q-2026-0004', validUntil: '2026-10-07' })
    await quote({ number: 'Q-2026-0005', status: 'accepted', acceptedAt: NOW, validUntil: '2026-10-20' })
    expect(await todayActions(db, { orgId, userId: me, now: NOW })).toEqual([])
  })

  it('stops at its limit', async () => {
    for (let i = 0; i < TODAY_ACTIONS_MAX + 3; i++) await task({ kind: 'call', title: `Call ${i}`, assigneeUserId: me })
    expect(await todayActions(db, { orgId, userId: me, now: NOW })).toHaveLength(TODAY_ACTIONS_MAX)
  })
})
