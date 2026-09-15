/**
 * The sender tick (PROMPT.md §8.4), against a real engine.
 *
 * `packages/db/test/outreach.test.ts` proves `dispatchTouch` — the rules and
 * the recording. This proves the scheduling around it: that a tick picks up
 * what a person approved, claims it so a second worker cannot, sends it once
 * and only once, and that a refusal for the CLOCK (quiet hours, the cap) is a
 * deferral rather than a death — the person said yes, and the only thing
 * wrong was the hour.
 *
 * The provider counts and never sends. Every test asserts against the count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createDryRunProvider, schema, type AgencyDb } from '@agency/db'
import { freshDb, migrations, type TestDb } from '../../../packages/db/test/helpers.js'
import { migrateUp } from '../../../packages/db/src/migrator.js'
import { runSenderTick } from '../src/outreach/sender.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
/** Midday UTC: midday in London. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
/** 23:30 UTC: quiet hours in London. */
const NIGHT = new Date('2026-09-15T23:30:00.000Z')

describe('the sender tick', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let provider: ReturnType<typeof createDryRunProvider>

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    provider = createDryRunProvider()

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      // `status` defaults to 'draft', and a draft campaign does not send —
      // which is the review finding the campaign_inactive rule fixed.
      .values({ orgId, name: 'Q4', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A draft a person has approved, as `approveDraft` leaves it. */
  const approved = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out',
        status: 'approved', approvedBy: userId, approvedAt: NOON,
        subject: 'A gap on your security page', body: 'Hello.',
        ...over,
      })
      .returning()
    return row!
  }
  const reread = async (id: string) =>
    (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const tick = (now = NOON) => runSenderTick({ db, provider, log: silent, batch: 20, now: () => now })

  it('sends what a person approved, once', async () => {
    const t = await approved()
    const first = await tick()
    expect(first).toMatchObject({ picked: 1, sent: 1 })
    expect(provider.sent).toHaveLength(1)
    expect((await reread(t.id)).status).toBe('sent')

    // The next tick finds nothing: the row is no longer approved.
    const second = await tick()
    expect(second.picked).toBe(0)
    expect(provider.sent).toHaveLength(1)
  })

  /**
   * The person approved the WORDS. Their approval is what satisfies §2.4's
   * gate on a campaign without auto-send; it is not what satisfies §2.1.
   */
  it('sends through a campaign with no auto-send, because a person said yes', async () => {
    await approved()
    await tick()
    expect(provider.sent).toHaveLength(1)
  })

  it('leaves an unapproved draft alone', async () => {
    await approved({ status: 'awaiting_approval', approvedBy: null, approvedAt: null })
    const s = await tick()
    expect(s.picked).toBe(0)
    expect(provider.sent).toEqual([])
  })

  /**
   * The clock is the only thing wrong, so the message waits. `scheduled_for`
   * is set past the window and the row goes back to `approved`, keeping the
   * approver's name on it.
   */
  it('defers an approved message that lands in quiet hours, rather than refusing it', async () => {
    const t = await approved()
    const s = await tick(NIGHT)
    expect(s).toMatchObject({ picked: 1, sent: 0, deferred: 1, refused: 0 })
    expect(provider.sent).toEqual([])

    const row = await reread(t.id)
    expect(row.status).toBe('approved')
    expect(row.approvedBy).toBe(userId)
    expect(row.refusalCode).toBeNull()
    expect(row.scheduledFor!.getTime()).toBeGreaterThan(NIGHT.getTime())
  })

  it('does not pick up a deferred message before its time', async () => {
    const t = await approved()
    await tick(NIGHT)
    const again = await tick(new Date(NIGHT.getTime() + 10 * 60_000)) // ten minutes later
    expect(again.picked).toBe(0)
    expect((await reread(t.id)).status).toBe('approved')
  })

  it('sends a deferred message once its time comes and the window has passed', async () => {
    const t = await approved()
    await tick(NIGHT)
    const morning = new Date('2026-09-16T09:00:00.000Z') // 10:00 London
    const s = await tick(morning)
    expect(s.sent).toBe(1)
    expect((await reread(t.id)).status).toBe('sent')
  })

  it('defers for the daily cap too, and for longer', async () => {
    await db.update(schema.campaigns).set({ dailyCap: 1 }).where(eq(schema.campaigns.id, campaignId))
    // One already went today.
    await approved({ status: 'sent', sentAt: NOON, approvedBy: null, approvedAt: null })
    const t = await approved()
    await tick()
    const row = await reread(t.id)
    expect(row.status).toBe('approved')
    expect(row.scheduledFor!.getTime() - NOON.getTime()).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000)
  })

  /**
   * A suppression is not the clock. Time will not change it, so it is
   * terminal — and the record says why.
   */
  it('refuses, terminally, for a suppression', async () => {
    await db.insert(schema.suppressions).values({
      orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out',
    })
    const t = await approved()
    const s = await tick()
    expect(s).toMatchObject({ refused: 1, sent: 0, deferred: 0 })
    const row = await reread(t.id)
    expect(row.status).toBe('refused')
    expect(row.refusalCode).toBe('suppressed')
    expect(provider.sent).toEqual([])
  })

  it('refuses a draft approved without a campaign or a recipient', async () => {
    const t = await approved({ campaignId: null })
    await tick()
    const row = await reread(t.id)
    expect(row.status).toBe('refused')
    expect(row.error).toMatch(/no campaign/)
    expect(provider.sent).toEqual([])
  })

  it('sends a queued message for an auto-send campaign with nobody approving', async () => {
    await db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, campaignId))
    const t = await approved({ status: 'queued', approvedBy: null, approvedAt: null })
    await tick()
    expect((await reread(t.id)).status).toBe('sent')
    expect(provider.sent).toHaveLength(1)
  })

  /**
   * The campaign turned auto-send off after the message was queued. It is
   * not refused — it goes to a person, which is what the campaign now asks.
   */
  it('routes a queued message to a person when auto-send was turned off', async () => {
    const t = await approved({ status: 'queued', approvedBy: null, approvedAt: null })
    await tick()
    expect((await reread(t.id)).status).toBe('awaiting_approval')
    expect(provider.sent).toEqual([])
  })

  it('leaves a provider failure as failed, with the reason, and keeps ticking', async () => {
    const broken = {
      name: 'broken',
      channels: ['email'] as const,
      async send() {
        throw new Error('SMTP 421 service not available')
      },
    }
    const a = await approved()
    const s = await runSenderTick({ db, provider: broken, log: silent, batch: 20, now: () => NOON })
    expect(s.failed).toBe(1)
    const row = await reread(a.id)
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/421/)
    // A second tick does not retry it on its own: a person looks first.
    const again = await runSenderTick({ db, provider: broken, log: silent, batch: 20, now: () => NOON })
    expect(again.picked).toBe(0)
  })

  it('takes the oldest first, and no more than the batch', async () => {
    for (let i = 0; i < 5; i += 1) await approved({ subject: `m${i}` })
    const s = await runSenderTick({ db, provider, log: silent, batch: 3, now: () => NOON })
    expect(s.picked).toBe(3)
    expect(provider.sent.map((m) => m.subject)).toEqual(['m0', 'm1', 'm2'])
  })

  /**
   * The claim. A row that is already `sending` — another worker got there, or
   * this one is mid-send — is not picked up, so nothing is sent twice.
   */
  it('does not pick up a row another worker has claimed', async () => {
    const t = await approved()
    await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, t.id))
    const s = await tick()
    expect(s.picked).toBe(0)
    expect(provider.sent).toEqual([])
  })

  it('moves the company’s deal to contacted when a message goes', async () => {
    await approved()
    await tick()
    const deals = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
    expect(deals).toHaveLength(1)
    expect(deals[0]!.stage).toBe('contacted')
  })
  it('never picks up a message on a channel its provider cannot carry', async () => {
    const [li] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: true, dailyCap: 10, status: 'active' })
      .returning({ id: schema.campaigns.id })
    await approved({ campaignId: li!.id, channel: 'linkedin', status: 'queued', approvedBy: null, approvedAt: null })
    const emailOnly = { name: 'smtp-like', channels: ['email'] as const, send: provider.send }
    const s = await runSenderTick({ db, provider: emailOnly, log: silent, batch: 20, now: () => NOON })
    expect(s.picked).toBe(0)
    expect(provider.sent).toEqual([])
  })

  it('defers, rather than refuses, a message in a paused campaign', async () => {
    await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
    const t = await approved()
    const s = await tick()
    expect(s).toMatchObject({ picked: 1, sent: 0, deferred: 1 })
    expect((await reread(t.id)).status).toBe('approved')
  })

})
