/**
 * A text from a number several contacts hold, after review round 6, against
 * a real engine.
 *
 * Round 5 held every holder of a number nobody could narrow to one, and
 * filed a reply under the one holder this system had texted. Round 6 found
 * what that left: the OTHER holders of a number a reply was filed under
 * stayed live, and the deployment's own org was preferred among holders it
 * had texted although every org texts through the one account ([1], [5]);
 * the hold said the holders had replied and declined ([19]); an alarm for a
 * suppression that failed in another org named the org whose suppression
 * worked ([3], [6]); a failed suppression left a same-org co-holder live
 * ([4]); a redelivered text filed under nobody held everybody again ([7]);
 * and a redelivered STOP never finished the other orgs' suppressions ([16]).
 *
 * Faults are raised by the ENGINE (`failOnce`), never by a JavaScript throw,
 * because only a real fault shows what a transaction keeps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { REFUSALS_A_CORRECTION_RESOLVES, pausedSentence } from '@agency/core'
import {
  approveDraft, contactResumeByHand, pauseReasonClass, previewSend, recordInboundReply, recordInboundSms, resumeContact,
  schema, sharedNumberHoldReason, smsDraft,
  type AgencyDb, type InboundLog,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { failOnce } from './fault-db.js'

/** Noon in India. */
const NOON_IST = new Date('2026-09-15T06:30:00.000Z')
const PHONE = '+919876543210'
const BODY = 'Hi {#var#}, your call with Acme is at {#var#}. Reply STOP to opt out.'

interface Org {
  readonly orgId: string
  readonly userId: string
  readonly companyId: string
  readonly campaignId: string
  readonly templateId: string
}

