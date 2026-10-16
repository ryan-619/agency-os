/**
 * SMS through DoveSoft, the database half (0019), against a real engine.
 *
 * A draft is written only from a registered, active template, through the
 * sender's own dry run; the one send path refuses words that are not their
 * template; a delivery report lands beside `status` and never in it; and a
 * text a contact sends back goes through the same reply rules an email does
 * — with an SMS "STOP" written as a PHONE suppression, loudly when it
 * cannot be.
 *
 * The provider here COUNTS rather than sends, and every refusal asserts it
 * was never called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  approveDraft, dispatchTouch, pauseReasonClass, previewSend, recordInboundReply, recordInboundSms, recordSmsDelivery, schema,
  sharedNumberHoldReason, smsDraft, smsTextAsksToStop, templatesSetActive,
  type AgencyDb, type InboundLog, type MessageProvider, type MessageTemplateRegistration,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { throughTransactions } from './fault-db.js'

function smsProvider(): MessageProvider & {
  sent: { to: string; body: string }[]
  registrations: (MessageTemplateRegistration | undefined)[]
} {
  const sent: { to: string; body: string }[] = []
  const registrations: (MessageTemplateRegistration | undefined)[] = []
  return {
    name: 'dovesoft-test',
    channels: ['sms'],
    sent,
    registrations,
    async send(m) {
      sent.push({ to: m.to, body: m.body })
      registrations.push(m.template)
      return { providerId: `ds-${sent.length}` }
    },
  }
}

/** Noon in India. */
const NOON_IST = new Date('2026-09-15T06:30:00.000Z')
/** 09:00 in India: the campaign's quiet hours are over, TRAI's promotional band is not open yet. */
const NINE_IST = new Date('2026-09-15T03:30:00.000Z')
/** 23:00 in India: the campaign's own quiet hours. */
const NIGHT_IST = new Date('2026-09-15T17:30:00.000Z')

const PHONE = '+919876543210'
const BODY = 'Hi {#var#}, your call with Acme is at {#var#}. Reply STOP to opt out.'

