/**
 * A shared number's holder, held hard while the number's STOP is unrecorded,
 * is released once a PERSON records the number — not only by a later text.
 *
 * Review round 8, finding [0], left one path open (the r9-sms group named it,
 * in a file it did not own): `releaseSharedNumberHolds` eases a holder's
 * `sharedNumberOptOutReason` pause to the ordinary hold only when a later
 * delivery through `recordInboundSms` finds the number suppressed. A number
 * recorded by hand on /suppressions, with no later text from it — the likely
 * path once a push with no message id is answered 200 and never retried —
 * left the holder refused by Resume for good, under a sentence saying THEY
 * asked to stop. Now Resume refuses them, in words that say a text from a
 * number they share did, only while the number has no phone suppression in
 * their org; once it has one, Resume lifts the pause. A contact's OWN
 * unrecorded opt-out is unchanged: Resume still refuses it outright.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  addSuppression, contactPauseByHand, contactResumeByHand, isSharedNumberOptOutPause, pauseContactOverriding,
  pauseReasonClass, previewSend, recordInboundReply, recordInboundSms, schema, sharedNumberHoldReason, sharedNumberOptOutReason,
  type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { failOnce } from './fault-db.js'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const NUMBER = '+919812345678'

describe('Resume on a shared number’s holder', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let holderId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', name: 'Olu Owner', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    const [holder] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, firstName: 'Reception', email: 'reception@rentman.io', phone: NUMBER, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    holderId = holder!.id
  })

  afterEach(async () => {
    await test.close()
  })

  async function reasonOf(): Promise<string | null> {
    const [c] = await db.select({ r: schema.contacts.pausedReason }).from(schema.contacts).where(eq(schema.contacts.id, holderId))
    return c!.r
  }

  it('refuses while the number is unrecorded, without saying the holder asked, and lifts it once a person records it', async () => {
    const reason = sharedNumberOptOutReason(NOW, 'record_failed')
    expect(isSharedNumberOptOutPause(reason)).toBe(true)
    expect(pauseReasonClass(reason)).toBe('opt_out_not_recorded')
    await pauseContactOverriding(db, orgId, holderId, reason, NOW)

    const refused = await contactResumeByHand(db, { orgId, contact: { id: holderId }, expectedReason: reason, actor: userId })
    expect(refused).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!refused.ok) {
      expect(refused.message).toContain('a number this contact shares')
      expect(refused.message).not.toMatch(/This person asked to stop/)
    }
    expect(await reasonOf()).toBe(reason)

    // A person records the number by hand; no later text from it ever comes.
    const added = await addSuppression(db, { orgId, kind: 'phone', value: NUMBER, reason: 'recorded by hand', source: 'manual' })
    expect(added.ok).toBe(true)

    expect(await contactResumeByHand(db, { orgId, contact: { id: holderId }, expectedReason: reason, actor: userId })).toEqual({ ok: true })
    expect(await reasonOf()).toBeNull()
    const [row] = await db
      .select({ detail: schema.auditLog.detail })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'contact.resumed'))
    expect(row!.detail).toEqual({ pausedFor: 'opt_out_not_recorded' })
  })

  it('keeps refusing a contact’s OWN unrecorded opt-out, whatever is on the list', async () => {
    const own = `opt-out not recorded: reply ${NOW.toISOString()} (record_failed)`
    expect(isSharedNumberOptOutPause(own)).toBe(false)
    await pauseContactOverriding(db, orgId, holderId, own, NOW)
    await addSuppression(db, { orgId, kind: 'phone', value: NUMBER, reason: 'recorded by hand', source: 'manual' })
    const r = await contactResumeByHand(db, { orgId, contact: { id: holderId }, expectedReason: own, actor: userId })
    expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!r.ok) expect(r.message).toMatch(/This person asked to stop/)
    expect(await reasonOf()).toBe(own)
  })

  it('says, when a teammate tries to pause them over it, that the opt-out may be a shared number’s', async () => {
    await pauseContactOverriding(db, orgId, holderId, sharedNumberOptOutReason(NOW, 'suppression_failed'), NOW)
    const r = await contactPauseByHand(db, { orgId, contactId: holderId, reason: 'hold (by owner@agency.test)', now: NOW })
    expect(r).toMatchObject({ ok: false, reason: 'already_paused', pausedFor: 'opt_out_not_recorded' })
    if (!r.ok && 'message' in r) expect(r.message).toContain('a text from a number they share')
  })
})

/**
 * Review round 9, [1] + [5], the reviewers' probes. A shared number's STOP
 * whose phone suppression could not be written paused every other holder
 * with `pauseContactOverriding` — over ANY earlier pause. A holder whose own
 * email opt-out had never been recorded, or whose erasure had not finished,
 * lost that pause to the releasable shared-number one; DoveSoft's retry (or
 * a person recording the number) then eased it, Resume's own-opt-out gate
 * was satisfied by the NUMBER's suppression, and their email went. Now the
 * holders' loud path writes over no pause, a reply's, the ordinary hold or
 * an earlier shared hard hold only; and a contact's own unrecorded opt-out
 * ends only with a suppression on the key it was about.
 */
