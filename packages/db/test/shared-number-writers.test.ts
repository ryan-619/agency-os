/**
 * Review round 12: every writer that lifts a pause asks the shared-number
 * question Resume asks, and the phone guard is not raised over a pause
 * Resume never lifts.
 *
 * - [0][2][5] `replyQueueDraft` resumed a listed holder's own `replied`
 *   pause without asking `heldForUnrecordedSharedNumber` — so /inbox lifted
 *   what /contacts Resume refused, and its `contact.resumed` row spent the
 *   row that held them while the number was still unrecorded. Refused now,
 *   until the number is recorded.
 * - [1] `contactsUpdate` refused `shared_number_hold` over their own
 *   unrecorded opt-out, telling a person to "resume them first" — which
 *   Resume never does for that pause — so the phone froze for good.
 *
 * ([3], the stuck-send correction's lift, is pinned in
 * apps/agent/test/shared-number-recovery.test.ts, beside `recoverStuckSends`.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { pausedSentence } from '@agency/core'
import {
  SHARED_NUMBER_HOLD_REPLIED_SENTENCE, addSuppression, contactResumeByHand, contactsUpdate, heldForUnrecordedSharedNumber,
  pauseContactOverriding, previewSend, recordInboundReply, replyQueueDraft, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const AT = new Date('2026-09-15T06:30:00.000Z')
const LATER = new Date('2026-09-15T07:30:00.000Z')
const PHONE = '+919812345678'
const QUIET = { error() {}, warn() {}, info() {} } as never

describe('a shared number’s holder, through every writer of a resume (review round 12)', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let x: string
  let mailOut: string
  let mailId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'acme.example', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, firstName: 'X', email: 'x@acme.example', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    x = contact!.id
    const [mail] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Mail', channel: 'email', status: 'active', autoSend: false })
      .returning({ id: schema.campaigns.id })
    mailId = mail!.id
    const [out] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId: mail!.id, contactId: x, companyId: company!.id, channel: 'email', direction: 'out', status: 'sent',
        subject: 'Hi', body: 'Hi X', recipient: 'x@acme.example', sentAt: new Date(AT.getTime() - 86_400_000), providerId: '<m1@agency.test>',
      })
      .returning({ id: schema.touches.id })
    mailOut = out!.id
    // A STOP from the number X shares could not be recorded, and the row
    // listing X is all that holds them — they are not paused (the `paused`
    // shortfall, or a Resume that landed before the row committed).
    await db.insert(schema.auditLog).values({
      orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: null, subjectId: null,
      detail: { channel: 'sms', why: 'suppression_failed', sharedNumber: true, contacts: 1, paused: 0, holders: [x] },
    })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const row = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, x)))[0]!

  it('refuses to answer a listed holder’s own reply from /inbox until the number is recorded, as Resume refuses', async () => {
    const r = await recordInboundReply(db, {
      orgId, contactId: x, channel: 'email', from: 'x@acme.example', subject: 'Re: Hi', body: 'Tell me more about this.',
      inReplyTo: mailOut, providerId: '<r1@acme.example>', now: LATER, log: QUIET,
    })
    const replyId = (r as { touchId: string }).touchId
    const paused = await row()
    expect(paused.pausedReason).toMatch(/^replied /)
    expect(await heldForUnrecordedSharedNumber(db, orgId, paused)).toBe(true)
    expect(await contactResumeByHand(db, { orgId, contact: { id: x }, expectedReason: paused.pausedReason, actor: userId })).toMatchObject({
      ok: false, reason: 'opt_out_not_recorded',
    })

    const refused = await replyQueueDraft(db, { orgId, inboundTouchId: replyId, subject: 'Re: Hi', body: 'Happy to.', actor: userId, now: LATER })
    expect(refused).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!refused.ok) {
      expect(refused.message).toMatch(/Record the number on \/suppressions/)
      expect(refused.message).not.toContain('9812345678')
    }
    // And the send path's sentence does not send a person to /inbox for it
    // (review round 13): the reply's own words named the answer as a way out.
    const words = async () => {
      const p = await previewSend(db, { orgId, contactId: x, campaignId: mailId, now: LATER })
      if (!p.ok || p.decision.allowed) throw new Error('expected a refusal')
      return p.decision.reason
    }
    expect(await words()).toBe(SHARED_NUMBER_HOLD_REPLIED_SENTENCE)
    expect(SHARED_NUMBER_HOLD_REPLIED_SENTENCE).toContain('neither answering their reply from /inbox nor Resume on /contacts')
    expect(SHARED_NUMBER_HOLD_REPLIED_SENTENCE).not.toContain('which resumes them')
    expect(SHARED_NUMBER_HOLD_REPLIED_SENTENCE).not.toMatch(/they asked to stop/)

    // Nothing drafted, nobody resumed, and the row still holds them.
    expect((await row()).pausedReason).toBe(paused.pausedReason)
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'contact.resumed'))).toHaveLength(0)
    expect(await heldForUnrecordedSharedNumber(db, orgId, await row())).toBe(true)

    // Recorded, the answer goes ahead and resumes them, as Resume now would.
    expect(await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'texted STOP', source: 'manual' })).toMatchObject({ ok: true })
    expect(await words()).toBe(pausedSentence('replied'))
    expect(await replyQueueDraft(db, { orgId, inboundTouchId: replyId, subject: 'Re: Hi', body: 'Happy to.', actor: userId, now: LATER })).toMatchObject({
      ok: true, resumed: true,
    })
  })

  it('lets the phone of a listed holder paused for their OWN unrecorded opt-out change: Resume never lifts that pause', async () => {
    const own = `opt-out not recorded: reply ${AT.toISOString()} (suppression_failed)`
    await pauseContactOverriding(db, orgId, x, own, AT)
    expect(await heldForUnrecordedSharedNumber(db, orgId, await row())).toBe(true)
    expect(await contactsUpdate(db, orgId, x, { phone: '+91 99887 76655' })).toMatchObject({ ok: true, changed: ['phone'] })
    // Still paused as they were — an own opt-out is not something to resume.
    expect((await row()).pausedReason).toBe(own)
  })

  it('keeps refusing the phone of a listed holder whose pause Resume would lift, paused or not', async () => {
    expect(await contactsUpdate(db, orgId, x, { phone: '+91 99887 76655' })).toMatchObject({ ok: false, reason: 'shared_number_hold' })
    await pauseContactOverriding(db, orgId, x, 'waiting on legal (by sam@agency.test)', AT)
    expect(await contactsUpdate(db, orgId, x, { phone: '' })).toMatchObject({ ok: false, reason: 'shared_number_hold' })
    expect((await row()).phone).toBe(PHONE)
  })
})