describe('SMS (0019)', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let templateId: string
  let provider: ReturnType<typeof smsProvider>

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    provider = smsProvider()
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.in', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    await db.insert(schema.consents).values({ orgId, contactId, channel: 'sms', granted: true, source: 'booking form' })
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Meeting reminders', channel: 'sms', autoSend: false, dailyCap: 50, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
    const [template] = await db
      .insert(schema.messageTemplates)
      .values({ orgId, channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', body: BODY })
      .returning({ id: schema.messageTemplates.id })
    templateId = template!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const draft = (over: Partial<Parameters<typeof smsDraft>[1]> = {}) =>
    smsDraft(db, { orgId, contactId, campaignId, templateId, vars: ['Priya', '3pm'], createdBy: userId, now: NOON_IST, ...over })

  const touch = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const audits = async (action: string) => (await db.select().from(schema.auditLog)).filter((a) => a.action === action)

  // -------------------------------------------------------------------------
  describe('drafting from a template', () => {
    it('writes an awaiting_approval SMS naming its template, rendered, to the E.164 number', async () => {
      const r = await draft()
      expect(r).toMatchObject({ ok: true, body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.', wouldHold: null })
      if (!r.ok) return
      const row = await touch(r.touchId)
      expect(row).toMatchObject({
        channel: 'sms', direction: 'out', status: 'awaiting_approval', templateId, recipient: PHONE,
        body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.', campaignId, contactId, companyId,
      })
      // §2.3: the audit row is ids only.
      const [a] = await audits('sms.drafted')
      expect(a?.detail).toEqual({ contactId, campaignId, templateId })
      expect(a?.actor).toBe(userId)
      expect(JSON.stringify(a)).not.toContain(PHONE)
      expect(JSON.stringify(a)).not.toContain('Priya')
      expect(provider.sent).toEqual([])
    })

    it('stores a number written with spaces as E.164', async () => {
      await db.update(schema.contacts).set({ phone: '+91 98765 43210' }).where(eq(schema.contacts.id, contactId))
      const r = await draft()
      expect(r.ok && (await touch(r.touchId)).recipient).toBe(PHONE)
    })

    it.each([
      ['an email campaign', 'not_an_sms_campaign'],
      ['a paused SMS campaign', 'campaign_not_active'],
    ])('refuses %s', async (label, reason) => {
      if (label === 'an email campaign') {
        const [c] = await db.insert(schema.campaigns).values({ orgId, name: 'Email', channel: 'email', status: 'active' }).returning({ id: schema.campaigns.id })
        expect(await draft({ campaignId: c!.id })).toMatchObject({ ok: false, reason })
      } else {
        await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
        expect(await draft()).toMatchObject({ ok: false, reason })
      }
      expect(await db.select().from(schema.touches)).toHaveLength(0)
    })

    it('refuses a WhatsApp template and a deactivated one', async () => {
      const [wa] = await db
        .insert(schema.messageTemplates)
        .values({ orgId, channel: 'whatsapp', externalId: 'meeting_reminder', senderId: '+919800000000', category: 'utility', body: 'Hi {#var#}' })
        .returning({ id: schema.messageTemplates.id })
      expect(await draft({ templateId: wa!.id, vars: ['Priya'] })).toMatchObject({ ok: false, reason: 'not_an_sms_template' })
      await templatesSetActive(db, { orgId, templateId, active: false, actor: userId })
      expect(await draft()).toMatchObject({ ok: false, reason: 'template_inactive' })
      expect(await db.select().from(schema.touches)).toHaveLength(0)
    })

    it('refuses values that do not render, naming the slot and never the value', async () => {
      const r = await draft({ vars: ['Priya'] })
      expect(r).toMatchObject({ ok: false, reason: 'render_failed', slot: 2 })
      const long = await draft({ vars: ['Priya Raman of the very long surname family', '3pm'] })
      expect(long).toMatchObject({ ok: false, reason: 'render_failed', slot: 1 })
      if (!long.ok) expect(long.message).not.toContain('Raman')
      expect(await draft({ vars: ['https://evil.example/x', '3pm'] })).toMatchObject({ ok: false, reason: 'render_failed' })
    })

    it('refuses a contact with no readable number', async () => {
      await db.update(schema.contacts).set({ phone: '98765 43210' }).where(eq(schema.contacts.id, contactId))
      expect(await draft()).toMatchObject({ ok: false, reason: 'no_phone' })
    })

    it('refuses, through the sender’s own dry run, a person with no SMS opt-in', async () => {
      await db.delete(schema.consents).where(eq(schema.consents.contactId, contactId))
      const r = await draft()
      expect(r).toMatchObject({ ok: false, reason: 'refused', code: 'cold_channel_forbidden' })
      expect(await db.select().from(schema.touches)).toHaveLength(0)
    })

    it('refuses a suppressed number', async () => {
      await db.insert(schema.suppressions).values({ orgId, kind: 'phone', value: PHONE, reason: 'asked', source: 'manual' })
      expect(await draft()).toMatchObject({ ok: false, reason: 'refused', code: 'suppressed' })
    })

    it('writes the draft and reports the hold when only the clock is wrong', async () => {
      const r = await draft({ now: NIGHT_IST })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.wouldHold?.code).toBe('quiet_hours')
    })

    it('reports TRAI’s band for a promotional template as a hold', async () => {
      const [promo] = await db
        .insert(schema.messageTemplates)
        .values({ orgId, channel: 'sms', externalId: '1107160000000099999', senderId: '123456', category: 'promotional', body: 'Offer for {#var#}' })
        .returning({ id: schema.messageTemplates.id })
      const r = await draft({ templateId: promo!.id, vars: ['Priya'], now: NINE_IST })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.wouldHold?.code).toBe('quiet_hours')
        expect(r.wouldHold?.reason).toMatch(/TRAI/)
      }
    })

    it('keeps one draft on its way per person per campaign', async () => {
      expect((await draft()).ok).toBe(true)
      expect(await draft()).toMatchObject({ ok: false, reason: 'already_queued' })
      expect(await db.select().from(schema.touches)).toHaveLength(1)
    })

    it('refuses a contact, campaign or template of another org', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      expect(await draft({ orgId: other!.id })).toMatchObject({ ok: false, reason: 'no_such_contact' })
    })
  })

  // -------------------------------------------------------------------------
  /**
   * The composer's Check is `smsDraft` with `dryRun: true`. It used to be a
   * restatement of smsDraft's checks in the route, which skipped two of
   * them, so Check enabled Draft for a paused campaign and for a person who
   * already had an SMS waiting — and Draft then answered 409.
   */
  describe('the dry run is smsDraft’s own checks', () => {
    const check = (over: Partial<Parameters<typeof smsDraft>[1]> = {}) =>
      smsDraft(db, { orgId, contactId, campaignId, templateId, vars: ['Priya', '3pm'], createdBy: userId, now: NOON_IST, ...over, dryRun: true })
    const outbound = async () => (await db.select().from(schema.touches)).filter((t) => t.direction === 'out')

    it('answers the decision and the words, and writes nothing', async () => {
      expect(await check()).toEqual({
        ok: true,
        body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.',
        decision: { allowed: true, code: 'send_now' },
        wouldNeedApproval: true,
      })
      expect(await db.select().from(schema.touches)).toHaveLength(0)
      expect(await audits('sms.drafted')).toHaveLength(0)
    })

    it('refuses a paused campaign exactly as smsDraft does', async () => {
      await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
      const dry = await check()
      expect(dry).toMatchObject({ ok: false, reason: 'campaign_not_active' })
      expect(dry).toEqual(await draft())
      expect(await outbound()).toHaveLength(0)
    })

    it('refuses a second draft while one is on its way, exactly as smsDraft does', async () => {
      expect((await draft()).ok).toBe(true)
      const dry = await check()
      expect(dry).toMatchObject({ ok: false, reason: 'already_queued' })
      expect(dry).toEqual(await draft())
      expect(await outbound()).toHaveLength(1)
    })

    it('answers a refusal nobody may approve past with the decision, where smsDraft refuses it by its code', async () => {
      await db.delete(schema.consents).where(eq(schema.consents.contactId, contactId))
      const dry = await check()
      expect(dry).toMatchObject({ ok: true, decision: { allowed: false, code: 'cold_channel_forbidden', humanCanResolve: false } })
      expect(await draft()).toMatchObject({ ok: false, reason: 'refused', code: 'cold_channel_forbidden' })
    })

    it('reports a hold a person can resolve as the decision, and smsDraft writes it with the same code', async () => {
      const dry = await check({ now: NIGHT_IST })
      expect(dry).toMatchObject({ ok: true, decision: { allowed: false, code: 'quiet_hours', humanCanResolve: true } })
      const real = await draft({ now: NIGHT_IST })
      expect(real.ok && real.wouldHold?.code).toBe('quiet_hours')
    })

    it('refuses values that do not render with smsDraft’s own sentence and slot', async () => {
      const dry = await check({ vars: ['Priya'] })
      expect(dry).toMatchObject({ ok: false, reason: 'render_failed', slot: 2 })
      expect(dry).toEqual(await draft({ vars: ['Priya'] }))
    })
  })

  // -------------------------------------------------------------------------
  describe('the one send path', () => {
    const approved = async () => {
      const r = await draft()
      if (!r.ok) throw new Error(r.message)
      const a = await approveDraft(db, { orgId, touchId: r.touchId, contactId, campaignId, approvedBy: userId, now: NOON_IST })
      if (!a.ok) throw new Error(a.reason)
      return a.touch
    }

    it('sends an approved draft whose words are its template', async () => {
      const row = await approved()
      const r = await dispatchTouch(db, provider, row, { now: NOON_IST })
      expect(r.sent).toBe(true)
      expect(provider.sent).toEqual([{ to: PHONE, body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.' }])
      // The provider is told the registered pair the operator scrubs against
      // (DLT's tempid and senderid), read from the row — never a caller's say-so.
      expect(provider.registrations).toEqual([
        { externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', language: 'en' },
      ])
      const stored = await touch(row.id)
      expect(stored).toMatchObject({ status: 'sent', providerId: 'ds-1', deliveryStatus: null })
    })

    it('refuses words edited away from the template, and nobody may approve past it', async () => {
      const row = await approved()
      await db.update(schema.touches).set({ body: 'Hi Priya, call me now!' }).where(eq(schema.touches.id, row.id))
      const r = await dispatchTouch(db, provider, await touch(row.id), { now: NOON_IST })
      expect(r.decision).toMatchObject({ allowed: false, code: 'template_mismatch', humanCanResolve: false })
      expect(provider.sent).toEqual([])
      expect(await touch(row.id)).toMatchObject({ status: 'refused', refusalCode: 'template_mismatch' })
    })

    it('refuses a draft whose template was deactivated since', async () => {
      const row = await approved()
      await templatesSetActive(db, { orgId, templateId, active: false, actor: userId })
      const r = await dispatchTouch(db, provider, row, { now: NOON_IST })
      expect(r.decision).toMatchObject({ allowed: false, code: 'no_template' })
      expect(provider.sent).toEqual([])
    })

    it('holds a promotional SMS outside TRAI’s band as quiet hours', async () => {
      const [promo] = await db
        .insert(schema.messageTemplates)
        .values({ orgId, channel: 'sms', externalId: '1107160000000099999', senderId: '123456', category: 'promotional', body: 'Offer for {#var#}' })
        .returning({ id: schema.messageTemplates.id })
      const r = await draft({ templateId: promo!.id, vars: ['Priya'] })
      if (!r.ok) throw new Error(r.message)
      const a = await approveDraft(db, { orgId, touchId: r.touchId, contactId, campaignId, approvedBy: userId })
      if (!a.ok) throw new Error(a.reason)
      const d = await dispatchTouch(db, provider, a.touch, { now: NINE_IST })
      expect(d.decision).toMatchObject({ allowed: false, code: 'quiet_hours', humanCanResolve: true })
      if (!d.decision.allowed) expect(d.decision.reason).toMatch(/TRAI/)
      expect(provider.sent).toEqual([])
    })

    it('previews a stored draft by its own words, and a person-level check by the active templates', async () => {
      const r = await draft()
      if (!r.ok) throw new Error(r.message)
      const row = await touch(r.touchId)
      const stored = await previewSend(db, { orgId, contactId, campaignId, now: NOON_IST, writtenAt: { touchId: row.id, writtenAt: row.createdAt } })
      expect(stored.ok && stored.facts.template).toEqual({ source: 'message', active: true, matches: true, category: 'service_explicit' })

      const person = await previewSend(db, { orgId, contactId, campaignId, now: NOON_IST })
      expect(person.ok && person.facts.template).toMatchObject({ source: 'any_active', active: true, activeOnChannel: 1 })
      expect(person.ok && person.decision.allowed).toBe(true)

      await templatesSetActive(db, { orgId, templateId, active: false, actor: userId })
      const none = await previewSend(db, { orgId, contactId, campaignId, now: NOON_IST })
      expect(none.ok && none.facts.template).toMatchObject({ source: 'any_active', active: false, activeOnChannel: 0 })
      expect(none.ok && !none.decision.allowed && none.decision.code).toBe('no_template')
    })

    it('records a free-text SMS from sendOne as refused, never queued without a template', async () => {
      const { sendOne } = await import('../src/index.js')
      const r = await sendOne(db, provider, { orgId, campaignId, contactId, subject: '', body: 'hello', now: NOON_IST })
      expect(r).toMatchObject({ sent: false, decision: { code: 'no_template', humanCanResolve: false } })
      expect(provider.sent).toEqual([])
      expect(await touch(r.touchId!)).toMatchObject({ status: 'refused', refusalCode: 'no_template', templateId: null })
    })
  })

  // -------------------------------------------------------------------------
  describe('delivery reports', () => {
    const sentSms = async (providerId = 'ds-msg-1') => {
      const [row] = await db
        .insert(schema.touches)
        .values({
          orgId, campaignId, contactId, companyId, channel: 'sms', direction: 'out', status: 'sent', templateId,
          body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.', recipient: PHONE, providerId, sentAt: NOON_IST,
        })
        .returning({ id: schema.touches.id })
      return row!.id
    }

    it('records DELIVRD beside status, which stays the send path’s word', async () => {
      const id = await sentSms()
      const at = new Date('2026-09-15T06:31:00.000Z')
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'delivered', at })).toEqual({
        matched: true, orgId, touchId: id, changed: true, deliveryStatus: 'delivered',
      })
      expect(await touch(id)).toMatchObject({ status: 'sent', deliveryStatus: 'delivered', deliveredAt: at, deliveryError: null })
    })

    it('is idempotent, and a final word is never replaced', async () => {
      const id = await sentSms()
      await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'delivered', at: NOON_IST })
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'delivered', at: NIGHT_IST })).toMatchObject({ changed: false, deliveryStatus: 'delivered' })
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'failed', reason: 'late' })).toMatchObject({ changed: false, deliveryStatus: 'delivered' })
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'pending' })).toMatchObject({ changed: false })
      expect(await touch(id)).toMatchObject({ deliveryStatus: 'delivered', deliveredAt: NOON_IST })
    })

    it('moves pending to a final word, and records a failure’s reason bounded', async () => {
      const id = await sentSms()
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'pending' })).toMatchObject({ changed: true })
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'failed', reason: `UNDELIV ${'x'.repeat(400)}` })).toMatchObject({ changed: true, deliveryStatus: 'failed' })
      const row = await touch(id)
      expect(row.deliveryStatus).toBe('failed')
      expect(row.deliveryError?.startsWith('UNDELIV')).toBe(true)
      expect(row.deliveryError?.length).toBe(300)
      expect(row.status).toBe('sent')
    })

    it('says a failure with no reason gave none, rather than inventing one', async () => {
      const id = await sentSms()
      await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'failed', reason: '  ' })
      expect((await touch(id)).deliveryError).toBe('failed (the report gave no reason)')
    })

    it('is never an opt-out: a failed delivery suppresses and pauses nobody', async () => {
      await sentSms()
      await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'failed', reason: 'UNDELIV' })
      expect(await db.select().from(schema.suppressions)).toHaveLength(0)
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      expect(c!.pausedAt).toBeNull()
    })

    it('audits an id nothing was sent with in the org named, and changes nothing', async () => {
      const id = await sentSms()
      expect(await recordSmsDelivery(db, { providerMessageId: 'unknown-id', status: 'delivered', orgId })).toEqual({ matched: false, why: 'unknown_id' })
      const [a] = await audits('sms.delivery_unmatched')
      expect(a).toMatchObject({ orgId, detail: { why: 'unknown_id', status: 'delivered' } })
      expect(JSON.stringify(a)).not.toContain('unknown-id')
      expect((await touch(id)).deliveryStatus).toBeNull()
    })

    it('returns an unknown id for the caller to log when no org is named', async () => {
      expect(await recordSmsDelivery(db, { providerMessageId: 'unknown-id', status: 'delivered' })).toEqual({ matched: false, why: 'unknown_id' })
      expect(await audits('sms.delivery_unmatched')).toHaveLength(0)
    })

    it('does not match an email or an inbound row that happens to carry the id', async () => {
      await db.insert(schema.touches).values({
        orgId, contactId, channel: 'email', direction: 'out', status: 'sent', providerId: 'ds-msg-1', sentAt: NOON_IST,
      })
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'delivered' })).toMatchObject({ matched: false })
    })

    it('refuses a blank id', async () => {
      expect(await recordSmsDelivery(db, { providerMessageId: '  ', status: 'delivered' })).toEqual({ matched: false, why: 'blank_id' })
    })

    /** Postgres refuses U+0000 in text: a report carrying one failed its UPDATE on every retry. */
    it('records a failure whose reason carries U+0000, and matches nothing by an id carrying one', async () => {
      const id = await sentSms()
      const r = await recordSmsDelivery(db, { providerMessageId: 'ds-msg-1', status: 'failed', reason: 'Absent\u0000subscriber' })
      expect(r).toMatchObject({ matched: true, changed: true, deliveryStatus: 'failed' })
      expect((await touch(id)).deliveryError).toBe('Absent\uFFFDsubscriber')
      expect(await recordSmsDelivery(db, { providerMessageId: 'ds-msg-\u00001', status: 'delivered' })).toEqual({ matched: false, why: 'unknown_id' })
    })
  })

  // -------------------------------------------------------------------------
  describe('a text a contact sends back', () => {
    const log = (): InboundLog & { lines: string[] } => {
      const lines: string[] = []
      return { lines, error: (m) => lines.push(m) }
    }
    const inbound = (over: Partial<Parameters<typeof recordInboundSms>[1]> = {}) =>
      recordInboundSms(db, { from: PHONE, to: '+919000000000', text: 'Sounds good, see you then', providerMessageId: 'mo-1', receivedAt: NOON_IST, ...over })

    it('records the reply, pauses them, cancels what was queued and moves the deal to replied', async () => {
      const d = await draft()
      if (!d.ok) throw new Error(d.message)
      const r = await inbound()
      expect(r).toMatchObject({ matched: 'contact', orgId, contactId, duplicate: false, paused: true, suppressed: false, cancelled: 1, optOutNotRecorded: false })
      if (r.matched !== 'contact') return
      expect(await touch(r.touchId)).toMatchObject({ channel: 'sms', direction: 'in', status: 'replied', recipient: PHONE, providerId: 'mo-1' })
      expect(await touch(d.touchId)).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
      const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
      expect(deal?.stage).toBe('replied')
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      expect(pauseReasonClass(c!.pausedReason)).toBe('replied')
    })

    it.each(['STOP', 'stop 56161', 'UNSUBSCRIBE', 'Cancel', 'please remove me'])(
      'reads %j as an opt-out and writes the phone suppression, source reply',
      async (text) => {
        const r = await inbound({ text })
        expect(r).toMatchObject({ matched: 'contact', suppressed: true, replyKind: 'opted_out', optOutNotRecorded: false })
        const rows = await db.select().from(schema.suppressions)
        expect(rows).toEqual([expect.objectContaining({ orgId, kind: 'phone', value: PHONE, source: 'reply' })])
      },
    )

    it('matches a number stored with spaces', async () => {
      await db.update(schema.contacts).set({ phone: '+91 98765-43210' }).where(eq(schema.contacts.id, contactId))
      expect(await inbound({ from: '0091 98765 43210' })).toMatchObject({ matched: 'contact', contactId })
    })

    it('records a provider’s retry once', async () => {
      const first = await inbound({ text: 'STOP' })
      const again = await inbound({ text: 'STOP' })
      expect(again).toMatchObject({ matched: 'contact', duplicate: true, replyKind: 'opted_out', optOutNotRecorded: false })
      if (first.matched === 'contact' && again.matched === 'contact') expect(again.touchId).toBe(first.touchId)
      const rows = (await db.select().from(schema.touches)).filter((t) => t.direction === 'in')
      expect(rows).toHaveLength(1)
    })

    /**
     * Review round 5: two deliveries of one STOP both read "not seen". The
     * winner records it with its suppression; the loser's INSERT meets
     * 0019's unique index and is answered as the duplicate it is — and it
     * also said "OPT-OUT NOT RECORDED … follow up by hand" about an opt-out
     * that WAS recorded, which teaches a person to skip the true alarm.
     */
    it('says nothing about a raced duplicate of a STOP the winner recorded', async () => {
      const l = log()
      const both = await Promise.all([inbound({ text: 'STOP', log: l }), inbound({ text: 'STOP', log: l })])
      expect(both.map((r) => r.matched === 'contact' && r.duplicate).sort()).toEqual([false, true])
      expect(await db.select().from(schema.suppressions)).toEqual([expect.objectContaining({ orgId, kind: 'phone', value: PHONE })])
      expect(l.lines).toEqual([])
    })

    it('rolls a raced duplicate back without the not-recorded line, and still says it for any other fault', async () => {
      await inbound({ text: 'STOP' })
      const l = log()
      const again = { orgId, contactId, channel: 'sms' as const, from: PHONE, subject: null, body: 'STOP', providerId: 'mo-1', now: NOON_IST, log: l }
      await expect(recordInboundReply(db, again)).rejects.toThrow()
      expect(l.lines).toEqual([])
      // A refusal that is NOT the duplicate's index is still loud.
      const flaky = throughTransactions(db, {
        get(target, prop, receiver) {
          if (prop === 'update') return () => { throw new Error('Connection terminated unexpectedly') }
          return Reflect.get(target, prop, receiver)
        },
      })
      await expect(recordInboundReply(flaky, { ...again, providerId: 'mo-3' })).rejects.toThrow('Connection terminated')
      expect(l.lines).toEqual([expect.stringContaining('OPT-OUT NOT RECORDED')])
    })

    it('takes the loud path when the suppression write throws', async () => {
      // Through every transaction: the reply is one transaction and the
      // suppression a savepoint inside it, which a Proxy over `db` alone
      // never reaches.
      const flaky = throughTransactions(db, {
        get(target, prop, receiver) {
          if (prop === 'insert') {
            return (table: unknown) => {
              if (table === schema.suppressions) throw new Error('Connection terminated unexpectedly')
              return (target as AgencyDb).insert(table as typeof schema.touches)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const l = log()
      const r = await recordInboundSms(flaky, { from: PHONE, text: 'STOP', providerMessageId: 'mo-9', receivedAt: NOON_IST, log: l })
      expect(r).toMatchObject({ matched: 'contact', suppressed: false, optOutNotRecorded: true, replyKind: 'opted_out' })
      expect(l.lines.some((m) => m.includes('OPT-OUT NOT RECORDED'))).toBe(true)
      const [a] = await audits('contact.opt_out_not_recorded')
      expect(a).toMatchObject({ subjectId: contactId, detail: { channel: 'sms', why: 'Error' } })
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      expect(pauseReasonClass(c!.pausedReason)).toBe('opt_out_not_recorded')
      expect(JSON.stringify(a)).not.toContain(PHONE)
    })

    describe('a number that is not one person', () => {
      let otherOrgId: string
      let otherContactId: string
      beforeEach(async () => {
        const [o] = await db.insert(schema.orgs).values({ name: 'Other agency' }).returning({ id: schema.orgs.id })
        otherOrgId = o!.id
        const [co] = await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'rentman.in' }).returning({ id: schema.companies.id })
        const [ct] = await db
          .insert(schema.contacts)
          .values({ orgId: otherOrgId, companyId: co!.id, phone: PHONE })
          .returning({ id: schema.contacts.id })
        otherContactId = ct!.id
      })

      /** What this system sent to a contact at the number: the evidence a reply is theirs. */
      const texted = async (org: string, contact: string) => {
        await db.insert(schema.touches).values({
          orgId: org, contactId: contact, channel: 'sms', direction: 'out', status: 'sent',
          body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.', recipient: PHONE,
          sentAt: new Date(NOON_IST.getTime() - 86_400_000), providerId: `ds-${contact}`,
        })
      }
      const contactRow = async (id: string) => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!
      const inboundRows = async () => (await db.select().from(schema.touches)).filter((t) => t.direction === 'in')

      /**
       * Review round 5: a text from a number two contacts held was dropped
       * whole — nobody paused, nothing cancelled — so an approved SMS to
       * that person still went on the next tick. Pausing needs no
       * attribution: each of them is held, and the reply is still filed
       * under nobody. Review round 6: held as a HOLD — a reason that is not
       * a reply's, and a cancel that is not their refusal.
       */
      it('files a reply two orgs could own under nobody, but pauses each holder and audits it in each', async () => {
        const d = await draft()
        if (!d.ok) throw new Error(d.message)
        const r = await inbound()
        expect(r).toEqual({ matched: 'none', why: 'ambiguous', optOut: false, suppressed: false, optOutNotRecorded: false, optOutNotRecordedIn: [] })
        expect(await inboundRows()).toHaveLength(0)
        const rows = await audits('sms.inbound_unmatched')
        expect(rows.map((a) => a.orgId).sort()).toEqual([orgId, otherOrgId].sort())
        for (const a of rows) {
          expect(a.detail).toEqual({
            why: 'ambiguous', optOut: false, contacts: 1, paused: 1, cancelledQueued: a.orgId === orgId ? 1 : 0,
            messageHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          })
          expect(JSON.stringify(a)).not.toContain(PHONE)
          expect(JSON.stringify(a)).not.toContain('mo-1')
        }
        for (const id of [contactId, otherContactId]) {
          const c = await contactRow(id)
          expect(c.pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
          expect(pauseReasonClass(c.pausedReason)).toBe('other')
        }
        // The approved text does not go on the next tick.
        expect(await touch(d.touchId)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
        // A pause already in place keeps its own reason, as a reply's does.
        await db.update(schema.contacts).set({ pausedReason: 'held by a teammate' }).where(eq(schema.contacts.id, contactId))
        await inbound({ providerMessageId: 'mo-2' })
        expect((await contactRow(contactId)).pausedReason).toBe('held by a teammate')
      })

      /**
       * Review round 6: the reply is filed under the one holder this system
       * texted — and the other holder, in another org, is HELD, not left
       * live: their approved text would otherwise go to the number that just
       * replied. The other org is told, by counts, that it was filed under a
       * contact elsewhere.
       */
      it('files a reply under the one holder this system texted, and holds the other', async () => {
        await texted(otherOrgId, otherContactId)
        const d = await draft()
        if (!d.ok) throw new Error(d.message)
        const r = await inbound()
        expect(r).toMatchObject({ matched: 'contact', orgId: otherOrgId, contactId: otherContactId, paused: true, duplicate: false })
        expect(await inboundRows()).toEqual([expect.objectContaining({ orgId: otherOrgId, contactId: otherContactId, channel: 'sms' })])
        expect(pauseReasonClass((await contactRow(otherContactId)).pausedReason)).toBe('replied')
        expect((await contactRow(contactId)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
        expect(await touch(d.touchId)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
        expect((await audits('sms.inbound_unmatched')).map((a) => [a.orgId, a.detail])).toEqual([
          [orgId, { why: 'ambiguous', optOut: false, contacts: 1, paused: 1, cancelledQueued: 1, filedUnder: 'another_org' }],
        ])
      })

      it('still suppresses a STOP filed under the one it texted in every org that holds the number', async () => {
        await texted(orgId, contactId)
        const r = await inbound({ text: 'STOP' })
        expect(r).toMatchObject({ matched: 'contact', orgId, contactId, suppressed: true, optOutNotRecorded: false })
        const rows = await db.select().from(schema.suppressions)
        expect(rows.map((s) => [s.orgId, s.kind, s.value, s.source]).sort()).toEqual(
          [[orgId, 'phone', PHONE, 'reply'], [otherOrgId, 'phone', PHONE, 'reply']].sort(),
        )
        const [a] = await audits('sms.inbound_unmatched')
        expect(a).toMatchObject({ orgId: otherOrgId, detail: { why: 'ambiguous', optOut: true, contacts: 1, suppressed: true } })
      })

      /**
       * Review round 6, findings [1] and [5]: every org's texts go out
       * through the one DoveSoft account, so the deployment's org is no
       * evidence of whose text was answered. It used to be preferred, and
       * the other org's texted contact was left live.
       */
      it('files nothing under either when both were texted, whatever org the deployment names, and holds both', async () => {
        await texted(orgId, contactId)
        await texted(otherOrgId, otherContactId)
        expect(await inbound({ orgId: otherOrgId })).toMatchObject({ matched: 'none', why: 'ambiguous' })
        expect(await inboundRows()).toHaveLength(0)
        for (const id of [contactId, otherContactId]) {
          expect((await contactRow(id)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
        }
      })

      it('holds both, and files nothing, when both were texted and the deployment names neither org', async () => {
        await texted(orgId, contactId)
        await texted(otherOrgId, otherContactId)
        expect(await inbound()).toMatchObject({ matched: 'none', why: 'ambiguous' })
        expect(await inboundRows()).toHaveLength(0)
        expect((await contactRow(contactId)).pausedAt).not.toBeNull()
        expect((await contactRow(otherContactId)).pausedAt).not.toBeNull()
      })

      /**
       * The probe's own case: one person on file twice in ONE org (a work
       * and a personal row), sharing a mobile, an SMS drafted and approved
       * to one of them, and a reply that is not a STOP.
       */
      it('holds both of two contacts in one org who share the number, and cancels the approved text', async () => {
        await db.delete(schema.contacts).where(eq(schema.contacts.id, otherContactId))
        const [twin] = await db
          .insert(schema.contacts)
          .values({ orgId, companyId, firstName: 'Priya (personal)', phone: PHONE })
          .returning({ id: schema.contacts.id })
        const d = await draft()
        if (!d.ok) throw new Error(d.message)
        expect(await approveDraft(db, { orgId, touchId: d.touchId, contactId, campaignId, approvedBy: userId, now: NOON_IST }))
          .toMatchObject({ ok: true })
        const r = await inbound({ text: 'Who is this? Not interested, please do not message again' })
        expect(r).toEqual({ matched: 'none', why: 'ambiguous', optOut: false, suppressed: false, optOutNotRecorded: false, optOutNotRecordedIn: [] })
        for (const id of [contactId, twin!.id]) expect(pauseReasonClass((await contactRow(id)).pausedReason)).toBe('other')
        expect(await touch(d.touchId)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
        const [a] = await audits('sms.inbound_unmatched')
        expect(a).toMatchObject({ orgId, detail: { why: 'ambiguous', contacts: 2, paused: 2, cancelledQueued: 1 } })
        // What the sender would now say about Priya: held, never send-now.
        const now = await previewSend(db, { orgId, contactId, campaignId, now: NOON_IST })
        expect(now.ok && !now.decision.allowed && now.decision.code).toBe('paused')
      })

      it('files a reply under the one of two in one org it texted', async () => {
        await db.delete(schema.contacts).where(eq(schema.contacts.id, otherContactId))
        const [twin] = await db
          .insert(schema.contacts)
          .values({ orgId, companyId, firstName: 'Priya (personal)', phone: PHONE })
          .returning({ id: schema.contacts.id })
        await texted(orgId, twin!.id)
        expect(await inbound()).toMatchObject({ matched: 'contact', orgId, contactId: twin!.id })
        // Review round 6: the twin it did not text is held, not left live.
        expect((await contactRow(contactId)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
        const [a] = await audits('sms.inbound_unmatched')
        expect(a).toMatchObject({ orgId, detail: { contacts: 1, paused: 1, filedUnder: 'another_contact' } })
      })

      it('still records an opt-out from it, as a phone suppression in every org that holds the number', async () => {
        const r = await inbound({ text: 'STOP' })
        expect(r).toEqual({ matched: 'none', why: 'ambiguous', optOut: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] })
        const rows = await db.select().from(schema.suppressions)
        expect(rows.map((s) => [s.orgId, s.kind, s.value, s.source]).sort()).toEqual(
          [[orgId, 'phone', PHONE, 'reply'], [otherOrgId, 'phone', PHONE, 'reply']].sort(),
        )
      })

      /**
       * The deployment's org is a FALLBACK, not a filter: drafting and
       * sending are not scoped to it, so a reply read only inside it lost a
       * STOP from a person another org had texted.
       */
      it('does not narrow the match to the org the deployment names — two orgs holding it is still ambiguous', async () => {
        const r = await inbound({ orgId: otherOrgId, text: 'STOP' })
        expect(r).toEqual({ matched: 'none', why: 'ambiguous', optOut: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] })
        const rows = await db.select().from(schema.suppressions)
        expect(rows.map((s) => s.orgId).sort()).toEqual([orgId, otherOrgId].sort())
        expect(otherContactId).toBeTruthy()
      })
    })

    describe('across orgs, with DOVESOFT_ORG_ID as the fallback', () => {
      let fallbackOrgId: string
      beforeEach(async () => {
        const [o] = await db.insert(schema.orgs).values({ name: 'The DoveSoft account’s org' }).returning({ id: schema.orgs.id })
        fallbackOrgId = o!.id
      })

      it('files a STOP from a number one contact in another org holds under that contact, and suppresses it THERE', async () => {
        const r = await inbound({ text: 'STOP', orgId: fallbackOrgId })
        expect(r).toMatchObject({ matched: 'contact', orgId, contactId, suppressed: true, optOutNotRecorded: false })
        const rows = await db.select().from(schema.suppressions)
        expect(rows).toEqual([expect.objectContaining({ orgId, kind: 'phone', value: PHONE, source: 'reply' })])
        const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
        expect(c!.pausedAt).not.toBeNull()
        expect(await audits('sms.inbound_unmatched')).toEqual([])
      })

      it('files an ordinary reply under that contact too, and cancels what was queued for them', async () => {
        const d = await draft()
        if (!d.ok) throw new Error(d.message)
        expect(await inbound({ orgId: fallbackOrgId })).toMatchObject({ matched: 'contact', orgId, contactId, cancelled: 1 })
      })

      it('files a number no contact anywhere holds under the fallback org', async () => {
        const r = await inbound({ from: '+919811111111', text: 'STOP', orgId: fallbackOrgId })
        expect(r).toEqual({ matched: 'none', why: 'no_contact', optOut: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] })
        expect(await db.select().from(schema.suppressions)).toEqual([
          expect.objectContaining({ orgId: fallbackOrgId, value: '+919811111111', source: 'reply' }),
        ])
        expect((await audits('sms.inbound_unmatched')).map((a) => a.orgId)).toEqual([fallbackOrgId])
      })
    })

    /**
     * Some SMPP gateways decode GSM-7 `@` as U+0000, and Postgres refuses it
     * in text: every retry failed, and a STOP sent that way was recorded
     * nowhere. It is stored as U+FFFD.
     */
    it('records a text carrying U+0000, with the character kept visible', async () => {
      const words = 'STOP\nmy name is Jo, jo\u0000example.in'
      const r = await inbound({ text: words, providerMessageId: 'mo-\u0000-1' })
      expect(r).toMatchObject({ matched: 'contact', contactId, replyKind: 'opted_out', suppressed: true })
      if (r.matched !== 'contact') return
      const row = await touch(r.touchId)
      expect(row.body).toBe('STOP\nmy name is Jo, jo\uFFFDexample.in')
      expect(row.providerId).toBe('mo-\uFFFD-1')
      expect(await db.select().from(schema.suppressions)).toEqual([expect.objectContaining({ orgId, value: PHONE, source: 'reply' })])
      // A retry of the same push is a duplicate, not a second row.
      expect(await inbound({ text: words, providerMessageId: 'mo-\u0000-1' })).toMatchObject({ duplicate: true })
    })

    it('reads a STOP the way the recorder does, for a caller whose recording failed', () => {
      expect(smsTextAsksToStop('STOP')).toBe(true)
      expect(smsTextAsksToStop('stop 56161')).toBe(true)
      expect(smsTextAsksToStop('please remove me')).toBe(true)
      expect(smsTextAsksToStop('Sounds good, see you then')).toBe(false)
      expect(smsTextAsksToStop(null)).toBe(false)
    })

    it('audits a number no contact has in the org the deployment names, and records an opt-out from it there', async () => {
      const r = await inbound({ from: '+919811111111', text: 'STOP', orgId })
      expect(r).toEqual({ matched: 'none', why: 'no_contact', optOut: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] })
      expect(await db.select().from(schema.suppressions)).toEqual([expect.objectContaining({ orgId, value: '+919811111111', source: 'reply' })])
      expect((await audits('sms.inbound_unmatched'))[0]?.detail).toEqual({
        why: 'no_contact', optOut: true, contacts: 0, suppressed: true, messageHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    })

    it('is loud about an opt-out from a number no contact has when no org is named', async () => {
      const l = log()
      const r = await inbound({ from: '+919811111111', text: 'STOP', log: l })
      expect(r).toMatchObject({ matched: 'none', why: 'no_contact', optOutNotRecorded: true })
      expect(l.lines.some((m) => m.includes('OPT-OUT NOT RECORDED'))).toBe(true)
    })

    it('is loud about an opt-out from a number it cannot read, and never guesses its country', async () => {
      const l = log()
      const r = await inbound({ from: '9876543210', text: 'STOP', orgId, log: l })
      expect(r).toEqual({
        matched: 'none', why: 'unreadable_number', optOut: true, suppressed: false, optOutNotRecorded: true,
        optOutNotRecordedIn: [{ orgId, contactId: null }],
      })
      expect(l.lines.some((m) => m.includes('OPT-OUT NOT RECORDED'))).toBe(true)
      expect(await audits('contact.opt_out_not_recorded')).toEqual([expect.objectContaining({ orgId, subjectId: null })])
      expect(await db.select().from(schema.suppressions)).toHaveLength(0)
      // /audit claims a suppression only where the row says one was written.
      expect((await audits('sms.inbound_unmatched'))[0]?.detail).toEqual({ why: 'unreadable_number', optOut: true, suppressed: false })
    })

    it('drops an ordinary text from a number it cannot read without alarm', async () => {
      const l = log()
      expect(await inbound({ from: 'ACMEIN', log: l })).toMatchObject({ matched: 'none', why: 'unreadable_number', optOutNotRecorded: false })
      expect(l.lines).toEqual([])
    })
  })
})