describe('a text from a number several contacts hold (review round 6)', () => {
  let test: TestDb
  let db: AgencyDb
  let a: Org
  let b: Org

  /** An org with an owner, a company, an active SMS campaign and a registered template. */
  async function org(name: string): Promise<Org> {
    const [o] = await db.insert(schema.orgs).values({ name }).returning({ id: schema.orgs.id })
    const orgId = o!.id
    const [u] = await db
      .insert(schema.users)
      .values({ orgId, email: `owner@${name.toLowerCase().replace(/\W/g, '')}.test`, role: 'owner' })
      .returning({ id: schema.users.id })
    const [co] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.in', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    const [ca] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Meeting reminders', channel: 'sms', autoSend: false, dailyCap: 50, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const [t] = await db
      .insert(schema.messageTemplates)
      .values({ orgId, channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', body: BODY })
      .returning({ id: schema.messageTemplates.id })
    return { orgId, userId: u!.id, companyId: co!.id, campaignId: ca!.id, templateId: t!.id }
  }

  /** A contact in this org at the shared number, opted in to SMS. */
  async function holder(o: Org, firstName: string): Promise<string> {
    const [c] = await db
      .insert(schema.contacts)
      .values({ orgId: o.orgId, companyId: o.companyId, firstName, phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    await db.insert(schema.consents).values({ orgId: o.orgId, contactId: c!.id, channel: 'sms', granted: true, source: 'booking form' })
    return c!.id
  }

  /** What this system sent to a contact at the number: the evidence a reply is theirs. */
  async function texted(o: Org, contactId: string): Promise<void> {
    await db.insert(schema.touches).values({
      orgId: o.orgId, contactId, channel: 'sms', direction: 'out', status: 'sent',
      body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.', recipient: PHONE,
      sentAt: new Date(NOON_IST.getTime() - 86_400_000), providerId: `ds-${contactId}`,
    })
  }

  /** An SMS drafted to this contact and approved by a person — what the next tick would send. */
  async function approved(o: Org, contactId: string): Promise<string> {
    const d = await smsDraft(db, {
      orgId: o.orgId, contactId, campaignId: o.campaignId, templateId: o.templateId, vars: ['Priya', '3pm'], createdBy: o.userId, now: NOON_IST,
    })
    if (!d.ok) throw new Error(d.message)
    const r = await approveDraft(db, { orgId: o.orgId, touchId: d.touchId, contactId, campaignId: o.campaignId, approvedBy: o.userId, now: NOON_IST })
    if (!r.ok) throw new Error('not approved')
    return d.touchId
  }

  const log = (): InboundLog & { lines: { message: string; fields: Record<string, unknown> }[] } => {
    const lines: { message: string; fields: Record<string, unknown> }[] = []
    return { lines, error: (message, fields = {}) => lines.push({ message, fields }) }
  }
  const inbound = (over: Partial<Parameters<typeof recordInboundSms>[1]> = {}) =>
    recordInboundSms(db, { from: PHONE, text: 'Who is this?', providerMessageId: 'mo-1', receivedAt: NOON_IST, ...over })
  const contact = async (id: string) => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!
  const touch = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const audits = async (action: string) => (await db.select().from(schema.auditLog)).filter((r) => r.action === action)
  const suppressedIn = async () =>
    (await db.select().from(schema.suppressions)).filter((s) => s.kind === 'phone' && s.value === PHONE).map((s) => s.orgId).sort()
  const willSend = async (o: Org, contactId: string) => {
    const p = await previewSend(db, { orgId: o.orgId, contactId, campaignId: o.campaignId, now: NOON_IST })
    if (!p.ok) throw new Error(p.message)
    return p.decision
  }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    a = await org('Agency A')
    b = await org('Agency B')
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  // -------------------------------------------------------------------------
  // [1] + [5]: a reply filed under the one it texted holds every other holder
  // -------------------------------------------------------------------------

  /** Probe P1: one person on file twice in one org; the work row was texted, the personal row has an approved SMS. */
  it('holds a same-org twin of the contact the reply was filed under, and its approved text does not go', async () => {
    const work = await holder(a, 'Jo (work)')
    const personal = await holder(a, 'Jo (personal)')
    await texted(a, work)
    const waiting = await approved(a, personal)
    const r = await inbound({ text: 'Not interested' })
    expect(r).toMatchObject({ matched: 'contact', orgId: a.orgId, contactId: work })
    expect((await contact(personal)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    expect(await touch(waiting)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
    expect(await willSend(a, personal)).toMatchObject({ allowed: false, code: 'paused' })
    const [row] = await audits('sms.inbound_unmatched')
    expect(row).toMatchObject({
      orgId: a.orgId,
      detail: { why: 'ambiguous', optOut: false, contacts: 1, paused: 1, cancelledQueued: 1, filedUnder: 'another_contact' },
    })
  })

  /** Probe P2: both orgs texted the number; the deployment's org is no evidence of whose text was answered. */
  it('files a reply two orgs both texted under nobody, whichever org the deployment names, and holds both', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, inA)
    await texted(b, inB)
    const waiting = await approved(b, inB)
    const r = await inbound({ text: 'Yes, call me tomorrow', orgId: a.orgId })
    expect(r).toMatchObject({ matched: 'none', why: 'ambiguous' })
    expect((await db.select().from(schema.touches)).filter((t) => t.direction === 'in')).toEqual([])
    for (const id of [inA, inB]) expect((await contact(id)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    expect(await touch(waiting)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
    expect(await willSend(b, inB)).toMatchObject({ allowed: false, code: 'paused' })
  })

  it('holds another org’s contact when the reply is filed under the one this system texted, and tells that org', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, inA)
    const waiting = await approved(b, inB)
    expect(await inbound()).toMatchObject({ matched: 'contact', orgId: a.orgId, contactId: inA })
    expect(await touch(waiting)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
    expect((await audits('sms.inbound_unmatched')).map((r) => [r.orgId, r.detail])).toEqual([
      [b.orgId, { why: 'ambiguous', optOut: false, contacts: 1, paused: 1, cancelledQueued: 1, filedUnder: 'another_org' }],
    ])
  })

  /**
   * The hold comes BEFORE the reply is recorded: once it is, a redelivery is
   * a duplicate that holds nobody, so a recording that failed must not have
   * skipped it — and the retry that records the reply holds nobody twice.
   */
  it('has held the others when recording the reply fails, and the retry records it without holding them twice', async () => {
    const inA = await holder(a, 'Jo')
    const twin = await holder(a, 'Jo (personal)')
    await texted(a, inA)
    await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: `NEW.direction = 'in'` })
    await expect(inbound()).rejects.toThrow()
    expect((await db.select().from(schema.touches)).filter((t) => t.direction === 'in')).toEqual([])
    expect((await contact(twin)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    expect((await contact(inA)).pausedAt).toBeNull()
    expect(await inbound()).toMatchObject({ matched: 'contact', contactId: inA, duplicate: false })
    const [row] = await audits('sms.inbound_unmatched')
    expect(row?.detail).toMatchObject({ filedUnder: 'another_contact', paused: 0 })
  })

  // -------------------------------------------------------------------------
  // [19]: the hold is a hold, not a reply and not a refusal
  // -------------------------------------------------------------------------

  it('holds with a reason of its own that Resume lifts, and cancels with a code a correction resolves', async () => {
    const one = await holder(a, 'Jo')
    const two = await holder(a, 'Jo (personal)')
    const waiting = await approved(a, two)
    expect(await inbound()).toMatchObject({ matched: 'none', why: 'ambiguous' })
    const held = await contact(two)
    // Not the reply class: no reply row exists for either of them, and the
    // reply class tells a person to answer it from /inbox.
    expect(pauseReasonClass(held.pausedReason)).toBe('other')
    expect(pausedSentence(pauseReasonClass(held.pausedReason))).not.toContain('/inbox')
    expect(held.pausedReason).not.toMatch(/^replied /)
    // A hold, which a re-draft may follow once a person lifts it — never the
    // recipient's own no.
    const row = await touch(waiting)
    expect(row.refusalCode).toBe('paused')
    expect(REFUSALS_A_CORRECTION_RESOLVES.has(row.refusalCode!)).toBe(true)
    // A person on /contacts lifts it.
    const resumed = await contactResumeByHand(db, { orgId: a.orgId, contact: { id: two }, expectedReason: held.pausedReason, actor: a.userId })
    expect(resumed).toMatchObject({ ok: true })
    expect((await contact(two)).pausedAt).toBeNull()
    expect((await contact(one)).pausedAt).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // [3] + [6]: a suppression that failed in another org is that org's alarm
  // -------------------------------------------------------------------------

  it('reports another org’s failed suppression as that org’s, and the filed contact’s as recorded', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, inA)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.org_id = '${b.orgId}'` })
    const l = log()
    const r = await inbound({ text: 'STOP', log: l })
    expect(r).toMatchObject({
      matched: 'contact', orgId: a.orgId, contactId: inA, suppressed: true,
      optOutNotRecorded: false,
      optOutNotRecordedIn: [{ orgId: b.orgId, contactId: inB }],
    })
    expect(await suppressedIn()).toEqual([a.orgId])
    // Org B's loud path ran where the failure is: its contact, its audit row.
    expect(pauseReasonClass((await contact(inB)).pausedReason)).toBe('opt_out_not_recorded')
    expect((await audits('contact.opt_out_not_recorded')).map((r) => [r.orgId, r.subjectId])).toEqual([[b.orgId, inB]])
    const [unmatched] = await audits('sms.inbound_unmatched')
    expect(unmatched).toMatchObject({ orgId: b.orgId, detail: { optOut: true, suppressed: false, filedUnder: 'another_org' } })
  })

  // -------------------------------------------------------------------------
  // [4]: the filed contact's failed suppression takes their co-holders with it
  // -------------------------------------------------------------------------

  /** The reviewer's probe: A texted, B with an approved SMS, one org, and the suppression insert fails. */
  it('takes the loud path for a same-org co-holder when the filed contact’s suppression could not be written', async () => {
    const filed = await holder(a, 'A')
    const coHolder = await holder(a, 'B')
    await texted(a, filed)
    const waiting = await approved(a, coHolder)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
    const r = await inbound({ text: 'STOP', log: log() })
    expect(r).toMatchObject({ matched: 'contact', contactId: filed, optOutNotRecorded: true, optOutNotRecordedIn: [] })
    expect(await suppressedIn()).toEqual([])
    for (const id of [filed, coHolder]) expect(pauseReasonClass((await contact(id)).pausedReason)).toBe('opt_out_not_recorded')
    expect(await touch(waiting)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
    expect(await willSend(a, coHolder)).toMatchObject({ allowed: false })
    expect((await audits('contact.opt_out_not_recorded')).map((r) => r.subjectId).sort()).toEqual([filed, coHolder].sort())
    const [row] = await audits('sms.inbound_unmatched')
    expect(row?.detail).toMatchObject({ filedUnder: 'another_contact', optOut: true, suppressed: false })
  })

  // -------------------------------------------------------------------------
  // [7]: a redelivered text filed under nobody holds nobody again
  // -------------------------------------------------------------------------

  /** The probe: both held; a teammate resumes one and drafts again; DoveSoft pushes the same message id. */
  it('holds nobody again when a text filed under nobody is delivered again', async () => {
    const one = await holder(a, 'Jo')
    const two = await holder(b, 'Jo')
    expect(await inbound()).toMatchObject({ matched: 'none', why: 'ambiguous' })
    expect(await resumeContact(db, b.orgId, two, { expectedReason: sharedNumberHoldReason(NOON_IST) })).toBe(true)
    const since = await approved(b, two)
    const again = await inbound()
    expect(again).toEqual({ matched: 'none', why: 'duplicate', optOut: false, suppressed: false, optOutNotRecorded: false, optOutNotRecordedIn: [] })
    expect((await contact(two)).pausedAt).toBeNull()
    expect(await touch(since)).toMatchObject({ status: 'approved' })
    expect((await contact(one)).pausedAt).not.toBeNull()
    // Nothing more was written about it.
    expect(await audits('sms.inbound_unmatched')).toHaveLength(2)
    // A different message from the number is a new text, and holds them.
    await inbound({ providerMessageId: 'mo-2' })
    expect((await contact(two)).pausedAt).not.toBeNull()
  })

  /**
   * DoveSoft is answered 500 for a STOP filed under nobody whose suppression
   * failed, so it retries — and the retry must still write it, without
   * holding anybody again.
   */
  it('writes a STOP’s missing suppression on the retry, in the org that missed it, and holds nobody again', async () => {
    const one = await holder(a, 'Jo')
    const two = await holder(b, 'Jo')
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.org_id = '${b.orgId}'` })
    const first = await inbound({ text: 'STOP', log: log() })
    expect(first).toMatchObject({ matched: 'none', why: 'ambiguous', optOutNotRecorded: true, optOutNotRecordedIn: [{ orgId: b.orgId, contactId: two }] })
    expect(await suppressedIn()).toEqual([a.orgId])
    await resumeContact(db, a.orgId, one)
    const retry = await inbound({ text: 'STOP', log: log() })
    expect(retry).toEqual({ matched: 'none', why: 'duplicate', optOut: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] })
    expect(await suppressedIn()).toEqual([a.orgId, b.orgId].sort())
    expect((await contact(one)).pausedAt).toBeNull()
    const rows = await audits('sms.inbound_unmatched')
    expect(rows.filter((r) => (r.detail as Record<string, unknown>)['redelivered'] === true).map((r) => [r.orgId, r.detail])).toEqual([
      [b.orgId, { why: 'ambiguous', optOut: true, contacts: 1, redelivered: true, suppressed: true, messageHash: expect.any(String) }],
    ])
  })

  it('remembers a text filed under nobody by a hash of its id, never the id', async () => {
    await holder(a, 'Jo')
    await holder(b, 'Jo')
    await inbound({ providerMessageId: 'DS-MO-7781' })
    const rows = await audits('sms.inbound_unmatched')
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain('DS-MO-7781')
      expect((r.detail as Record<string, unknown>)['messageHash']).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  // -------------------------------------------------------------------------
  // [16]: a redelivered STOP finishes the other orgs' suppressions
  // -------------------------------------------------------------------------

  /**
   * The interruption: the reply committed — with its own org's suppression —
   * and the function was cut off before the other org's. DoveSoft got no
   * 200 and pushes it again.
   */
  it('writes the other orgs’ suppressions on a redelivery of a STOP whose first delivery was cut off', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, inA)
    await recordInboundReply(db, {
      orgId: a.orgId, contactId: inA, channel: 'sms', from: PHONE, subject: null, body: 'STOP', providerId: 'mo-1', now: NOON_IST,
    })
    expect(await suppressedIn()).toEqual([a.orgId])
    const again = await inbound({ text: 'STOP' })
    expect(again).toMatchObject({ matched: 'contact', contactId: inA, duplicate: true, optOutNotRecordedIn: [] })
    expect(await suppressedIn()).toEqual([a.orgId, b.orgId].sort())
    expect((await audits('sms.inbound_unmatched')).map((r) => [r.orgId, r.detail])).toEqual([
      [b.orgId, { why: 'ambiguous', optOut: true, contacts: 1, filedUnder: 'another_org', redelivered: true, suppressed: true }],
    ])
    // A third delivery finds nothing missing, and writes nothing.
    await inbound({ text: 'STOP' })
    expect(await audits('sms.inbound_unmatched')).toHaveLength(1)
    expect(inB).toBeTruthy()
  })

  it('re-attempts on a redelivery a suppression that failed in another org, and reports it if it fails again', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, inA)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.org_id = '${b.orgId}'` })
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.org_id = '${b.orgId}'` })
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ optOutNotRecordedIn: [{ orgId: b.orgId, contactId: inB }] })
    // The second trigger fires on the redelivery's attempt…
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ duplicate: true, optOutNotRecordedIn: [{ orgId: b.orgId, contactId: inB }] })
    // …and the third delivery writes it.
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ duplicate: true, optOutNotRecordedIn: [] })
    expect(await suppressedIn()).toEqual([a.orgId, b.orgId].sort())
  })

  it('does nothing more on a redelivery of an ordinary reply', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, inA)
    await inbound()
    await resumeContact(db, b.orgId, inB)
    expect(await inbound()).toMatchObject({ matched: 'contact', duplicate: true, optOutNotRecordedIn: [] })
    expect((await contact(inB)).pausedAt).toBeNull()
    expect(await audits('sms.inbound_unmatched')).toHaveLength(1)
  })
})