describe('a holder’s stronger pause, and the key an own opt-out was about (review round 9)', () => {
  const AT = new Date('2026-09-15T06:30:00.000Z')
  const LATER = new Date('2026-09-15T07:30:00.000Z')
  const PHONE = '+919812345678'
  const quiet = { error: () => {} }

  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let emailCampaignId: string
  let jo: string
  let x: string

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
    const [sms] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'SMS', channel: 'sms', status: 'active', autoSend: false })
      .returning({ id: schema.campaigns.id })
    const [email] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Email', channel: 'email', status: 'active', autoSend: false, quietStart: '23:59', quietEnd: '00:00', dailyCap: 25 })
      .returning({ id: schema.campaigns.id })
    emailCampaignId = email!.id
    const [tpl] = await db
      .insert(schema.messageTemplates)
      .values({ orgId, channel: 'sms', externalId: '1107160000000000009', senderId: 'ACMEIN', category: 'service_explicit', body: 'Hi {#var#}, your call is confirmed.' })
      .returning({ id: schema.messageTemplates.id })
    const [j] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'jo@acme.example', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    jo = j!.id
    const [xx] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'x@acme.example', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    x = xx!.id
    // This system texted Jo at the number: a reply from it is filed under Jo, and X is a holder.
    await db.insert(schema.touches).values({
      orgId, contactId: jo, companyId, channel: 'sms', direction: 'out', status: 'sent', campaignId: sms!.id,
      body: 'Hi Jo, your call is confirmed.', recipient: PHONE, sentAt: new Date(AT.getTime() - 86_400_000), providerId: 'ds-1', templateId: tpl!.id,
    })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const reasonOf = async (id: string) =>
    (await db.select({ r: schema.contacts.pausedReason }).from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!.r
  const resume = async (id: string) => contactResumeByHand(db, { orgId, contact: { id }, expectedReason: await reasonOf(id), actor: userId })
  const emailToX = async () => {
    const p = await previewSend(db, { orgId, contactId: x, campaignId: emailCampaignId, now: new Date('2026-09-15T12:00:00.000Z') })
    if (!p.ok) throw new Error(p.message)
    return p.decision
  }
  /** X's own "Please stop emailing me", whose email suppression insert faults: X's own unrecorded opt-out. */
  const ownEmailStopNotRecorded = async () => {
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.kind = 'email'` })
    const own = await recordInboundReply(db, {
      orgId, contactId: x, channel: 'email', from: 'x@acme.example', subject: 'Re: hi', body: 'Please stop emailing me.',
      providerId: '<x-1@acme.example>', now: AT, log: quiet,
    })
    expect(own.optOutNotRecorded).toBe(true)
    return reasonOf(x)
  }
  /** A STOP from the number, filed under Jo, whose phone suppression faults once. */
  const sharedStopNotRecorded = async () => {
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.kind = 'phone'` })
    const r = await recordInboundSms(db, { from: PHONE, text: 'STOP', providerMessageId: 'mo-1', orgId, receivedAt: LATER, log: quiet })
    expect(r).toMatchObject({ matched: 'contact', contactId: jo, optOutNotRecorded: true })
  }
  const redeliver = () => recordInboundSms(db, { from: PHONE, text: 'STOP', providerMessageId: 'mo-1', orgId, receivedAt: LATER, log: quiet })

  it('keeps a holder’s own unrecorded email opt-out through the shared STOP and its retry, and Resume refuses it', async () => {
    const own = await ownEmailStopNotRecorded()
    expect(pauseReasonClass(own)).toBe('opt_out_not_recorded')
    expect(isSharedNumberOptOutPause(own)).toBe(false)

    await sharedStopNotRecorded()
    expect(await reasonOf(x)).toBe(own)
    // The org's one row still lists X among the number's holders, and says
    // X is held — by their own pause, which stood (`kept`).
    const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'contact.opt_out_not_recorded'))
      .then((rows) => rows.filter((r) => (r.detail as Record<string, unknown>)['sharedNumber'] === true))
    expect(row?.detail).toMatchObject({ contacts: 1, paused: 1, kept: 1, holders: [x] })

    // DoveSoft's retry records the number; X's pause is not "eased".
    expect(await redeliver()).toMatchObject({ duplicate: true, suppressed: true })
    expect(await reasonOf(x)).toBe(own)
    expect(await resume(x)).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    expect(await emailToX()).toMatchObject({ allowed: false, code: 'paused' })
  })

  it('keeps it when a person records the number by hand instead', async () => {
    const own = await ownEmailStopNotRecorded()
    await sharedStopNotRecorded()
    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })
    expect(await reasonOf(x)).toBe(own)
    expect(await resume(x)).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    expect(await emailToX()).toMatchObject({ allowed: false })
  })

  it('keeps an unfinished erasure’s pause through the shared STOP and its retry', async () => {
    const ERASURE = `erasure requested ${AT.toISOString().slice(0, 10)}; not completed (unreadable_linkedin)`
    await pauseContactOverriding(db, orgId, x, ERASURE, AT)
    await db.insert(schema.auditLog).values({
      orgId, actor: userId, action: 'contact.erasure_failed', subjectType: 'contact', subjectId: x, detail: { why: 'unreadable_linkedin', paused: true },
    })
    await sharedStopNotRecorded()
    expect(await reasonOf(x)).toBe(ERASURE)
    await redeliver()
    expect(await reasonOf(x)).toBe(ERASURE)
    expect(await resume(x)).toMatchObject({ ok: false, reason: 'erasure' })
    expect(await emailToX()).toMatchObject({ allowed: false })
  })

  it('keeps a teammate’s hold, and Resume refuses it while the number is unrecorded, then lifts it once it is', async () => {
    const TEAMMATE = 'legal hold (by sam@agency.test)'
    await pauseContactOverriding(db, orgId, x, TEAMMATE, AT)
    await sharedStopNotRecorded()
    expect(await reasonOf(x)).toBe(TEAMMATE)

    // The hold is liftable by Resume — but not while the number that said
    // STOP is unrecorded: the text would go to it.
    const refused = await resume(x)
    expect(refused).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!refused.ok) {
      expect(refused.message).toContain('a number this contact shares')
      expect(refused.message).not.toMatch(/This person asked to stop/)
    }
    expect(await reasonOf(x)).toBe(TEAMMATE)

    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })
    expect(await resume(x)).toEqual({ ok: true })
  })

  it('still writes the hard hold over a reply’s pause, the ordinary hold, or no pause', async () => {
    const [y] = await db.insert(schema.contacts).values({ orgId, companyId, email: 'y@acme.example', phone: PHONE }).returning({ id: schema.contacts.id })
    const [z] = await db.insert(schema.contacts).values({ orgId, companyId, email: 'z@acme.example', phone: PHONE }).returning({ id: schema.contacts.id })
    await pauseContactOverriding(db, orgId, x, `replied ${AT.toISOString()}`, AT)
    await pauseContactOverriding(db, orgId, y!.id, sharedNumberHoldReason(AT), AT)
    await sharedStopNotRecorded()
    for (const id of [x, y!.id, z!.id]) expect(await reasonOf(id)).toBe(sharedNumberOptOutReason(LATER, 'suppression_failed'))
  })

  // -------------------------------------------------------------------------
  // The Resume gate: the key the contact's own opt-out was about
  // -------------------------------------------------------------------------

  it('does not let the NUMBER’s suppression end a contact’s own unrecorded EMAIL opt-out', async () => {
    // An opted-out email reply of X's whose suppression is not on the list
    // (removed since, say), and X held by an ordinary pause.
    await db.insert(schema.touches).values({
      orgId, contactId: x, companyId, channel: 'email', direction: 'in', status: 'replied', subject: 'Re', body: 'Please stop emailing me.',
      recipient: 'x@acme.example', replyKind: 'opted_out', sentAt: AT,
    })
    await pauseContactOverriding(db, orgId, x, 'on leave (by sam@agency.test)', AT)
    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })

    const r = await resume(x)
    expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!r.ok) expect(r.message).toMatch(/the address their reply came from/)
    await addSuppression(db, { orgId, kind: 'email', value: 'x@acme.example', reason: 'by hand', source: 'manual' })
    expect(await resume(x)).toEqual({ ok: true })
  })

  it('ends an audited unrecorded opt-out only with a suppression on its own channel', async () => {
    await pauseContactOverriding(db, orgId, x, 'on leave (by sam@agency.test)', AT)
    await db.insert(schema.auditLog).values({
      orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: x, detail: { channel: 'email', why: 'Error' },
    })
    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })
    const r = await resume(x)
    expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!r.ok) expect(r.message).toMatch(/their email address/)
    // A domain row covers the address, as the send path reads it.
    await addSuppression(db, { orgId, kind: 'domain', value: 'acme.example', reason: 'by hand', source: 'manual' })
    expect(await resume(x)).toEqual({ ok: true })
  })

  it('ends an SMS one with the number, and never with the email', async () => {
    await pauseContactOverriding(db, orgId, x, 'on leave (by sam@agency.test)', AT)
    await db.insert(schema.auditLog).values({
      orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: x, detail: { channel: 'sms', why: 'Error' },
    })
    await addSuppression(db, { orgId, kind: 'email', value: 'x@acme.example', reason: 'by hand', source: 'manual' })
    const r = await resume(x)
    expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!r.ok) expect(r.message).toMatch(/their phone number/)
    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })
    expect(await resume(x)).toEqual({ ok: true })
  })

  it('ends a failed erasure’s row only once every address of theirs is on the list', async () => {
    await pauseContactOverriding(db, orgId, x, 'on leave (by sam@agency.test)', AT)
    await db.insert(schema.auditLog).values({
      orgId, actor: userId, action: 'contact.erasure_failed', subjectType: 'contact', subjectId: x, detail: { why: 'Error', paused: false },
    })
    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'by hand', source: 'manual' })
    expect(await resume(x)).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    await addSuppression(db, { orgId, kind: 'email', value: 'x@acme.example', reason: 'by hand', source: 'manual' })
    expect(await resume(x)).toEqual({ ok: true })
  })
})
