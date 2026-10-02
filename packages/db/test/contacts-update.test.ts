/**
 * Review round 9, [10]: a shared number's holder, held because the number's
 * STOP could not be recorded in their org, whose phone is changed or cleared
 * before the number is recorded.
 *
 * The hold is lifted by the NUMBER's suppression, read off the contact's
 * phone (Resume, and the release a later text makes, both find the holder
 * and the number that way — the audit row does not carry the number, §2.3).
 * `contactsUpdate` refuses to move a person out from under a suppression
 * that exists; before the number is recorded none does, so the edit went
 * through — and then nothing could lift the hold: Resume judged the new
 * phone, no later text from the number found the holder, and Pause by hand
 * answered "already paused". Held on every channel, for good. Now the phone
 * of a contact held for an unrecorded shared number cannot be changed or
 * cleared until the number is recorded, with a sentence saying so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  addSuppression, contactPauseByHand, contactResumeByHand, contactsUpdate, pauseContactOverriding, pauseReasonClass, recordInboundSms,
  removeSuppression, schema, sharedNumberOptOutReason, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { failOnce } from './fault-db.js'

const AT = new Date('2026-09-15T06:30:00.000Z')
const PHONE = '+919812345678'
const quiet = { error: () => {} }

describe('changing the phone of a shared number’s holder (review round 9)', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let jo: string
  let bina: string

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
    companyId = company!.id
    const [j] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'jo@acme.example', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    jo = j!.id
    const [b] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'bina@acme.example', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    bina = b!.id
    // Jo was texted at the number, so a text from it is filed under Jo and Bina holds it.
    await db.insert(schema.touches).values({
      orgId, contactId: jo, companyId, channel: 'sms', direction: 'out', status: 'sent', body: 'Hi Jo',
      recipient: PHONE, sentAt: new Date(AT.getTime() - 86_400_000), providerId: 'ds-1',
    })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const row = async (id: string) => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!
  /** "Wrong number. STOP" from the reception line, with no message id, whose phone suppression faults once. */
  const stopNotRecorded = async () => {
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.kind = 'phone'` })
    expect(await recordInboundSms(db, { from: PHONE, text: 'Wrong number. STOP', providerMessageId: null, orgId, receivedAt: AT, log: quiet })).toMatchObject({
      matched: 'contact', contactId: jo, optOutNotRecorded: true,
    })
  }

  it('refuses to clear or change the phone of a holder held hard, with a sentence, and changes nothing', async () => {
    await stopNotRecorded()
    expect(pauseReasonClass((await row(bina)).pausedReason)).toBe('opt_out_not_recorded')

    for (const phone of ['', '+91 99887 76655']) {
      const r = await contactsUpdate(db, orgId, bina, { phone })
      expect(r).toMatchObject({ ok: false, reason: 'shared_number_hold' })
      if (!r.ok) {
        expect(r.message).toMatch(/\/suppressions/)
        expect(r.message).toMatch(/Nothing was changed/)
        expect(r.message).not.toContain('9812345678')
      }
      expect((await row(bina)).phone).toBe(PHONE)
    }

    // Anything but the number may change, and so may the number's spelling.
    expect(await contactsUpdate(db, orgId, bina, { email: 'bina.k@acme.example', phone: '+91 98123 45678' })).toMatchObject({ ok: true, changed: ['email'] })

    // Recorded, she can be resumed; the number is on the list now, and moving
    // her off it is an owner's decision, as for any suppressed address.
    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })
    const held = await row(bina)
    expect(await contactResumeByHand(db, { orgId, contact: { id: bina }, expectedReason: held.pausedReason, actor: userId })).toEqual({ ok: true })
    expect(await contactsUpdate(db, orgId, bina, { phone: '' })).toMatchObject({ ok: false, reason: 'suppressed' })
  })

  it('refuses it too for a holder whose own pause stood, while the row lists them and the number is unrecorded', async () => {
    const TEAMMATE = 'on leave (by sam@agency.test)'
    await pauseContactOverriding(db, orgId, bina, TEAMMATE, AT)
    await stopNotRecorded()
    expect((await row(bina)).pausedReason).toBe(TEAMMATE)
    expect(await contactsUpdate(db, orgId, bina, { phone: null })).toMatchObject({ ok: false, reason: 'shared_number_hold' })
    expect((await row(bina)).phone).toBe(PHONE)
  })

  it('lets anybody else’s phone change, as before', async () => {
    const [c] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'sam@acme.example', phone: '+919811111111' })
      .returning({ id: schema.contacts.id })
    await stopNotRecorded()
    expect(await contactsUpdate(db, orgId, c!.id, { phone: '+91 98222 22222' })).toMatchObject({ ok: true, changed: ['phone'] })
  })

  // -------------------------------------------------------------------------
  // Review round 10, [0] + [1]: a row that listed them governs no longer
  // -------------------------------------------------------------------------

  /**
   * PGlite's clock is millisecond-grained, and these tests turn on which
   * audit row is newer: every row gets its own second, in the order written.
   */
  const auditRowsInTheirOwnSeconds = () =>
    test.pg.exec(`
      CREATE SEQUENCE audit_clock;
      CREATE FUNCTION audit_clock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.created_at := timestamptz '2026-09-15 00:00:00+00' + nextval('audit_clock') * interval '1 second';
        RETURN NEW;
      END $$;
      CREATE TRIGGER audit_clock BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_clock();
    `)

  /** The number recorded by hand, Bina resumed, and then an owner removes the number's suppression. */
  const resumedThenUnrecorded = async () => {
    await auditRowsInTheirOwnSeconds()
    await stopNotRecorded()
    expect(await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })).toMatchObject({ ok: true })
    const held = await row(bina)
    expect(await contactResumeByHand(db, { orgId, contact: { id: bina }, expectedReason: held.pausedReason, actor: userId })).toEqual({ ok: true })
    // "An owner must remove the suppression before it can be changed" — and does.
    expect(await contactsUpdate(db, orgId, bina, { phone: '+91 99887 76655' })).toMatchObject({ ok: false, reason: 'suppressed' })
    const [sup] = await db.select({ id: schema.suppressions.id }).from(schema.suppressions).where(eq(schema.suppressions.kind, 'phone'))
    expect(await removeSuppression(db, orgId, sup!.id)).not.toBeNull()
  }

  /**
   * The reviewers' probe: the row listing Bina outlived her resume, so once
   * an owner removed the number's suppression — the step the `suppressed`
   * refusal names — every edit of her phone was refused `shared_number_hold`
   * ("they are held until it is"), false of a contact who is not paused, and
   * re-adding the suppression brought `suppressed` back: the phone could
   * never change.
   */
  it('lets an owner change the phone of a former holder resumed once the number was recorded, after removing its suppression', async () => {
    await resumedThenUnrecorded()
    expect((await row(bina)).pausedAt).toBeNull()
    expect(await contactsUpdate(db, orgId, bina, { phone: '+91 99887 76655' })).toMatchObject({ ok: true, changed: ['phone'] })
    expect((await row(bina)).phone).toBe('+919988776655')
  })

  it('lets them clear it too, though a teammate paused them since: the resume spent the row', async () => {
    await resumedThenUnrecorded()
    expect(await contactPauseByHand(db, { orgId, contactId: bina, reason: 'waiting on legal (by sam@agency.test)' })).toMatchObject({ ok: true })
    expect(await contactsUpdate(db, orgId, bina, { phone: '' })).toMatchObject({ ok: true, changed: ['phone'] })
    expect((await row(bina)).phone).toBeNull()
  })

  /**
   * A holder the row lists whose pause could not be written — the
   * shortfall `paused` counts — is not paused: there is no hold the edit
   * could strand, so it is not refused (review round 10).
   */
  it('does not refuse an unpaused contact a row lists', async () => {
    await auditRowsInTheirOwnSeconds()
    await db.insert(schema.auditLog).values({
      orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: null, subjectId: null,
      detail: { channel: 'sms', why: 'suppression_failed', sharedNumber: true, contacts: 1, paused: 0, holders: [bina] },
    })
    expect((await row(bina)).pausedAt).toBeNull()
    expect(await contactsUpdate(db, orgId, bina, { phone: '+91 99887 76655' })).toMatchObject({ ok: true, changed: ['phone'] })
  })

  it('still refuses a holder a NEWER row lists, though a person resumed them before it', async () => {
    await resumedThenUnrecorded()
    // A teammate holds Bina, and a second STOP from the number fails: her pause stands, and the new row lists her.
    expect(await contactPauseByHand(db, { orgId, contactId: bina, reason: 'waiting on legal (by sam@agency.test)' })).toMatchObject({ ok: true })
    await stopNotRecorded()
    expect((await row(bina)).pausedReason).toBe('waiting on legal (by sam@agency.test)')
    expect(await contactsUpdate(db, orgId, bina, { phone: '' })).toMatchObject({ ok: false, reason: 'shared_number_hold' })
    const held = await row(bina)
    expect(await contactResumeByHand(db, { orgId, contact: { id: bina }, expectedReason: held.pausedReason, actor: userId })).toMatchObject({
      ok: false, reason: 'opt_out_not_recorded',
    })
    expect((await row(bina)).phone).toBe(PHONE)
  })

  it('fails the edit of a paused contact when a row listing them lands between its read and its write', async () => {
    await pauseContactOverriding(db, orgId, bina, 'on leave (by sam@agency.test)', AT)
    let fired = false
    const racing = new Proxy(db as object, {
      get(t, p, r) {
        if (p === 'update' && !fired) {
          fired = true
          return (...args: unknown[]) => {
            void db.insert(schema.auditLog).values({
              orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: null, subjectId: null,
              detail: { channel: 'sms', why: 'suppression_failed', sharedNumber: true, contacts: 1, paused: 1, kept: 1, holders: [bina] },
            }).then(() => {})
            return (Reflect.get(t, p, r) as (...a: unknown[]) => unknown).apply(t, args)
          }
        }
        return Reflect.get(t, p, r)
      },
    }) as AgencyDb
    expect(await contactsUpdate(racing, orgId, bina, { phone: '+91 99887 76655' })).toMatchObject({ ok: false, reason: 'changed_meanwhile' })
    expect((await row(bina)).phone).toBe(PHONE)
  })

  it('fails the edit when the hard hold lands between its read and its write', async () => {
    let fired = false
    const racing = new Proxy(db as object, {
      get(t, p, r) {
        if (p === 'update' && !fired) {
          fired = true
          return (...args: unknown[]) => {
            // The STOP's loud path commits first.
            void pauseContactOverriding(db, orgId, bina, sharedNumberOptOutReason(AT, 'suppression_failed'), AT)
            return (Reflect.get(t, p, r) as (...a: unknown[]) => unknown).apply(t, args)
          }
        }
        return Reflect.get(t, p, r)
      },
    }) as AgencyDb
    const r = await contactsUpdate(racing, orgId, bina, { phone: '+91 99887 76655' })
    expect(r).toMatchObject({ ok: false, reason: 'changed_meanwhile' })
    expect((await row(bina)).phone).toBe(PHONE)
  })
})
