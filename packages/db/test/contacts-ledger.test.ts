/**
 * §2.1: "they said no" is never re-asked, and never overwritten by a grant.
 *
 * `recordConsent` in contacts.ts is an upsert, so the rule has to live in
 * the writer the ledger uses. Every case here is a member with
 * contacts:write posting a form, and the last one is the ONLY way a
 * refusal leaves the table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { decideSend } from '@agency/core'
import { contactsLiftRefusal, contactsRecordConsent, schema, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('the consent ledger writers', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db.insert(schema.companies).values({ orgId, domain: 'rentman.io' }).returning({ id: schema.companies.id })
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, email: 'priya@rentman.io', phone: '+14155550100' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const row = async (channel: string) =>
    (await db.select().from(schema.consents).where(eq(schema.consents.contactId, contactId))).find((c) => c.channel === channel)

  it('records a first answer, and says nobody had asked before', async () => {
    const r = await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: true, source: 'booking form' })
    expect(r).toEqual({ ok: true, previous: 'never_asked' })
    expect((await row('sms'))?.granted).toBe(true)
  })

  it('records a refusal over a grant — they said no now', async () => {
    await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: true, source: 'booking form' })
    const r = await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply 2026-09-02' })
    expect(r).toEqual({ ok: true, previous: 'granted' })
    expect((await row('sms'))?.granted).toBe(false)
  })

  /**
   * THE test. Without it, any member could turn a no into a yes with one
   * POST, and the send path — which trusts the row — would allow SMS and
   * voice to a person who said no.
   */
  it('REFUSES a grant over a refusal, and leaves the refusal in place', async () => {
    await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply 2026-09-02' })
    const r = await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: true, source: 'a form, later' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('refused_is_final')
    expect(r.message).toMatch(/owner/)
    const after = await row('sms')
    expect(after?.granted).toBe(false)
    expect(after?.source).toBe('reply 2026-09-02')
  })

  it('records a second refusal over a refusal, with its own evidence', async () => {
    await contactsRecordConsent(db, { orgId, contactId, channel: 'voice', granted: false, source: 'call 1' })
    const r = await contactsRecordConsent(db, { orgId, contactId, channel: 'voice', granted: false, source: 'call 2', evidence: { said: 'no again' } })
    expect(r).toEqual({ ok: true, previous: 'refused' })
    expect((await row('voice'))?.source).toBe('call 2')
  })

  it('keeps channels apart: a refused SMS says nothing about email', async () => {
    await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply' })
    const r = await contactsRecordConsent(db, { orgId, contactId, channel: 'email', granted: true, source: 'webform' })
    expect(r.ok).toBe(true)
  })

  it('refuses a blank source, and a contact in another org', async () => {
    expect((await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: true, source: '  ' })).ok).toBe(false)
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    const r = await contactsRecordConsent(db, { orgId: other!.id, contactId, channel: 'sms', granted: true, source: 'form' })
    expect(r).toMatchObject({ ok: false, reason: 'no_such_contact' })
    expect(await row('sms')).toBeUndefined()
  })

  describe('lifting a refusal', () => {
    it('is the one way a refusal goes, returns the person to never-asked, and is audited by name', async () => {
      await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply' })
      const lifted = await contactsLiftRefusal(db, { orgId, contactId, channel: 'sms', actorUserId: userId, reason: 'they wrote in asking to be contacted again' })
      expect(lifted).toEqual({ ok: true })
      // Lifting is not a grant: the row is gone, and absence is NO.
      expect(await row('sms')).toBeUndefined()
      const audit = await db.select().from(schema.auditLog)
      const entry = audit.find((a) => a.action === 'consent.refusal_lifted')
      expect(entry?.actor).toBe(userId)
      expect(entry?.subjectId).toBe(contactId)
      expect(JSON.stringify(entry?.detail)).toContain('asking to be contacted again')
      expect(JSON.stringify(entry?.detail)).not.toContain('priya@rentman.io')
      // Only now can a new grant be recorded.
      const r = await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: true, source: 'their email, 2026-09-20' })
      expect(r).toEqual({ ok: true, previous: 'never_asked' })
    })

    it('refuses to lift a grant, a missing row, or with no reason', async () => {
      expect(await contactsLiftRefusal(db, { orgId, contactId, channel: 'sms', actorUserId: userId, reason: 'x' })).toMatchObject({ ok: false, reason: 'no_refusal' })
      await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: true, source: 'form' })
      expect(await contactsLiftRefusal(db, { orgId, contactId, channel: 'sms', actorUserId: userId, reason: 'x' })).toMatchObject({ ok: false, reason: 'no_refusal' })
      expect((await row('sms'))?.granted).toBe(true)
      await contactsRecordConsent(db, { orgId, contactId, channel: 'voice', granted: false, source: 'call' })
      expect(await contactsLiftRefusal(db, { orgId, contactId, channel: 'voice', actorUserId: userId, reason: '  ' })).toMatchObject({ ok: false, reason: 'blank_reason' })
      expect((await row('voice'))?.granted).toBe(false)
      expect((await db.select().from(schema.auditLog)).filter((a) => a.action === 'consent.refusal_lifted')).toHaveLength(0)
    })
  })

  /**
   * The point of the rule, end to end: after a refusal that a grant could
   * not overwrite, the send path still refuses the channel.
   */
  it('keeps the send path refusing after a grant was attempted over a refusal', async () => {
    await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply' })
    await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: true, source: 'form' })
    const consent = await row('sms')
    const decision = decideSend({
      channel: 'sms',
      recipient: '+14155550100',
      suppressed: false,
      consent: consent ? { granted: consent.granted, source: consent.source } : null,
      recipientTimeZone: 'America/Los_Angeles',
      quietStart: '21:00',
      quietEnd: '08:00',
      sentToday: 0,
      dailyCap: 10,
      autoSend: false,
      approvedByHuman: true,
      campaignStatus: 'active',
      now: new Date('2026-09-15T19:00:00.000Z'),
    })
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    // SMS with no GRANTED consent is cold, and cold SMS is refused one step
    // before the consent check — by a rule no approver can click past.
    expect(decision.code).toBe('cold_channel_forbidden')
    expect(decision.humanCanResolve).toBe(false)
  })
})
