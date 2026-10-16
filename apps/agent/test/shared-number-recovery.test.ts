/**
 * Review round 12, [3]: the stuck-send correction (`dispatchTouch`'s
 * `recordRecoveredSend` → `liftRecoveryPause`) resumed a shared number's
 * holder whose answer went after all — writing `contact.resumed`, which
 * spends the row that holds them — while the number's STOP was still
 * unrecorded and /contacts Resume refused them. The re-pause now stays.
 *
 * The sequence, from the reviewer's probe: Bina replies, a person answers,
 * the answer is approved and claimed; while the provider call is in flight
 * a STOP from a number Bina shares arrives and cannot hold her (both hold
 * writes fault — the `paused` shortfall), a new worker's recovery marks the
 * answer failed and puts Bina's reply pause back; then the provider accepts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  approveDraft, contactResumeByHand, dispatchTouch, handleInboundEmail, heldForUnrecordedSharedNumber, recordInboundSms,
  replyQueueDraft, schema, type AgencyDb, type MessageProvider,
} from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { failOnce } from '../../../packages/db/test/fault-db.js'
import { recoverStuckSends } from '../src/boot/reconcile.js'

const AT = new Date('2026-09-15T06:30:00.000Z')
const NOON = new Date('2026-09-15T07:00:00.000Z')
const LATER = new Date('2026-09-15T08:00:00.000Z')
const PHONE = '+919812345678'
const QUIET = { debug() {}, info() {}, warn() {}, error() {} }

describe('the stuck-send correction and a shared number’s holder (review round 12)', () => {
  let test: TestDb
  let db: AgencyDb

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('keeps the reply pause the recovery put back while the number is unrecorded, and spends no row', async () => {
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning()
    const orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning()
    const [company] = await db.insert(schema.companies).values({ orgId, domain: 'acme.example', timeZone: 'Asia/Kolkata' }).returning()
    const [jo] = await db.insert(schema.contacts).values({ orgId, companyId: company!.id, email: 'jo@acme.example', phone: PHONE, timeZone: 'Asia/Kolkata' }).returning()
    const [bina] = await db.insert(schema.contacts).values({ orgId, companyId: company!.id, email: 'bina@acme.example', phone: PHONE, timeZone: 'Asia/Kolkata' }).returning()
    const [camp] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'mail', channel: 'email', autoSend: false, dailyCap: 50, status: 'active', quietStart: '21:00', quietEnd: '08:00' })
      .returning()
    await db.insert(schema.touches).values({
      orgId, contactId: jo!.id, companyId: company!.id, channel: 'sms', direction: 'out', status: 'sent', body: 'Hi Jo',
      recipient: PHONE, sentAt: new Date(AT.getTime() - 86_400_000), providerId: 'ds-1',
    })
    await db.insert(schema.touches).values({
      orgId, campaignId: camp!.id, contactId: bina!.id, companyId: company!.id, channel: 'email', direction: 'out', status: 'sent',
      subject: 'Hello', body: 'Hello', recipient: 'bina@acme.example', providerId: '<ours-1@agency.test>',
      sentAt: new Date(AT.getTime() - 86_400_000), approvedBy: user!.id, approvedAt: new Date(AT.getTime() - 86_400_000),
    })
    const row = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, bina!.id)))[0]!

    const r = await handleInboundEmail(db, {
      from: 'bina@acme.example', subject: 'Re: Hello', text: 'Maybe next month.', messageId: '<r1@acme.example>',
      references: ['<ours-1@agency.test>'], now: AT,
    } as never)
    const drafted = await replyQueueDraft(db, {
      orgId, inboundTouchId: (r as { touchId: string }).touchId, subject: 'Re', body: 'Sure, next month.', actor: user!.id, now: AT,
    })
    expect(drafted.ok).toBe(true)
    const approved = await approveDraft(db, {
      orgId, touchId: (drafted as { touchId: string }).touchId, contactId: bina!.id, campaignId: camp!.id, approvedBy: user!.id, now: AT,
    })
    if (!approved.ok) throw new Error('not approved')

    let pausedAfterRecovery: string | null = null
    const provider: MessageProvider = {
      name: 'test', channels: ['email'],
      async send() {
        await failOnce(test.pg, { table: 'contacts', event: 'UPDATE', when: `NEW.id = '${bina!.id}'` })
        await failOnce(test.pg, { table: 'contacts', event: 'UPDATE', when: `NEW.id = '${bina!.id}'` })
        await recordInboundSms(db, { from: PHONE, text: 'Wrong number. STOP', providerMessageId: 'm-1', orgId, receivedAt: NOON, log: QUIET } as never)
          .catch(() => {})
        await recoverStuckSends(db as never, new Date(Date.now() + 60_000), QUIET)
        pausedAfterRecovery = (await row()).pausedReason
        return { providerId: '<answer@agency.test>' }
      },
    }
    await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, approved.touch.id))
    await dispatchTouch(db, provider, approved.touch, { now: LATER })

    expect(pausedAfterRecovery).toMatch(/^replied /)
    // The answer went after all — and Bina is still held: the lift asked the
    // question Resume asks, and the number is unrecorded.
    const after = await row()
    expect(after.pausedReason).toBe(pausedAfterRecovery)
    expect(await heldForUnrecordedSharedNumber(db, orgId, after)).toBe(true)
    const resumedBySystem = (await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'contact.resumed'))).filter(
      (a) => a.actor === 'system',
    )
    expect(resumedBySystem).toHaveLength(0)
    expect(await contactResumeByHand(db, { orgId, contact: { id: bina!.id }, expectedReason: after.pausedReason, actor: user!.id })).toMatchObject({
      ok: false, reason: 'opt_out_not_recorded',
    })
  })
})
