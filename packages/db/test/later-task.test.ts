/**
 * A reply that asks to be contacted later becomes a task on that day
 * (2026-10-08), through the real `recordInboundReply` against a migrated
 * database — never for an opt-out, an auto-reply or words in the quoted
 * thread, and with our phrase in the title, never the sender's words.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { recordInboundReply, schema, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

// Thursday 8 October 2026, 14:30 in India.
const NOW = new Date('2026-10-08T09:00:00.000Z')

describe('a reply that asks to be contacted later', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let companyId: string
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({
      orgId, domain: 'kumardental.in', name: 'Kumar Dental', phone: '+918041234567', timeZone: 'Asia/Kolkata',
    }).returning({ id: schema.companies.id }))[0]!.id
    contactId = (await db.insert(schema.contacts).values({ orgId, companyId, email: 'ravi@kumardental.in', firstName: 'Ravi' }).returning({ id: schema.contacts.id }))[0]!.id
    await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted', ownerUserId: ownerId })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const reply = (body: string, over: { autoReply?: boolean } = {}) =>
    recordInboundReply(db, { orgId, contactId, channel: 'email', from: 'ravi@kumardental.in', subject: 'Re: hello', body, now: NOW, ...over })
  const tasks = () => db.select().from(schema.tasks).where(eq(schema.tasks.companyId, companyId))

  it('is a call on that day at 10:00 their time, for the deal’s owner, in our words', async () => {
    await reply('Thanks for the note. Very busy this week — please call me next month.')
    const [task] = await tasks()
    expect(task).toMatchObject({
      kind: 'call',
      title: 'Call Kumar Dental next month, as their reply said',
      assigneeUserId: ownerId,
      dueAt: new Date('2026-11-01T04:30:00.000Z'),
    })
    expect(task!.detail).toContain('Read the reply in /inbox before you get in touch.')
    expect(task!.detail).not.toContain('Very busy')
  })

  it('is a to-do when there is no number to call, and reads the contact’s own zone first', async () => {
    await db.update(schema.companies).set({ phone: null }).where(eq(schema.companies.id, companyId))
    await db.update(schema.contacts).set({ timeZone: 'America/New_York' }).where(eq(schema.contacts.id, contactId))
    await reply('Can we talk on Monday?')
    const [task] = await tasks()
    expect(task).toMatchObject({ kind: 'todo', title: 'Follow up with Kumar Dental on Monday, as their reply said' })
    // Monday 12 October, 10:00 in New York (EDT, UTC−4).
    expect(task!.dueAt).toEqual(new Date('2026-10-12T14:00:00.000Z'))
  })

  it('is nothing for an opt-out, an auto-reply, or a time that is only in the quoted thread', async () => {
    await reply('Please remove me from your list.')
    await reply('I am out of the office. Please call me next week.', { autoReply: true })
    await reply('Sounds good.\n\nOn Mon, 5 Oct 2026, Ryan wrote:\n> Shall I call you next month?')
    expect(await tasks()).toEqual([])
  })

  it('never costs the reply its record when the task cannot be written', async () => {
    await db.update(schema.companies).set({ name: 'x'.repeat(10) }).where(eq(schema.companies.id, companyId))
    await db.execute(`ALTER TABLE tasks ADD CONSTRAINT no_tasks_today CHECK (false) NOT VALID`)
    const recorded = await reply('Call me tomorrow please')
    expect(recorded.touchId).toBeTruthy()
    const [stored] = await db.select().from(schema.touches).where(eq(schema.touches.id, recorded.touchId))
    expect(stored).toMatchObject({ direction: 'in' })
    expect((await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!.pausedAt).not.toBeNull()
  })
})
