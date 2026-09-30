/**
 * The LinkedIn provider is a person, and Start runs the one send path.
 *
 * Every rule §2.1 applies to email applies here at the moment the person is
 * handed the words — and the words are handed over ONLY when every rule
 * says yes. The failure this file exists to prevent is the one the first
 * design had: the person sends from their own account first, the rules run
 * after, and the record says `refused` about a message that already went, or
 * lists a deferred message again for it to go twice.
 *
 * The clock deferral has a second copy in the worker's tick
 * (apps/agent/src/outreach/sender.ts). The two are run on twin rows and
 * asserted to land identically, so they cannot drift apart quietly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import {
  dispatchTouch, linkedinFinishStep, linkedinHumanProvider, linkedinPerformStep, linkedinProfileUrl,
  linkedinStepsDue, LINKEDIN_STEP_STUCK_ERROR, LINKEDIN_STEP_STUCK_MINUTES, schema,
  type AgencyDb, type MessageProvider,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
// The worker's two copies of what this module does on the web: the stuck-send
// reconciler (left untouched, and asserted to still cover a claim a crashed
// request leaves) and the tick whose deferral Start must match.
import { recoverStuckSends } from '../../../apps/agent/src/boot/reconcile.js'
import { runSenderTick } from '../../../apps/agent/src/outreach/sender.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
/** Midday UTC: 13:00 in London. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
/** 23:30 UTC: 00:30 in London, inside the default 21:00–08:00 window. */
const NIGHT = new Date('2026-09-15T23:30:00.000Z')
const BODY = 'Hello Jane — your security page is missing a disclosure contact.'
const PROFILE = 'https://www.linkedin.com/in/jane-doe/'

