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
  addSuppression, approveDraft, contactResumeByHand, pauseContactOverriding, pauseReasonClass, previewSend, recordInboundReply, recordInboundSms, replyQueueDraft,
  resumeContact, schema, sharedNumberHoldReason, smsDraft,
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

  /** Answering an older reply of theirs from /inbox ends only a reply's own pause — never the hold. */
  it('is not lifted by answering an earlier reply from /inbox', async () => {
    const one = await holder(a, 'Jo')
    await holder(a, 'Jo (personal)')
    await db.update(schema.contacts).set({ email: 'jo@rentman.in' }).where(eq(schema.contacts.id, one))
    const earlier = await recordInboundReply(db, {
      orgId: a.orgId, contactId: one, channel: 'email', from: 'jo@rentman.in', subject: 'Re: hello', body: 'Tell me more',
      providerId: '<r1@mail.test>', now: new Date(NOON_IST.getTime() - 3_600_000),
    })
    await resumeContact(db, a.orgId, one)
    const [email] = await db
      .insert(schema.campaigns)
      .values({ orgId: a.orgId, name: 'Replies', channel: 'email', autoSend: false, status: 'active' })
      .returning({ id: schema.campaigns.id })
    expect(await inbound()).toMatchObject({ matched: 'none', why: 'ambiguous' })
    const answer = await replyQueueDraft(db, {
      orgId: a.orgId, inboundTouchId: earlier.touchId, subject: 'Re: hello', body: 'Happy to.', campaignId: email!.id, actor: a.userId, now: NOON_IST,
    })
    expect(answer).toMatchObject({ ok: false, reason: 'paused_for_another_reason' })
    expect((await contact(one)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
  })

  /**
   * Review round 7, [2]: the same, for a holder still paused by that earlier
   * reply. `pauseContact` kept the reply's `replied <ISO>`, so answering the
   * reply from /inbox — which ends a reply's own pause — lifted the hold.
   * The hold now replaces a reply's pause, and says so on its row.
   */
  it('replaces the pause an unanswered reply caused, so answering that reply does not lift the hold', async () => {
    const one = await holder(a, 'Jo')
    await holder(a, 'Jo (personal)')
    await db.update(schema.contacts).set({ email: 'jo@rentman.in' }).where(eq(schema.contacts.id, one))
    const earlier = await recordInboundReply(db, {
      orgId: a.orgId, contactId: one, channel: 'email', from: 'jo@rentman.in', subject: 'Re: hello', body: 'Tell me more',
      providerId: '<r1@mail.test>', now: new Date(NOON_IST.getTime() - 3_600_000),
    })
    expect(pauseReasonClass((await contact(one)).pausedReason)).toBe('replied')
    const [email] = await db
      .insert(schema.campaigns)
      .values({ orgId: a.orgId, name: 'Replies', channel: 'email', autoSend: false, status: 'active' })
      .returning({ id: schema.campaigns.id })
    expect(await inbound()).toMatchObject({ matched: 'none', why: 'ambiguous' })
    expect((await contact(one)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    const answer = await replyQueueDraft(db, {
      orgId: a.orgId, inboundTouchId: earlier.touchId, subject: 'Re: hello', body: 'Happy to.', campaignId: email!.id, actor: a.userId, now: NOON_IST,
    })
    expect(answer).toMatchObject({ ok: false, reason: 'paused_for_another_reason' })
    expect((await contact(one)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    const [row] = await audits('sms.inbound_unmatched')
    expect(row?.detail).toMatchObject({ contacts: 2, paused: 2, replacedPauseFor: 'replied', replacedPauses: 1 })
  })

  it('keeps any other pause a holder already had, and says nothing replaced', async () => {
    const one = await holder(a, 'Jo')
    await holder(a, 'Jo (personal)')
    await db.update(schema.contacts).set({ pausedAt: NOON_IST, pausedReason: 'on leave until October' }).where(eq(schema.contacts.id, one))
    expect(await inbound()).toMatchObject({ matched: 'none', why: 'ambiguous' })
    expect((await contact(one)).pausedReason).toBe('on leave until October')
    const [row] = await audits('sms.inbound_unmatched')
    expect(row?.detail).toMatchObject({ contacts: 2, paused: 1 })
    expect(row?.detail).not.toHaveProperty('replacedPauseFor')
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
    // Org B's loud path ran where the failure is: its contact held hard, and
    // one row about the number in its org — never naming inB as the one who
    // asked, which the inbox reads as their own opt-out for good (round 8).
    expect(pauseReasonClass((await contact(inB)).pausedReason)).toBe('opt_out_not_recorded')
    expect((await audits('contact.opt_out_not_recorded')).map((r) => [r.orgId, r.subjectType, r.subjectId, r.detail])).toEqual([
      [b.orgId, null, null, { channel: 'sms', why: expect.any(String), sharedNumber: true, contacts: 1, paused: 1, holders: [inB] }],
    ])
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
    if (r.matched !== 'contact') throw new Error('filed')
    expect(await suppressedIn()).toEqual([])
    for (const id of [filed, coHolder]) expect(pauseReasonClass((await contact(id)).pausedReason)).toBe('opt_out_not_recorded')
    expect(await touch(waiting)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
    expect(await willSend(a, coHolder)).toMatchObject({ allowed: false })
    // The filed contact's own row names them; the co-holder's is about the
    // text that asked, and names them only among its holders (round 8).
    expect((await audits('contact.opt_out_not_recorded')).map((x) => [x.subjectType, x.subjectId, (x.detail as Record<string, unknown>)['sharedNumber'] ?? null])).toEqual([
      ['contact', filed, null],
      ['touch', r.touchId, true],
    ])
    const [row] = await audits('sms.inbound_unmatched')
    expect(row?.detail).toMatchObject({ filedUnder: 'another_contact', optOut: true, suppressed: false })
    const hard = await contact(coHolder)
    expect(await contactResumeByHand(db, { orgId: a.orgId, contact: { id: coHolder }, expectedReason: hard.pausedReason, actor: a.userId })).toMatchObject({
      ok: false, reason: 'opt_out_not_recorded',
    })

    // DoveSoft's retry, which the 500 asks for, writes the suppression — and
    // the co-holder is eased to the ordinary hold, which Resume lifts. The
    // filed contact asked: their own pause stands.
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ duplicate: true, suppressed: true, optOutNotRecorded: false })
    expect(await suppressedIn()).toEqual([a.orgId])
    const eased = await contact(coHolder)
    expect(eased.pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    expect(pauseReasonClass((await contact(filed)).pausedReason)).toBe('opt_out_not_recorded')
    expect((await audits('sms.inbound_unmatched')).map((x) => x.detail).at(-1)).toEqual({
      why: 'ambiguous', optOut: true, contacts: 1, released: 1, filedUnder: 'another_contact', redelivered: true, suppressed: true,
    })
    expect(await contactResumeByHand(db, { orgId: a.orgId, contact: { id: coHolder }, expectedReason: eased.pausedReason, actor: a.userId })).toMatchObject({
      ok: true,
    })
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
      [b.orgId, { why: 'ambiguous', optOut: true, contacts: 1, redelivered: true, suppressed: true, released: 1, messageHash: expect.any(String) }],
    ])
    // Org B's holder was held hard while its suppression was missing, and
    // the retry that wrote it eased them to the ordinary hold (round 8).
    expect((await contact(two)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
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

  /**
   * Review round 7, [1]/[3]: the filed org's OWN suppression is re-attempted
   * on a redelivery too, so the 500 the route answers for it is finished by
   * DoveSoft's retry like another org's.
   */
  it('re-attempts on a redelivery the filed org’s own suppression that failed, and records it', async () => {
    const inA = await holder(a, 'Jo')
    await texted(a, inA)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ contactId: inA, suppressed: false, optOutNotRecorded: true })
    expect(await suppressedIn()).toEqual([])
    const again = await inbound({ text: 'STOP', log: log() })
    expect(again).toMatchObject({ contactId: inA, duplicate: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] })
    expect(await suppressedIn()).toEqual([a.orgId])
    // Recorded as a suppression a person can read; the contact stays paused saying it was not recorded at the time.
    expect((await audits('suppression.added')).map((r) => [r.orgId, r.actor, (r.detail as Record<string, unknown>)['kind']])).toEqual([
      [a.orgId, 'system', 'phone'],
    ])
    expect(pauseReasonClass((await contact(inA)).pausedReason)).toBe('opt_out_not_recorded')
    // Nothing left to write: a third delivery writes nothing.
    expect(await inbound({ text: 'STOP' })).toMatchObject({ duplicate: true, optOutNotRecorded: false })
    expect(await audits('suppression.added')).toHaveLength(1)
  })

  /**
   * Review round 8, [7]: a person records the number on /suppressions —
   * following the first delivery's alarm — while DoveSoft's redelivery is
   * finishing. The redelivery read it as missing, its insert met the
   * person's row, and it appended a `suppression.added` by System beside the
   * person's own: one suppression, two people claiming it, in rows that
   * outlive an erasure. Simulated by a trigger that writes the person's row
   * just before the redelivery's insert, as a transaction committing in that
   * window would.
   */
  it('logs no System suppression on a redelivery whose insert found the one a person had just recorded', async () => {
    const inA = await holder(a, 'Jo')
    await texted(a, inA)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ contactId: inA, suppressed: false, optOutNotRecorded: true })
    await test.pg.exec(`
      CREATE TABLE person_recorded_it (at timestamptz);
      CREATE FUNCTION person_records_it() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() = 1 AND NOT EXISTS (SELECT 1 FROM person_recorded_it) THEN
          INSERT INTO person_recorded_it VALUES (now());
          INSERT INTO suppressions (org_id, kind, value, reason, source)
            VALUES (NEW.org_id, NEW.kind, NEW.value, 'recorded by hand after the alarm', 'manual');
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER person_records_it BEFORE INSERT ON suppressions FOR EACH ROW EXECUTE FUNCTION person_records_it();
    `)
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ duplicate: true, suppressed: true, optOutNotRecorded: false })
    expect((await db.select().from(schema.suppressions)).map((r) => [r.orgId, r.source, r.reason])).toEqual([
      [a.orgId, 'manual', 'recorded by hand after the alarm'],
    ])
    expect(await audits('suppression.added')).toEqual([])
    expect(await audits('suppression.already_present')).toEqual([])
  })

  it('takes the loud path again, naming the filed contact, when the redelivery’s re-attempt fails too', async () => {
    const inA = await holder(a, 'Jo')
    await texted(a, inA)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
    await inbound({ text: 'STOP', log: log() })
    const l = log()
    expect(await inbound({ text: 'STOP', log: l })).toMatchObject({ duplicate: true, suppressed: false, optOutNotRecorded: true, optOutNotRecordedIn: [] })
    expect((await audits('contact.opt_out_not_recorded')).map((r) => [r.orgId, r.subjectId])).toEqual([
      [a.orgId, inA],
      [a.orgId, inA],
    ])
    expect(l.lines.map((x) => x.message)).toContain('OPT-OUT NOT RECORDED — follow up by hand')
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

  // -------------------------------------------------------------------------
  // Review round 7, [0] + [4]: a STOP whose recording throws leaves nobody
  // holding the number resumable and unrecorded
  // -------------------------------------------------------------------------

  /** What a test reads off a recording that threw. */
  const thrown = (p: Promise<unknown>): Promise<Record<string, unknown>> =>
    p.then(
      () => {
        throw new Error('expected the recording to throw')
      },
      (err: unknown) => err as Record<string, unknown>,
    )

  /**
   * The reviewer's probe: `work` was texted, `twin` holds the number in the
   * same org, `inB` in another org with an approved SMS — and the STOP's
   * inbound insert faults. The holds came first and the rest after the
   * reply, so the twin and inB kept a `held:` pause a teammate could lift,
   * and org B had no suppression, no row and no alarm. Now org B's
   * suppression is written before the reply, and the twin — whose org's one
   * suppression rolled back with the reply — takes the loud path.
   */
  it('suppresses the other org before the reply, and takes the loud path for a twin, when recording a STOP throws', async () => {
    const work = await holder(a, 'Jo (work)')
    const twin = await holder(a, 'Jo (personal)')
    const inB = await holder(b, 'Jo')
    await texted(a, work)
    const waitingB = await approved(b, inB)
    await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: `NEW.direction = 'in'` })
    const err = await thrown(inbound({ text: 'Wrong number. STOP', log: log() }))
    expect(err).toMatchObject({
      name: 'SmsOptOutNotRecorded',
      fault: expect.any(String),
      filingUnder: { orgId: a.orgId, contactId: work },
      optOutNotRecordedIn: [],
    })
    // §2.3: the error carries ids and a class — never the number or the words.
    expect(JSON.stringify({ ...err, message: err['message'] })).not.toContain('9876543210')
    expect(String(err['message'])).not.toContain('Wrong number')

    // Org B was told to stop: its suppression is written, its row says so,
    // and nothing can go to inB even if a teammate lifts the hold.
    expect(await suppressedIn()).toEqual([b.orgId])
    expect(await touch(waitingB)).toMatchObject({ status: 'refused', refusalCode: 'paused' })
    expect((await audits('sms.inbound_unmatched')).map((r) => [r.orgId, r.detail])).toEqual([
      [b.orgId, { why: 'ambiguous', optOut: true, contacts: 1, paused: 1, cancelledQueued: 1, filedUnder: 'another_org', suppressed: true }],
    ])
    const heldB = await contact(inB)
    expect(await contactResumeByHand(db, { orgId: b.orgId, contact: { id: inB }, expectedReason: heldB.pausedReason, actor: b.userId })).toMatchObject({ ok: true })
    expect(
      await smsDraft(db, { orgId: b.orgId, contactId: inB, campaignId: b.campaignId, templateId: b.templateId, vars: ['Jo', '3pm'], createdBy: b.userId, now: NOON_IST }),
    ).toMatchObject({ ok: false, reason: 'refused', code: 'suppressed' })

    // The twin: org A's one suppression rolled back with the reply, so the
    // twin is paused saying the opt-out was not recorded, which Resume refuses.
    const t = await contact(twin)
    expect(pauseReasonClass(t.pausedReason)).toBe('opt_out_not_recorded')
    expect(await contactResumeByHand(db, { orgId: a.orgId, contact: { id: twin }, expectedReason: t.pausedReason, actor: a.userId })).toMatchObject({
      ok: false, reason: 'opt_out_not_recorded',
    })
    // As a holder of the number, never as the one who asked (round 8): the
    // row is about the text, with no subject — none is stored — and names
    // the twin only among its holders.
    expect((await audits('contact.opt_out_not_recorded')).map((r) => [r.orgId, r.subjectType, r.subjectId, r.detail])).toEqual([
      [a.orgId, null, null, { channel: 'sms', why: 'record_failed', sharedNumber: true, contacts: 1, paused: 1, holders: [twin] }],
    ])

    // DoveSoft retries and the STOP is recorded, in both orgs.
    expect(await inbound({ text: 'Wrong number. STOP', log: log() })).toMatchObject({
      matched: 'contact', contactId: work, duplicate: false, suppressed: true, optOutNotRecordedIn: [],
    })
    expect(await suppressedIn()).toEqual([a.orgId, b.orgId].sort())
  })

  /**
   * Review round 8, [0], the reviewer's probe: the same fault, and the retry
   * that records the STOP. The twin was left paused as an opt-out nobody
   * recorded, named by a row /inbox reads however old — Resume refused, and
   * their own later email reply could never be answered, though the number
   * WAS suppressed. The retry now eases them, as the fault-free delivery
   * would have held them.
   */
  it('eases the twin to a hold Resume lifts once the retry records the STOP, and their own email can be answered', async () => {
    const work = await holder(a, 'Jo (work)')
    const twin = await holder(a, 'Jo (reception)')
    await db.update(schema.contacts).set({ email: 'reception@rentman.in' }).where(eq(schema.contacts.id, twin))
    await texted(a, work)
    await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: `NEW.direction = 'in'` })
    const err = await thrown(inbound({ text: 'Wrong number. STOP', log: log() }))
    expect(err).toMatchObject({ name: 'SmsOptOutNotRecorded', filingUnder: { orgId: a.orgId, contactId: work } })
    // The route's loud path for the contact it was being filed under, from the error.
    await pauseContactOverriding(db, a.orgId, work, `opt-out not recorded: reply ${NOON_IST.toISOString()} (record_failed)`, NOON_IST)
    expect(pauseReasonClass((await contact(twin)).pausedReason)).toBe('opt_out_not_recorded')

    expect(await inbound({ text: 'Wrong number. STOP', log: log() })).toMatchObject({ matched: 'contact', contactId: work, suppressed: true })
    expect(await suppressedIn()).toEqual([a.orgId])
    const eased = await contact(twin)
    expect(eased.pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    expect(pauseReasonClass(eased.pausedReason)).toBe('other')
    const [row] = await audits('sms.inbound_unmatched')
    expect(row).toMatchObject({ orgId: a.orgId, detail: { filedUnder: 'another_contact', released: 1, suppressed: true } })
    expect(await contactResumeByHand(db, { orgId: a.orgId, contact: { id: twin }, expectedReason: eased.pausedReason, actor: a.userId })).toMatchObject({
      ok: true,
    })

    // Their own later email reply, and answering it: nothing reads the
    // shared number's STOP as theirs.
    const [email] = await db
      .insert(schema.campaigns)
      .values({ orgId: a.orgId, name: 'Email', channel: 'email', autoSend: false, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const later = new Date(NOON_IST.getTime() + 86_400_000)
    const reply = await recordInboundReply(db, {
      orgId: a.orgId, contactId: twin, channel: 'email', from: 'reception@rentman.in', subject: 'Re: hi', body: 'Can you send pricing?',
      providerId: '<rec-1@rentman.in>', now: later,
    })
    expect(
      await replyQueueDraft(db, {
        orgId: a.orgId, inboundTouchId: reply.touchId, subject: 'Re: hi', body: 'Pricing attached.', campaignId: email!.id, actor: a.userId, now: later,
      }),
    ).toMatchObject({ ok: true })
    // The contact who asked keeps their own pause: their opt-out was the one not recorded at the time.
    expect(pauseReasonClass((await contact(work)).pausedReason)).toBe('opt_out_not_recorded')
  })

  /** Only that exact shape is eased: an asker's own unrecorded opt-out, or a teammate's pause, stands. */
  it('eases nothing but the hard hold a shared number’s unrecorded STOP left', async () => {
    const work = await holder(a, 'Jo (work)')
    const own = await holder(a, 'Jo (own)')
    const manual = await holder(a, 'Jo (manual)')
    await texted(a, work)
    const OWN = `opt-out not recorded: reply ${NOON_IST.toISOString()} (record_failed)`
    await db.update(schema.contacts).set({ pausedAt: NOON_IST, pausedReason: OWN }).where(eq(schema.contacts.id, own))
    await db.update(schema.contacts).set({ pausedAt: NOON_IST, pausedReason: 'legal hold (by sam@agency.test)' }).where(eq(schema.contacts.id, manual))
    expect(await inbound({ text: 'STOP' })).toMatchObject({ suppressed: true })
    expect((await contact(own)).pausedReason).toBe(OWN)
    expect((await contact(manual)).pausedReason).toBe('legal hold (by sam@agency.test)')
    expect(((await audits('sms.inbound_unmatched'))[0]?.detail as Record<string, unknown>)['released']).toBeUndefined()
  })

  /**
   * Review round 9, [6], the reviewer's probe: RESUME_SHARED_NUMBER promises
   * that once the number is recorded "the next text from the number lifts it
   * to an ordinary hold" — but only another STOP eased anybody. A person
   * records the number by hand (the push had no message id, so no retry
   * came), and the number's next text, an ordinary one, left the twin held
   * hard. Now any text does, where the number is suppressed in their org.
   */
  it('eases a hard-held twin by the number’s next ordinary text, once a person has recorded the number', async () => {
    const work = await holder(a, 'Jo (work)')
    const twin = await holder(a, 'Jo (reception)')
    await texted(a, work)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
    expect(await inbound({ text: 'Wrong number. STOP', providerMessageId: null, log: log() })).toMatchObject({
      matched: 'contact', contactId: work, optOutNotRecorded: true,
    })
    expect(pauseReasonClass((await contact(twin)).pausedReason)).toBe('opt_out_not_recorded')

    // An ordinary text before anybody records it eases nobody: the number is unsuppressed.
    const early = new Date(NOON_IST.getTime() + 60_000)
    await inbound({ text: 'Sorry, who is this?', providerMessageId: 'mo-2', receivedAt: early })
    expect(pauseReasonClass((await contact(twin)).pausedReason)).toBe('opt_out_not_recorded')

    await addSuppression(db, { orgId: a.orgId, kind: 'phone', value: PHONE, reason: 'recorded by hand', source: 'manual' })
    const next = new Date(NOON_IST.getTime() + 3_600_000)
    expect(await inbound({ text: 'Is the meeting still on?', providerMessageId: 'mo-3', receivedAt: next })).toMatchObject({
      matched: 'contact', contactId: work,
    })
    expect((await contact(twin)).pausedReason).toBe(sharedNumberHoldReason(next))
    expect((await audits('sms.inbound_unmatched')).map((r) => r.detail).at(-1)).toMatchObject({
      why: 'ambiguous', optOut: false, filedUnder: 'another_contact', released: 1,
    })
    const eased = await contact(twin)
    expect(await contactResumeByHand(db, { orgId: a.orgId, contact: { id: twin }, expectedReason: eased.pausedReason, actor: a.userId })).toEqual({ ok: true })
    // The contact the STOP was filed under asked: their own pause stands.
    expect(pauseReasonClass((await contact(work)).pausedReason)).toBe('opt_out_not_recorded')
  })

  it('eases the holders of a STOP filed under nobody by the number’s next ordinary text, in the org that recorded it', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.org_id = '${a.orgId}'` })
    expect(await inbound({ text: 'STOP', providerMessageId: null, log: log() })).toMatchObject({
      matched: 'none', why: 'ambiguous', optOutNotRecorded: true, optOutNotRecordedIn: [{ orgId: a.orgId, contactId: inA }],
    })
    expect(pauseReasonClass((await contact(inA)).pausedReason)).toBe('opt_out_not_recorded')
    expect(pauseReasonClass((await contact(inB)).pausedReason)).toBe('other')

    await addSuppression(db, { orgId: a.orgId, kind: 'phone', value: PHONE, reason: 'recorded by hand', source: 'manual' })
    const next = new Date(NOON_IST.getTime() + 3_600_000)
    expect(await inbound({ text: 'Hello?', providerMessageId: 'mo-2', receivedAt: next })).toMatchObject({ matched: 'none', why: 'ambiguous' })
    expect((await contact(inA)).pausedReason).toBe(sharedNumberHoldReason(next))
    const rows = (await audits('sms.inbound_unmatched')).filter((r) => (r.detail as Record<string, unknown>)['optOut'] === false)
    expect(rows.map((r) => [r.orgId, (r.detail as Record<string, unknown>)['released']]).sort()).toEqual(
      [[a.orgId, 1], [b.orgId, undefined]].sort(),
    )
  })

  it('names another org whose suppression failed too, after its loud path ran, for the route to alarm', async () => {
    const work = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, work)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.org_id = '${b.orgId}'` })
    await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: `NEW.direction = 'in'` })
    const err = await thrown(inbound({ text: 'STOP', log: log() }))
    expect(err).toMatchObject({
      name: 'SmsOptOutNotRecorded',
      filingUnder: { orgId: a.orgId, contactId: work },
      optOutNotRecordedIn: [{ orgId: b.orgId, contactId: inB }],
    })
    expect(await suppressedIn()).toEqual([])
    const held = await contact(inB)
    expect(pauseReasonClass(held.pausedReason)).toBe('opt_out_not_recorded')
    expect(await contactResumeByHand(db, { orgId: b.orgId, contact: { id: inB }, expectedReason: held.pausedReason, actor: b.userId })).toMatchObject({ ok: false })
    expect((await audits('contact.opt_out_not_recorded')).map((r) => [r.orgId, r.subjectId, (r.detail as Record<string, unknown>)['holders']])).toEqual([
      [b.orgId, null, [inB]],
    ])
    // The retry records it everywhere, and eases org B's holder (round 8).
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ matched: 'contact', suppressed: true, optOutNotRecordedIn: [] })
    expect(await suppressedIn()).toEqual([a.orgId, b.orgId].sort())
    expect(pauseReasonClass((await contact(inB)).pausedReason)).toBe('other')
  })

  it('throws the fault itself for an ordinary text whose recording failed — nothing to be loud about', async () => {
    const work = await holder(a, 'Jo')
    await holder(b, 'Jo')
    await texted(a, work)
    await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: `NEW.direction = 'in'` })
    const err = await thrown(inbound({ text: 'Who is this?' }))
    expect(err['name']).not.toBe('SmsOptOutNotRecorded')
    expect(await suppressedIn()).toEqual([])
    expect(await audits('contact.opt_out_not_recorded')).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Review round 7, [8]: a fault after something was written is not "nothing
  // was written"
  // -------------------------------------------------------------------------

  /** Raise the Nth `UPDATE` of `contacts` an engine fault, and no other. */
  async function failNthContactUpdate(n: number): Promise<void> {
    await test.pg.exec(`
      CREATE SEQUENCE nth_contact_update_seq;
      CREATE FUNCTION nth_contact_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('nth_contact_update_seq') = ${n} THEN
          RAISE EXCEPTION 'injected fault on UPDATE contacts';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER nth_contact_update BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION nth_contact_update();
    `)
  }

  /**
   * The holds are one transaction per org: the first org's committed and
   * the second's faulted. The route's "nobody was paused" was false of the
   * first, and its contacts kept a `held:` pause anyone could lift. A STOP
   * now takes the loud path for every holder, and says which orgs were held.
   */
  it('takes the loud path for every holder of a STOP whose holds failed part way, and says which org was held', async () => {
    const inA = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await failNthContactUpdate(2)
    const err = await thrown(inbound({ text: 'STOP', log: log() }))
    expect(err).toMatchObject({ name: 'SmsOptOutNotRecorded', filingUnder: null })
    expect(err['heldIn']).toHaveLength(1)
    expect([a.orgId, b.orgId]).toContain((err['heldIn'] as string[])[0])
    expect((err['optOutNotRecordedIn'] as { orgId: string }[]).map((l) => l.orgId).sort()).toEqual([a.orgId, b.orgId].sort())
    for (const id of [inA, inB]) expect(pauseReasonClass((await contact(id)).pausedReason)).toBe('opt_out_not_recorded')
    // One row per org, about the number: neither holder is the one who asked.
    expect(
      (await audits('contact.opt_out_not_recorded')).map((r) => [r.orgId, r.subjectId, (r.detail as Record<string, unknown>)['holders']]).sort(),
    ).toEqual([[a.orgId, null, [inA]], [b.orgId, null, [inB]]].sort())
    // Nothing was filed under nobody yet, so the retry is not a redelivery: it records the STOP…
    expect(await inbound({ text: 'STOP', log: log() })).toMatchObject({ matched: 'none', why: 'ambiguous', suppressed: true })
    expect(await suppressedIn()).toEqual([a.orgId, b.orgId].sort())
    // …and eases both, as the fault-free delivery would have held them (round 8).
    for (const id of [inA, inB]) expect((await contact(id)).pausedReason).toBe(sharedNumberHoldReason(NOON_IST))
    expect((await audits('sms.inbound_unmatched')).map((r) => (r.detail as Record<string, unknown>)['released'])).toEqual([1, 1])
  })

  it('takes the loud path for the others, and names whose it was being filed under, when the holds fail before the reply', async () => {
    const work = await holder(a, 'Jo')
    const inB = await holder(b, 'Jo')
    await texted(a, work)
    await failOnce(test.pg, { table: 'contacts', event: 'UPDATE' })
    const err = await thrown(inbound({ text: 'STOP', log: log() }))
    expect(err).toMatchObject({
      name: 'SmsOptOutNotRecorded',
      filingUnder: { orgId: a.orgId, contactId: work },
      heldIn: [],
      optOutNotRecordedIn: [{ orgId: b.orgId, contactId: inB }],
    })
    expect(pauseReasonClass((await contact(inB)).pausedReason)).toBe('opt_out_not_recorded')
    // The filed contact is the route's to pause and alarm, from the error.
    expect((await contact(work)).pausedAt).toBeNull()
  })

  /** A database whose Nth top-level `select` throws — the reads `finishRedelivered` makes. */
  function failingSelect(n: number): AgencyDb {
    let selects = 0
    return new Proxy(db as object, {
      get(t, p, r) {
        if (p === 'select') {
          return (...args: unknown[]) => {
            if (++selects === n) throw Object.assign(new Error(`Failed query: select … params: ${PHONE},STOP`), { name: 'DrizzleQueryError' })
            return (Reflect.get(t, p, r) as (...a: unknown[]) => unknown).apply(t, args)
          }
        }
        return Reflect.get(t, p, r)
      },
    }) as AgencyDb
  }

  /**
   * The probe: a STOP recorded and suppressed, then a redelivery whose
   * finishing read faults. It escaped as a bare fault, and the route filed
   * "recording the text failed before anything was written … nobody was
   * paused" while the suppression and the pause existed.
   */
  it('says a redelivery could not be finished, naming the text it was, when finishing it faults', async () => {
    const inA = await holder(a, 'Jo')
    await texted(a, inA)
    expect(await inbound({ text: 'STOP' })).toMatchObject({ suppressed: true })
    const err = await thrown(
      recordInboundSms(failingSelect(2), { from: PHONE, text: 'STOP', providerMessageId: 'mo-1', receivedAt: NOON_IST, log: log() }),
    )
    expect(err).toMatchObject({ name: 'SmsRedeliveryIncomplete', fault: 'DrizzleQueryError', orgId: a.orgId, contactId: inA })
    expect(String(err['message'])).not.toContain('9876543210')
    expect(await audits('contact.opt_out_not_recorded')).toEqual([])
  })

  it('says so for a redelivered STOP filed under nobody, too', async () => {
    await holder(a, 'Jo')
    await holder(b, 'Jo')
    expect(await inbound({ text: 'STOP' })).toMatchObject({ matched: 'none', why: 'ambiguous', suppressed: true })
    // findInbound, holdersOf, filedUnderNobodyBefore — then the read of what is missing.
    const err = await thrown(
      recordInboundSms(failingSelect(4), { from: PHONE, text: 'STOP', providerMessageId: 'mo-1', receivedAt: NOON_IST, log: log() }),
    )
    expect(err).toMatchObject({ name: 'SmsRedeliveryIncomplete', fault: 'DrizzleQueryError', orgId: null, contactId: null })
  })
})
