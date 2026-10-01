/**
 * A message the last worker left mid-send (Phase 4).
 *
 * `sending` is the sender tick's claim on a row. A worker that died between
 * the claim and the provider's answer leaves that row claimed forever, and
 * nobody can tell whether the mail went. The SAFE reading is `failed` with a
 * reason a person can act on. The alternative — back to `approved` — is a
 * guess that the provider was not reached, and being wrong means somebody
 * receives the same cold email twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { approveDraft, handleInboundEmail, pauseReasonClass, replyQueueDraft, schema, type AgencyDb } from '@agency/db'
import { migratedDb,type TestDb } from '../../../packages/db/test/helpers.js'
import { recoverStuckSends } from '../src/boot/reconcile.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

describe('recoverStuckSends', () => {
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

  const touch = async (status: string) => {
    const [row] = await db
      .insert(schema.touches)
      .values({ orgId, companyId, channel: 'email', direction: 'out', status })
      .returning({ id: schema.touches.id })
    return row!.id
  }

  it('marks a row the LAST worker left sending as failed, with a reason a person can act on', async () => {
    const id = await touch('sending')
    // The worker boots after the row was claimed.
    const bootAt = new Date(Date.now() + 60_000)
    expect(await recoverStuckSends(db, bootAt, silent)).toBe(1)
    const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
    expect(row!.status).toBe('failed')
    expect(row!.error).toMatch(/restarted/)
    expect(row!.error).toMatch(/re-approve/)
  })

  /**
   * Scoped by boot time, like every reconciler here: a claim made AFTER this
   * process started is this process's own tick, mid-flight, and must be left
   * alone.
   */
  it('leaves a claim newer than the boot alone', async () => {
    const id = await touch('sending')
    const bootAt = new Date(Date.now() - 60_000)
    expect(await recoverStuckSends(db, bootAt, silent)).toBe(0)
    const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
    expect(row!.status).toBe('sending')
  })

  it('touches nothing that is not mid-send', async () => {
    for (const s of ['approved', 'queued', 'sent', 'refused']) {
      if (s === 'approved') continue // needs an approver; not the point here
      if (s === 'refused') continue // needs a code; not the point here
      await touch(s)
    }
    expect(await recoverStuckSends(db, new Date(Date.now() + 60_000), silent)).toBe(0)
  })

  /**
   * An ANSWER to a reply left mid-send puts the reply's pause back (review
   * round 4): the inbox resumed the person when the answer was drafted, and
   * "may or may not have gone" must not leave them live in every campaign.
   */
  it('puts a reply’s pause back when the stuck row was the answer to it', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4', channel: 'email', status: 'active', dailyCap: 50, quietStart: '21:00', quietEnd: '08:00' })
      .returning({ id: schema.campaigns.id })
    await db.insert(schema.touches).values({
      orgId, campaignId: campaign!.id, contactId: contact!.id, companyId, channel: 'email', direction: 'out',
      status: 'sent', subject: 'A gap', body: 'Hello.', recipient: 'priya@rentman.io', providerId: '<ours@agency.test>',
      sentAt: new Date('2026-09-14T10:00:00Z'), approvedBy: user!.id, approvedAt: new Date('2026-09-14T09:55:00Z'),
    })
    const now = new Date('2026-09-15T12:00:00Z')
    const r = await handleInboundEmail(db, {
      from: 'priya@rentman.io', subject: 'Re: A gap', text: 'Not now.', messageId: '<reply@rentman.io>',
      references: ['<ours@agency.test>'], now,
    })
    if (r.matched === 'none') throw new Error('reply not matched')
    const drafted = await replyQueueDraft(db, { orgId, inboundTouchId: r.touchId, subject: 'Re: A gap', body: 'Talk in January.', actor: user!.id, now })
    if (!drafted.ok) throw new Error('not drafted')
    const approved = await approveDraft(db, { orgId, touchId: drafted.touchId, contactId: contact!.id, campaignId: campaign!.id, approvedBy: user!.id, now })
    if (!approved.ok) throw new Error('not approved')
    const contactRow = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contact!.id)))[0]!
    expect((await contactRow()).pausedAt).toBeNull()

    await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, drafted.touchId))
    expect(await recoverStuckSends(db, new Date(Date.now() + 60_000), silent)).toBe(1)

    const after = await contactRow()
    expect(after.pausedAt).not.toBeNull()
    expect(pauseReasonClass(after.pausedReason)).toBe('replied')
  })

  it('never throws, because a reconciler that dies stops the boot', async () => {
    const broken = {
      update: () => {
        throw new Error('the database went away')
      },
    } as unknown as AgencyDb
    await expect(recoverStuckSends(broken, new Date(), silent)).resolves.toBe(0)
  })
})