describe('the LinkedIn step', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let otherUserId: string
  let companyId: string
  let contactId: string
  let campaignId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', name: 'Priya', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [other] = await db
      .insert(schema.users)
      .values({ orgId, email: 'sam@agency.test', role: 'member' })
      .returning({ id: schema.users.id })
    otherUserId = other!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Jane', lastName: 'Doe', linkedinUrl: PROFILE, timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 LinkedIn', channel: 'linkedin', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A LinkedIn draft a person approved, as `approveDraft` leaves it. */
  const approved = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId, contactId, companyId, channel: 'linkedin', direction: 'out',
        status: 'approved', approvedBy: userId, approvedAt: NOON, subject: '', body: BODY,
        ...over,
      })
      .returning()
    return row!
  }
  const reread = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const openTasks = async (touchId: string) =>
    (await db.select().from(schema.tasks).where(eq(schema.tasks.touchId, touchId))).filter((t) => t.doneAt === null)
  const start = (touchId: string, now = NOON, who = userId) => linkedinPerformStep(db, { orgId, touchId, userId: who, now })
  const finish = (touchId: string, outcome: 'sent' | 'not_sent' | 'dismissed') =>
    linkedinFinishStep(db, { orgId, touchId, userId, outcome, now: NOON })
  const audit = async () => db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId))

  describe('the list', () => {
    it('an approved LinkedIn touch becomes one open task and is listed once, however often it is read', async () => {
      const t = await approved()
      const first = await linkedinStepsDue(db, orgId, NOON)
      const second = await linkedinStepsDue(db, orgId, NOON)
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(second[0]!.taskId).toBe(first[0]!.taskId)
      expect(await openTasks(t.id)).toHaveLength(1)
      const [task] = await openTasks(t.id)
      expect(task!.kind).toBe('linkedin_send')
      expect(task!.title).toBe('Send on LinkedIn to Jane Doe at Rentman')
      expect(task!.companyId).toBe(companyId)
      expect(first[0]).toMatchObject({
        state: 'ready',
        touchId: t.id,
        contactName: 'Jane Doe',
        companyDomain: 'rentman.io',
        campaignName: 'Q4 LinkedIn',
        profileUrl: 'https://www.linkedin.com/in/jane-doe',
        words: null,
      })
    })

    it('shows the send path’s own dry-run decision before anybody presses Start', async () => {
      await approved()
      const [clear] = await linkedinStepsDue(db, orgId, NOON)
      expect(clear!.preview).toMatchObject({ ok: true, decision: { code: 'send_now' } })

      const [night] = await linkedinStepsDue(db, orgId, NIGHT)
      expect(night!.preview).toMatchObject({ ok: true, decision: { code: 'quiet_hours' } })

      await db.insert(schema.suppressions).values({ orgId, kind: 'linkedin', value: 'in/jane-doe', reason: 'asked on LinkedIn' })
      const [suppressed] = await linkedinStepsDue(db, orgId, NOON)
      expect(suppressed!.preview).toMatchObject({ ok: true, decision: { code: 'suppressed' } })
    })

    it('lists a queued message from an auto-send campaign too — nobody else will ever send it', async () => {
      await db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, campaignId))
      const t = await approved({ status: 'queued', approvedBy: null, approvedAt: null })
      const steps = await linkedinStepsDue(db, orgId, NOON)
      expect(steps.map((s) => [s.touchId, s.state])).toEqual([[t.id, 'ready']])
      const r = await start(t.id)
      expect(r).toMatchObject({ ok: true, status: 'sent' })
      expect((await reread(t.id)).status).toBe('sent')
    })

    it('ignores email, inbound and finished rows, and another org’s', async () => {
      await approved({ status: 'refused', approvedBy: null, approvedAt: null, refusalCode: 'suppressed' })
      await db.insert(schema.touches).values({ orgId, contactId, companyId, channel: 'linkedin', direction: 'in', status: 'replied' })
      const [emailCampaign] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Q4 email', channel: 'email', status: 'active' })
        .returning({ id: schema.campaigns.id })
      await approved({ channel: 'email', campaignId: emailCampaign!.id })
      expect(await linkedinStepsDue(db, orgId, NOON)).toEqual([])

      const t = await approved()
      const [rival] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await linkedinStepsDue(db, rival!.id, NOON)).toEqual([])
      expect(await openTasks(t.id)).toHaveLength(0)
    })
  })

  describe('Start', () => {
    it('hands over the words only when every rule passes, settles `sent` naming the person, and moves the deal', async () => {
      const t = await approved()
      const r = await start(t.id)
      expect(r).toEqual({
        ok: true,
        status: 'sent',
        words: { to: PROFILE, profileUrl: 'https://www.linkedin.com/in/jane-doe', subject: '', body: BODY },
      })

      const row = await reread(t.id)
      expect(row.status).toBe('sent')
      expect(row.providerId).toBe(`human:${userId}`)
      expect(row.providerId!.startsWith('human:')).toBe(true)
      expect(row.sentAt).toEqual(NOON)
      expect(row.recipient).toBe(PROFILE)

      const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
      expect(deal!.stage).toBe('contacted')

      const actions = (await audit()).map((a) => a.action)
      expect(actions).toContain('send.sent')
      expect(actions).toContain('linkedin.handed')
      const sent = (await audit()).find((a) => a.action === 'send.sent')!
      expect(sent.detail).toMatchObject({ provider: 'human', providerId: `human:${userId}`, channel: 'linkedin' })
      const handed = (await audit()).find((a) => a.action === 'linkedin.handed')!
      expect(handed.actor).toBe(userId)

      // The step's task stays open until the person says it went.
      expect(await openTasks(t.id)).toHaveLength(1)
    })

    it('a suppressed in/slug is refused, nothing is handed over, and the task stays open with the reason', async () => {
      const t = await approved()
      await linkedinStepsDue(db, orgId, NOON)
      await db.insert(schema.suppressions).values({ orgId, kind: 'linkedin', value: 'in/jane-doe', reason: 'asked on LinkedIn' })
      const r = await start(t.id)
      expect(r).toMatchObject({ ok: true, status: 'refused', code: 'suppressed' })
      expect(r).not.toHaveProperty('words')

      const row = await reread(t.id)
      expect(row.status).toBe('refused')
      expect(row.refusalCode).toBe('suppressed')
      expect(row.providerId).toBeNull()
      expect(row.sentAt).toBeNull()

      expect(await openTasks(t.id)).toHaveLength(1)
      const [step] = await linkedinStepsDue(db, orgId, NOON)
      expect(step).toMatchObject({ state: 'stopped', refusalCode: 'suppressed', words: null, preview: null })
    })

    it('quiet hours defer: back to approved with scheduled_for, and the words are never shown', async () => {
      const t = await approved()
      const r = await start(t.id, NIGHT)
      expect(r).toMatchObject({ ok: true, status: 'deferred', code: 'quiet_hours', until: new Date(NIGHT.getTime() + 3_600_000) })
      expect(r).not.toHaveProperty('words')
      const row = await reread(t.id)
      expect(row.status).toBe('approved')
      expect(row.refusalCode).toBeNull()
      expect(row.scheduledFor).toEqual(new Date(NIGHT.getTime() + 3_600_000))
      expect(row.approvedBy).toBe(userId)
      expect(row.providerId).toBeNull()
    })

    /**
     * The deferral has two copies — this one and the worker's tick — and
     * they must agree. Each clock code is run through BOTH on twin rows.
     */
    for (const code of ['quiet_hours', 'daily_cap', 'campaign_inactive'] as const) {
      it(`a ${code} deferral lands exactly where the worker's tick puts it`, async () => {
        let now = NOON
        if (code === 'quiet_hours') now = NIGHT
        if (code === 'daily_cap') {
          await db.update(schema.campaigns).set({ dailyCap: 1 }).where(eq(schema.campaigns.id, campaignId))
          await approved({ status: 'sent', sentAt: new Date(NOON.getTime() - 3_600_000), providerId: 'earlier' })
        }
        if (code === 'campaign_inactive') {
          await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
        }
        const mine = await approved()
        const r = await start(mine.id, now)
        expect(r).toMatchObject({ ok: true, status: 'deferred', code })

        const twin = await approved()
        const never: MessageProvider = {
          name: 'twin',
          channels: ['linkedin'],
          async send() {
            throw new Error('a deferred message must not reach a provider')
          },
        }
        const summary = await runSenderTick({
          db: db as never, provider: never, log: silent, batch: 20, now: () => now,
        })
        expect(summary).toMatchObject({ picked: 1, deferred: 1 })

        const pick = (row: typeof mine) => ({ status: row.status, refusalCode: row.refusalCode, scheduledFor: row.scheduledFor })
        expect(pick(await reread(mine.id))).toEqual(pick(await reread(twin.id)))
      })
    }

    it('a message the human was handed is never listed as a step twice', async () => {
      const t = await approved()
      await linkedinStepsDue(db, orgId, NOON)
      expect(await start(t.id)).toMatchObject({ status: 'sent' })

      const afterStart = await linkedinStepsDue(db, orgId, NOON)
      expect(afterStart).toHaveLength(1)
      expect(afterStart[0]).toMatchObject({
        state: 'handed',
        touchId: t.id,
        preview: null,
        handedTo: { userId, label: 'Priya' },
        words: { body: BODY, profileUrl: 'https://www.linkedin.com/in/jane-doe' },
      })
      expect(await start(t.id)).toMatchObject({ ok: false, reason: 'not_approved' })

      expect(await finish(t.id, 'sent')).toEqual({ ok: true, alreadyDone: false })
      expect(await linkedinStepsDue(db, orgId, NOON)).toEqual([])
      expect(await linkedinStepsDue(db, orgId, NOON)).toEqual([])
      expect(await openTasks(t.id)).toHaveLength(0)
      expect(await start(t.id)).toMatchObject({ ok: false, reason: 'not_approved' })
      expect((await audit()).filter((a) => a.action === 'linkedin.handed')).toHaveLength(1)
    })

    it('a second click on a row already sent is not_approved', async () => {
      const t = await approved()
      await start(t.id)
      expect(await start(t.id)).toMatchObject({ ok: false, reason: 'not_approved' })
    })

    it('two simultaneous clicks hand the words to one person; the other is told it was claimed', async () => {
      const t = await approved()
      await linkedinStepsDue(db, orgId, NOON)
      const results = await Promise.all([start(t.id, NOON, userId), start(t.id, NOON, otherUserId)])
      const winners = results.filter((r) => r.ok && r.status === 'sent')
      const losers = results.filter((r) => !r.ok)
      expect(winners).toHaveLength(1)
      expect(losers).toEqual([expect.objectContaining({ ok: false, reason: 'claimed' })])
      expect((await audit()).filter((a) => a.action === 'send.sent')).toHaveLength(1)
    })

    it('a row somebody is mid-way through starting is claimed, not started again', async () => {
      const t = await approved()
      await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, t.id))
      expect(await start(t.id)).toMatchObject({ ok: false, reason: 'claimed' })
      expect((await reread(t.id)).status).toBe('sending')
    })

    it('an email touch is refused by the provider’s channel list without touching the row', async () => {
      const [emailCampaign] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Q4 email', channel: 'email', status: 'active' })
        .returning({ id: schema.campaigns.id })
      const t = await approved({ channel: 'email', campaignId: emailCampaign!.id })
      expect(await start(t.id)).toMatchObject({ ok: false, reason: 'wrong_channel' })
      // And the send path itself refuses the person as a provider for email.
      const direct = await dispatchTouch(db, linkedinHumanProvider(userId), t, { now: NOON })
      expect(direct.sent).toBe(false)
      const row = await reread(t.id)
      expect(row.status).toBe('approved')
      expect(row.updatedAt).toBeNull()
      expect(row.providerId).toBeNull()
      expect(await openTasks(t.id)).toHaveLength(0)
    })

    it('another org’s message is not_found, and nothing about it changes', async () => {
      const t = await approved()
      const [rival] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const r = await linkedinPerformStep(db, { orgId: rival!.id, touchId: t.id, userId, now: NOON })
      expect(r).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await linkedinFinishStep(db, { orgId: rival!.id, touchId: t.id, userId, outcome: 'sent' }))
        .toMatchObject({ ok: false, reason: 'not_found' })
      expect((await reread(t.id)).status).toBe('approved')
    })

    it('no audit row carries the words or the profile', async () => {
      const t = await approved({ subject: 'Your security page' })
      await linkedinStepsDue(db, orgId, NOON)
      await start(t.id)
      await finish(t.id, 'sent')
      const rows = await audit()
      expect(rows.length).toBeGreaterThanOrEqual(4)
      const text = JSON.stringify(rows.map((r) => r.detail))
      expect(text).not.toContain('Hello Jane')
      expect(text).not.toContain('Your security page')
      expect(text).not.toContain('jane-doe')
      expect(text).not.toContain('Jane')
    })
  })

  describe('finishing a step', () => {
    it('I did not send it: the row becomes failed, is not counted as sent, and the step closes', async () => {
      const t = await approved()
      await start(t.id)
      expect(await finish(t.id, 'not_sent')).toEqual({ ok: true, alreadyDone: false })
      const row = await reread(t.id)
      expect(row.status).toBe('failed')
      expect(row.sentAt).toBeNull()
      expect(row.providerId).toBe(`human:${userId}`)
      expect(row.error).toMatch(/not sent/)
      expect(await openTasks(t.id)).toHaveLength(0)
      expect(await linkedinStepsDue(db, orgId, NOON)).toEqual([])
      // The deal is left where Start's forward-only move put it; moving it
      // back is a person's call on the board, not a guess made here.
      const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
      expect(deal!.stage).toBe('contacted')
      // Once decided, the other answer is not available.
      expect(await finish(t.id, 'sent')).toMatchObject({ ok: false, reason: 'not_handed' })
    })

    it('I sent it on a message nobody was handed is refused', async () => {
      const t = await approved()
      await linkedinStepsDue(db, orgId, NOON)
      expect(await finish(t.id, 'sent')).toMatchObject({ ok: false, reason: 'not_handed' })
      expect(await openTasks(t.id)).toHaveLength(1)
    })

    it('the second of two answers is told the first one stands', async () => {
      const t = await approved()
      await start(t.id)
      expect(await finish(t.id, 'sent')).toEqual({ ok: true, alreadyDone: false })
      expect(await finish(t.id, 'not_sent')).toEqual({ ok: true, alreadyDone: true })
      expect((await reread(t.id)).status).toBe('sent')
    })

    it('a stopped step can be dismissed; a live or handed one cannot', async () => {
      const ready = await approved()
      await linkedinStepsDue(db, orgId, NOON)
      expect(await finish(ready.id, 'dismissed')).toMatchObject({ ok: false, reason: 'still_live' })

      await start(ready.id)
      expect(await finish(ready.id, 'dismissed')).toMatchObject({ ok: false, reason: 'still_live' })

      const refused = await approved()
      await db.insert(schema.suppressions).values({ orgId, kind: 'linkedin', value: 'in/jane-doe', reason: 'asked' })
      await start(refused.id)
      expect(await finish(refused.id, 'dismissed')).toEqual({ ok: true, alreadyDone: false })
      expect(await openTasks(refused.id)).toHaveLength(0)
      expect((await audit()).some((a) => a.action === 'linkedin.dismissed')).toBe(true)
    })
  })

  describe('a claim nobody settled', () => {
    it('the list marks a LinkedIn row left sending past the limit failed, and leaves a fresh one alone', async () => {
      const stuck = await approved()
      await linkedinStepsDue(db, orgId, NOON)
      // A Start that died between the claim and the settle.
      await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, stuck.id))

      const soon = new Date(Date.now() + 60_000)
      const [fresh] = await linkedinStepsDue(db, orgId, soon)
      expect(fresh).toMatchObject({ state: 'sending' })
      expect((await reread(stuck.id)).status).toBe('sending')

      const later = new Date(Date.now() + (LINKEDIN_STEP_STUCK_MINUTES + 1) * 60_000)
      const [failed] = await linkedinStepsDue(db, orgId, later)
      expect(failed).toMatchObject({ state: 'stopped', error: LINKEDIN_STEP_STUCK_ERROR })
      const row = await reread(stuck.id)
      expect(row.status).toBe('failed')
      expect(row.error).toBe(LINKEDIN_STEP_STUCK_ERROR)
      // True about this flow: a claim that never settled never handed anything over.
      expect(row.error).toMatch(/never shown to anybody here/)
      expect(row.providerId).toBeNull()
      expect(row.sentAt).toBeNull()
    })

    it('leaves an email row the worker is sending to the worker', async () => {
      const [emailCampaign] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Q4 email', channel: 'email', status: 'active' })
        .returning({ id: schema.campaigns.id })
      const t = await approved({ channel: 'email', campaignId: emailCampaign!.id })
      await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, t.id))
      await linkedinStepsDue(db, orgId, new Date(Date.now() + 24 * 3_600_000))
      expect((await reread(t.id)).status).toBe('sending')
    })

    it('recoverStuckSends still marks a LinkedIn claim a crashed request left as failed', async () => {
      const t = await approved()
      await db
        .update(schema.touches)
        .set({ status: 'sending' })
        .where(and(eq(schema.touches.id, t.id), eq(schema.touches.status, 'approved')))
      expect(await recoverStuckSends(db as never, new Date(Date.now() + 60_000), silent)).toBe(1)
      const row = await reread(t.id)
      expect(row.status).toBe('failed')
      expect(row.error).toMatch(/restarted/)
    })
  })

  it('builds a profile link only from a readable LinkedIn key', () => {
    expect(linkedinProfileUrl(PROFILE)).toBe('https://www.linkedin.com/in/jane-doe')
    expect(linkedinProfileUrl('linkedin.com/company/acme?trk=1')).toBe('https://www.linkedin.com/company/acme')
    expect(linkedinProfileUrl('javascript:alert(1)')).toBeNull()
    expect(linkedinProfileUrl(null)).toBeNull()
  })
})
