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
import {
  addSuppression, consentLedgerFor, contactsConsentUpsert, contactsLedger, contactsLiftRefusal, contactsRecordConsent,
  contactsUpdate, contactPatchInput, previewSend, schema, type AgencyDb,
} from '../src/index.js'
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

  /**
   * The race the pre-check cannot close: a grant reads "never asked", a
   * refusal commits, and the grant's upsert lands. PGlite is one session, so
   * the interleaving cannot be produced here; what can be shown is that the
   * STATEMENT refuses the grant with the pre-check out of the way, which is
   * exactly the position the losing writer is in. Before the fix the upsert
   * had an unconditional DO UPDATE and this left `granted = true`.
   */
  describe('the upsert keeps the rule on its own', () => {
    it('refuses a grant over a stored refusal with the pre-check skipped, and the refusal survives', async () => {
      await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply 2026-09-02' })
      const r = await contactsConsentUpsert(db, { orgId, contactId, channel: 'sms', granted: true, source: 'form, racing' })
      expect(r).toBe('refused_is_final')
      const after = await row('sms')
      expect(after?.granted).toBe(false)
      expect(after?.source).toBe('reply 2026-09-02')
    })

    it('still writes a first answer, a grant over a grant, a refusal over a grant and a second refusal', async () => {
      expect(await contactsConsentUpsert(db, { orgId, contactId, channel: 'sms', granted: true, source: 'form 1' })).toBe('written')
      expect(await contactsConsentUpsert(db, { orgId, contactId, channel: 'sms', granted: true, source: 'form 2' })).toBe('written')
      expect((await row('sms'))?.source).toBe('form 2')
      expect(await contactsConsentUpsert(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply' })).toBe('written')
      expect(await contactsConsentUpsert(db, { orgId, contactId, channel: 'sms', granted: false, source: 'call' })).toBe('written')
      const after = await row('sms')
      expect(after?.granted).toBe(false)
      expect(after?.source).toBe('call')
    })
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

    /**
     * The DELETE and its audit row are one act. Before, the DELETE committed
     * on its own and an audit write that then failed left the refusal gone
     * with nothing on the record saying who lifted it or why.
     */
    it('leaves the refusal in place when its audit row cannot be written', async () => {
      await contactsRecordConsent(db, { orgId, contactId, channel: 'sms', granted: false, source: 'reply' })
      await test.pg.exec(`
        CREATE FUNCTION test_refuse_lift_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'consent.refusal_lifted' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_refuse_lift_audit BEFORE INSERT ON audit_log
          FOR EACH ROW EXECUTE FUNCTION test_refuse_lift_audit();
      `)
      await expect(
        contactsLiftRefusal(db, { orgId, contactId, channel: 'sms', actorUserId: userId, reason: 'asked to be contacted' }),
      ).rejects.toThrow()
      expect((await row('sms'))?.granted).toBe(false)
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
      evidenceStale: false,
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


/**
 * The ledger read and the contact edit.
 *
 * The edit's one rule worth a paragraph: a suppression is keyed by VALUE, so
 * editing a suppressed address away would leave the opt-out matching nobody
 * and make the new address sendable. The last block drives that through the
 * sender's own dry run, because "the row is still there" is not the claim —
 * "the send path still refuses this person" is.
 */
describe('the contacts ledger and the contact edit', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let rentmanId: string
  let acmeId: string
  let priyaId: string
  let samId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [rentman] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/Amsterdam' })
      .returning({ id: schema.companies.id })
    rentmanId = rentman!.id
    const [acme] = await db.insert(schema.companies).values({ orgId, domain: 'acme.test' }).returning({ id: schema.companies.id })
    acmeId = acme!.id
    const [priya] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: rentmanId, firstName: 'Priya', lastName: 'Shah', title: 'CTO', email: 'priya@rentman.io', phone: '+14155550100' })
      .returning({ id: schema.contacts.id })
    priyaId = priya!.id
    const [sam] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: acmeId, firstName: 'Sam', email: 'sam@acme.test', timeZone: 'America/New_York', pausedAt: new Date(), pausedReason: 'replied' })
      .returning({ id: schema.contacts.id })
    samId = sam!.id
    const [theirs] = await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.io' }).returning({ id: schema.companies.id })
    await db.insert(schema.contacts).values({ orgId: otherOrgId, companyId: theirs!.id, firstName: 'Priya', email: 'priya@theirs.io' })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  describe('contactsLedger', () => {
    it('lists this org’s people with their company, and nobody from another org', async () => {
      const rows = await contactsLedger(db, orgId)
      expect(rows.map((r) => r.email)).toEqual(['sam@acme.test', 'priya@rentman.io'])
      const priya = rows.find((r) => r.id === priyaId)!
      expect(priya).toMatchObject({ companyDomain: 'rentman.io', companyName: 'Rentman', companyTimeZone: 'Europe/Amsterdam', timeZone: null })
      expect((await contactsLedger(db, otherOrgId)).map((r) => r.email)).toEqual(['priya@theirs.io'])
    })

    it('carries each person’s consent rows, and only theirs', async () => {
      await contactsRecordConsent(db, { orgId, contactId: priyaId, channel: 'sms', granted: false, source: 'reply' })
      const rows = await contactsLedger(db, orgId)
      expect(rows.find((r) => r.id === priyaId)!.consents.map((c) => [c.channel, c.granted])).toEqual([['sms', false]])
      expect(rows.find((r) => r.id === samId)!.consents).toEqual([])
    })

    it('filters by company, by pause and by text — and treats % as a character', async () => {
      expect((await contactsLedger(db, orgId, { companyId: rentmanId })).map((r) => r.id)).toEqual([priyaId])
      expect((await contactsLedger(db, orgId, { paused: true })).map((r) => r.id)).toEqual([samId])
      expect((await contactsLedger(db, orgId, { paused: false })).map((r) => r.id)).toEqual([priyaId])
      expect((await contactsLedger(db, orgId, { q: 'RENTMAN' })).map((r) => r.id)).toEqual([priyaId])
      expect((await contactsLedger(db, orgId, { q: 'priya shah' })).map((r) => r.id)).toEqual([priyaId])
      expect((await contactsLedger(db, orgId, { q: 'cto' })).map((r) => r.id)).toEqual([priyaId])
      expect(await contactsLedger(db, orgId, { q: '%' })).toEqual([])
      // Another org's Priya is not found by searching for her name here.
      expect((await contactsLedger(db, orgId, { q: 'theirs' }))).toEqual([])
    })

    it('pages with a bounded limit', async () => {
      expect((await contactsLedger(db, orgId, { limit: 1 })).map((r) => r.id)).toEqual([samId])
      expect((await contactsLedger(db, orgId, { limit: 1, offset: 1 })).map((r) => r.id)).toEqual([priyaId])
      expect(await contactsLedger(db, orgId, { limit: 0 })).toHaveLength(1)
    })
  })

  describe('contactsUpdate', () => {
    const read = async (id: string) =>
      (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!

    it('folds the address, and reports only the fields that moved', async () => {
      const r = await contactsUpdate(db, orgId, priyaId, { email: '  Priya.Shah@Rentman.IO ', title: 'CTO' })
      expect(r).toMatchObject({ ok: true, changed: ['email'] })
      expect((await read(priyaId)).email).toBe('priya.shah@rentman.io')
      expect((await read(priyaId)).updatedAt).not.toBeNull()
    })

    it('leaves an undefined field alone and clears a null or blank one', async () => {
      const r = await contactsUpdate(db, orgId, priyaId, { title: null, lastName: '  ' })
      expect(r).toMatchObject({ ok: true, changed: ['lastName', 'title'] })
      const after = await read(priyaId)
      expect(after).toMatchObject({ firstName: 'Priya', lastName: null, title: null, email: 'priya@rentman.io', phone: '+14155550100' })
    })

    it('says nothing changed when nothing did, and writes nothing', async () => {
      const r = await contactsUpdate(db, orgId, priyaId, { firstName: 'Priya', email: 'PRIYA@rentman.io' })
      expect(r).toMatchObject({ ok: true, changed: [] })
      expect((await read(priyaId)).updatedAt).toBeNull()
    })

    it('refuses a duplicate address with a sentence, whatever its case', async () => {
      const r = await contactsUpdate(db, orgId, samId, { email: 'Priya@Rentman.io' })
      expect(r).toEqual({ ok: false, reason: 'duplicate', message: 'priya@rentman.io is already a contact in this CRM.' })
      expect((await read(samId)).email).toBe('sam@acme.test')
    })

    it('does not count another org’s contact as a duplicate', async () => {
      const r = await contactsUpdate(db, orgId, samId, { email: 'priya@theirs.io' })
      expect(r.ok).toBe(true)
    })

    it('refuses an unreadable email, phone or LinkedIn, naming what to type instead', async () => {
      expect(await contactsUpdate(db, orgId, priyaId, { email: 'not an address' })).toMatchObject({ ok: false, reason: 'unreadable' })
      const phone = await contactsUpdate(db, orgId, priyaId, { phone: '020 7946 0000' })
      expect(phone).toMatchObject({ ok: false, reason: 'unreadable' })
      if (!phone.ok) expect(phone.message).toMatch(/country code/)
      const li = await contactsUpdate(db, orgId, priyaId, { linkedinUrl: 'jane-doe' })
      expect(li).toMatchObject({ ok: false, reason: 'unreadable' })
      expect(await read(priyaId)).toMatchObject({ email: 'priya@rentman.io', phone: '+14155550100', linkedinUrl: null })
    })

    it('stores a phone in E.164 and a LinkedIn URL as typed', async () => {
      const r = await contactsUpdate(db, orgId, priyaId, { phone: '+44 20 7946 0000', linkedinUrl: 'https://www.linkedin.com/in/priya-shah/' })
      expect(r).toMatchObject({ ok: true, changed: ['phone', 'linkedinUrl'] })
      expect(await read(priyaId)).toMatchObject({ phone: '+442079460000', linkedinUrl: 'https://www.linkedin.com/in/priya-shah/' })
    })

    it('refuses to leave a person with no way to reach them', async () => {
      const r = await contactsUpdate(db, orgId, samId, { email: null })
      expect(r).toMatchObject({ ok: false, reason: 'no_address' })
      expect((await read(samId)).email).toBe('sam@acme.test')
    })

    it('cannot edit another org’s contact', async () => {
      const r = await contactsUpdate(db, otherOrgId, priyaId, { firstName: 'Mallory' })
      expect(r).toMatchObject({ ok: false, reason: 'no_such_contact' })
      expect((await read(priyaId)).firstName).toBe('Priya')
    })

    it('accepts a patch shape with every field optional, and rejects one past the bounds', () => {
      expect(contactPatchInput.parse({})).toEqual({})
      expect(contactPatchInput.safeParse({ firstName: 'x'.repeat(81) }).success).toBe(false)
      expect(contactPatchInput.safeParse({ linkedinUrl: 'x'.repeat(501) }).success).toBe(false)
    })

    describe('an edit cannot move a person out from under their own opt-out (§2.1)', () => {
      let campaignId: string
      beforeEach(async () => {
        await db.update(schema.contacts).set({ timeZone: 'Europe/London' }).where(eq(schema.contacts.id, priyaId))
        const [c] = await db
          .insert(schema.campaigns)
          .values({ orgId, name: 'Q4', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
          .returning({ id: schema.campaigns.id })
        campaignId = c!.id
      })
      const preview = () => previewSend(db, { orgId, contactId: priyaId, campaignId, now: new Date('2026-09-15T12:00:00.000Z') })

      it('refuses to change a suppressed address, and the sender still refuses the person', async () => {
        await addSuppression(db, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'replied stop', source: 'reply' })
        const r = await contactsUpdate(db, orgId, priyaId, { email: 'priya.new@rentman.io' })
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.reason).toBe('suppressed')
        expect(r.message).toMatch(/on the suppression list — an owner must remove the suppression/)
        // The message names the kind, never the value.
        expect(r.message).not.toContain('priya@rentman.io')
        expect((await read(priyaId)).email).toBe('priya@rentman.io')
        const p = await preview()
        expect(p.ok && !p.decision.allowed && p.decision.code).toBe('suppressed')
      })

      it('refuses to clear a suppressed address too', async () => {
        await addSuppression(db, { orgId, kind: 'phone', value: '+14155550100', reason: 'said stop on a call', source: 'voice' })
        expect(await contactsUpdate(db, orgId, priyaId, { phone: null })).toMatchObject({ ok: false, reason: 'suppressed' })
        expect(await contactsUpdate(db, orgId, priyaId, { phone: '+44 20 7946 0000' })).toMatchObject({ ok: false, reason: 'suppressed' })
        // The same number, written differently, is the same key: allowed.
        expect(await contactsUpdate(db, orgId, priyaId, { phone: '+1 (415) 555-0100' })).toMatchObject({ ok: true, changed: [] })
      })

      it('refuses to move an address out of a suppressed domain, and allows a move within it', async () => {
        await addSuppression(db, { orgId, kind: 'domain', value: 'rentman.io', reason: 'the company asked', source: 'manual' })
        expect(await contactsUpdate(db, orgId, priyaId, { email: 'priya@gmail.com' })).toMatchObject({ ok: false, reason: 'suppressed' })
        const within = await contactsUpdate(db, orgId, priyaId, { email: 'p.shah@rentman.io' })
        expect(within).toMatchObject({ ok: true, changed: ['email'] })
        const p = await preview()
        expect(p.ok && !p.decision.allowed && p.decision.code).toBe('suppressed')
      })

      it('refuses to edit a suppressed LinkedIn profile away', async () => {
        await db.update(schema.contacts).set({ linkedinUrl: 'linkedin.com/in/priya-shah' }).where(eq(schema.contacts.id, priyaId))
        await addSuppression(db, { orgId, kind: 'linkedin', value: 'linkedin.com/in/priya-shah', reason: 'asked on LinkedIn', source: 'manual' })
        expect(await contactsUpdate(db, orgId, priyaId, { linkedinUrl: 'linkedin.com/in/someone-else' })).toMatchObject({ ok: false, reason: 'suppressed' })
        const ledger = await consentLedgerFor(db, orgId, priyaId)
        expect(ledger?.suppression.linkedin).toBe('suppressed')
      })

      /**
       * The check above the UPDATE is a read, and a "stop" can land between it
       * and the write. The same condition is inside the UPDATE, so the edit
       * fails instead of moving the person past an opt-out that just arrived.
       * The proxy slips the suppression in at exactly that moment.
       */
      it('fails an edit when an opt-out arrives between the check and the write', async () => {
        let armed = true
        const racing = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop !== 'update' || !armed) return Reflect.get(target, prop, receiver)
            armed = false
            return (table: typeof schema.contacts) => {
              const real = target.update(table)
              return {
                set: (values: Parameters<typeof real.set>[0]) => ({
                  where: (cond: Parameters<ReturnType<typeof real.set>['where']>[0]) => ({
                    returning: async () => {
                      await addSuppression(target, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'replied stop', source: 'reply' })
                      return real.set(values).where(cond).returning()
                    },
                  }),
                }),
              }
            }
          },
        }) as AgencyDb
        const r = await contactsUpdate(racing, orgId, priyaId, { email: 'priya.new@rentman.io' })
        expect(r).toMatchObject({ ok: false, reason: 'changed_meanwhile' })
        expect((await read(priyaId)).email).toBe('priya@rentman.io')
        const p = await preview()
        expect(p.ok && !p.decision.allowed && p.decision.code).toBe('suppressed')
      })

      it('lets an unsuppressed address change, and the new one is what the sender reads', async () => {
        const r = await contactsUpdate(db, orgId, priyaId, { email: 'priya.new@rentman.io' })
        expect(r).toMatchObject({ ok: true, changed: ['email'] })
        const p = await preview()
        expect(p.ok && p.facts.recipient).toBe('priya.new@rentman.io')
      })
    })
  })
})
