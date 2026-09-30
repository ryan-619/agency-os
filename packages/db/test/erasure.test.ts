/**
 * A person's record, and an erasure that keeps the suppression (§2.1, §2.3),
 * against a real engine.
 *
 * The tests that matter are the ones where erasing would be easy and wrong:
 * a key that cannot be stored (the erasure must abort and erase NOTHING), a
 * database that throws half-way (the suppressions already written must roll
 * back with everything else), a domain row that would silence a whole
 * company, an opt-out whose own key the compliance page needs, and another
 * contact — or another agency — whose rows must not move.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { schema, type AgencyDb, type InboundLog } from '../src/index.js'
import {
  addSuppression, appendAudit, auditSuppressionAdded, auditSuppressionRemoved, bookInbound,
  complianceOptOutsWithoutSuppression, erasureErase, erasureInboundDomainFor, erasureRecord, ERASURE_NOT_INCLUDED,
  ERASURE_PLACEHOLDER, pauseReasonClass, removeSuppression, replyQueueDraft,
} from '../src/queries.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOON = new Date('2026-09-15T12:00:00.000Z')

function capturingLog(): InboundLog & { lines: { message: string; fields: Record<string, unknown> }[] } {
  const lines: { message: string; fields: Record<string, unknown> }[] = []
  return { lines, error: (message, fields) => void lines.push({ message, fields: { ...fields } }) }
}

describe('a contact’s record and their erasure', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let companyId: string
  let campaignId: string
  let priya: string
  let tom: string

  /** Ids of everything written for Priya, and for Tom, so a test can say "exactly these". */
  const ids = {
    priya: { touches: [] as string[], meetings: [] as string[], calls: [] as string[], notes: [] as string[], tasks: [] as string[] },
    tom: { touches: [] as string[], meetings: [] as string[], calls: [] as string[], notes: [] as string[], tasks: [] as string[] },
  }
  let companyNote: string
  let priyaOut: string
  let priyaIn: string
  let priyaQueued: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    for (const k of ['priya', 'tom'] as const) for (const t of Object.values(ids[k])) t.length = 0

    const [org] = await db.insert(schema.orgs).values({ name: 'Northwind Security', bookingSlug: 'northwind' }).returning()
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Somebody Else' }).returning()
    otherOrgId = other!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning()
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/London' })
      .returning()
    companyId = company!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4', channel: 'email', autoSend: true, dailyCap: 25, status: 'active' })
      .returning()
    campaignId = campaign!.id

    const [p] = await db
      .insert(schema.contacts)
      .values({
        orgId, companyId, firstName: 'Priya', lastName: 'Sharma', email: 'Priya@Rentman.io',
        phone: '+44 20 7946 0000', linkedinUrl: 'https://www.linkedin.com/in/priya-sharma/', timeZone: 'Europe/London',
      })
      .returning()
    priya = p!.id
    const [t] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Tom', email: 'tom@rentman.io', phone: '+442079460001', timeZone: 'Europe/London' })
      .returning()
    tom = t!.id

    for (const [contactId, who] of [[priya, 'priya'], [tom, 'tom']] as const) {
      await db.insert(schema.consents).values([
        { orgId, contactId, channel: 'email', granted: true, source: 'booking page', evidence: { wording: 'You may email me.' } },
        { orgId, contactId, channel: 'sms', granted: false, source: 'said no on a call' },
      ])
      const email = who === 'priya' ? 'priya.old@rentman.io' : 'tom@rentman.io'
      const [out] = await db
        .insert(schema.touches)
        .values({
          orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent', sentAt: NOON,
          recipient: email, providerId: `<${who}@agency.test>`, subject: 'A gap on your security page',
          body: 'Hello — we noticed your security page is missing.', error: null,
        })
        .returning()
      const [inbound] = await db
        .insert(schema.touches)
        .values({
          orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', sentAt: NOON,
          recipient: email, subject: 'Re: A gap', body: `This is ${who}, writing back in my own words.`,
          inReplyTo: out!.id, replyKind: 'interested',
        })
        .returning()
      const [queued] = await db
        .insert(schema.touches)
        .values({
          orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval',
          subject: 'Following up', body: 'A follow-up.',
        })
        .returning()
      ids[who].touches.push(out!.id, inbound!.id, queued!.id)
      if (who === 'priya') {
        priyaOut = out!.id
        priyaIn = inbound!.id
        priyaQueued = queued!.id
      }

      const [meeting] = await db
        .insert(schema.meetings)
        .values({
          orgId, companyId, contactId, title: `Intro call with ${who}`, startsAt: NOON, timeZone: 'Europe/London',
          source: 'booking_page', notes: `${who} wrote: please call my mobile.`,
        })
        .returning()
      ids[who].meetings.push(meeting!.id)

      const [call] = await db
        .insert(schema.calls)
        .values({
          orgId, contactId, companyId, direction: 'in', status: 'completed',
          fromNumber: who === 'priya' ? '+447946000099' : '+442079460001', toNumber: '+442000000000',
          providerCallSid: `CA-${who}`, recordingUrl: `https://api.twilio.com/recordings/RE-${who}`,
          transcript: [{ role: 'caller', text: `I am ${who}` }], summary: `${who} asked about pricing`,
        })
        .returning()
      ids[who].calls.push(call!.id)

      const [note] = await db
        .insert(schema.notes)
        .values({ orgId, companyId, contactId, authorUserId: userId, body: `${who} prefers mornings` })
        .returning()
      ids[who].notes.push(note!.id)

      const [task] = await db
        .insert(schema.tasks)
        .values({ orgId, companyId, touchId: out!.id, kind: 'todo', title: `Follow up with ${who}` })
        .returning()
      ids[who].tasks.push(task!.id)
    }

    const [cn] = await db
      .insert(schema.notes)
      .values({ orgId, companyId, contactId: null, authorUserId: userId, body: 'The company uses Cloudflare.' })
      .returning()
    companyNote = cn!.id

    // History that must survive the erasure: the audit log is append-only.
    await appendAudit(db, { orgId, actor: userId, action: 'contact.created', subjectType: 'contact', subjectId: priya })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const erase = (over: Partial<Parameters<typeof erasureErase>[1]> = {}) =>
    erasureErase(db, { orgId, contactId: priya, actor: userId, now: NOON, log: capturingLog(), ...over })
  const suppressions = (org = orgId) =>
    db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, org))
  const audit = (action: string) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))
  const touch = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const contactExists = async (id: string) =>
    (await db.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.id, id))).length === 1

  // -------------------------------------------------------------------------
  // The record
  // -------------------------------------------------------------------------

  describe('the record', () => {
    it('holds every table’s rows for the person, and none from another contact', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'asked', source: 'manual' })
      await addSuppression(db, { orgId, kind: 'email', value: 'tom@rentman.io', reason: 'asked', source: 'manual' })

      const r = await erasureRecord(db, orgId, priya, NOON)
      expect(r).not.toBeNull()
      if (!r) return
      expect(r.format).toBe('agency-os.contact-record')
      expect(r.contact.id).toBe(priya)
      expect(r.company).toEqual({ id: companyId, domain: 'rentman.io', name: 'Rentman' })
      expect(r.consents.map((c) => c.channel)).toEqual(['email', 'sms'])
      expect(r.consents.every((c) => c.contactId === priya)).toBe(true)
      // Consent evidence is part of what is held.
      expect(r.consents[0]!.evidence).toEqual({ wording: 'You may email me.' })
      expect(r.touches.map((t) => t.id).sort()).toEqual([...ids.priya.touches].sort())
      expect(r.meetings.map((m) => m.id)).toEqual(ids.priya.meetings)
      expect(r.calls.map((c) => c.id)).toEqual(ids.priya.calls)
      expect(r.notes.map((n) => n.id)).toEqual(ids.priya.notes)
      expect(r.tasks.map((t) => t.id)).toEqual(ids.priya.tasks)
      expect(r.suppressions.map((s) => s.value)).toEqual(['priya@rentman.io'])
      // The file says what it does not hold.
      expect(r.notIncluded.join(' ')).toMatch(/Chat transcripts/)
      expect(r.notIncluded.join(' ')).toMatch(/Audit log/)

      // Nothing of Tom's, anywhere in it.
      const text = JSON.stringify(r)
      expect(text).not.toContain(tom)
      expect(text).not.toContain('tom@rentman.io')
      expect(text).not.toContain(companyNote)
    })

    /**
     * The suppression list's own history is the one place the append-only
     * audit log holds an address — and an erasure keeps it, for the reason it
     * keeps the suppression. The record used to say the audit log held no
     * address and left these rows out; now it carries them, and says so.
     */
    it('carries the audit log’s suppression history for their keys, and says it is kept', async () => {
      // A person adds her current address, and later an owner removes it.
      const added = await addSuppression(db, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'asked', source: 'manual' })
      if (!added.ok) throw new Error('not added')
      await appendAudit(db, auditSuppressionAdded({
        orgId, actor: userId, alreadyPresent: false, kind: 'email', value: added.value, reason: 'asked',
      }))
      const removed = await removeSuppression(db, orgId, (await suppressions())[0]!.id)
      if (!removed) throw new Error('not removed')
      await appendAudit(db, auditSuppressionRemoved({ orgId, actor: userId, removed }))
      // The address a message actually went to, and her phone, have history too.
      await appendAudit(db, auditSuppressionAdded({
        orgId, actor: userId, alreadyPresent: false, kind: 'email', value: 'priya.old@rentman.io', reason: 'bounced twice',
      }))
      // Tom's, and another org's with her address, are not hers.
      await appendAudit(db, auditSuppressionAdded({
        orgId, actor: userId, alreadyPresent: false, kind: 'email', value: 'tom@rentman.io', reason: 'asked',
      }))
      await appendAudit(db, auditSuppressionAdded({
        orgId: otherOrgId, actor: 'system', alreadyPresent: false, kind: 'email', value: 'priya@rentman.io', reason: 'asked',
      }))

      const r = await erasureRecord(db, orgId, priya, NOON)
      if (!r) throw new Error('no record')
      expect(r.suppressionAudit.map((a) => [a.action, (a.detail as { value: string }).value])).toEqual([
        ['suppression.added', 'priya@rentman.io'],
        ['suppression.removed', 'priya@rentman.io'],
        ['suppression.added', 'priya.old@rentman.io'],
      ])
      expect(r.suppressionAudit.every((a) => a.orgId === orgId)).toBe(true)
      expect(JSON.stringify(r.suppressionAudit)).not.toContain('tom@rentman.io')

      // The file's own list of what it leaves out no longer says the audit
      // log holds no address.
      const notIncluded = r.notIncluded.join(' ')
      expect(notIncluded).not.toMatch(/never an address/)
      expect(notIncluded).toMatch(/suppression list’s own history/)
      expect(notIncluded).toMatch(/suppressionAudit/)
      expect(r.notIncluded).toEqual(ERASURE_NOT_INCLUDED)

      // And the erasure keeps those rows: the log is append-only.
      await erase()
      expect(await audit('suppression.added')).toHaveLength(3)
      expect(await audit('suppression.removed')).toHaveLength(1)
    })

    it('reads the suppression list by the addresses a message went to, not only the one on the row', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'priya.old@rentman.io', reason: 'asked', source: 'reply' })
      const r = await erasureRecord(db, orgId, priya, NOON)
      expect(r!.suppressions.map((s) => s.value)).toEqual(['priya.old@rentman.io'])
    })

    it('is null for another org, for an unknown id, and for something that is not an id', async () => {
      expect(await erasureRecord(db, otherOrgId, priya)).toBeNull()
      expect(await erasureRecord(db, orgId, '0b8f5a8e-2f1c-4b7e-9a4b-3c2d1e0f9a8b')).toBeNull()
      expect(await erasureRecord(db, orgId, "'; drop table contacts; --")).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // The erasure
  // -------------------------------------------------------------------------

  describe('erasure', () => {
    it('keeps the suppression: address, number and profile — and the address a message actually went to', async () => {
      const r = await erase()
      expect(r).toMatchObject({ ok: true, suppressionsAdded: 5, suppressionsNew: 5 })

      const rows = await suppressions()
      expect(rows.map((s) => `${s.kind}:${s.value}`).sort()).toEqual([
        'email:priya.old@rentman.io', // the recipient of the message that went out
        'email:priya@rentman.io', // the row, folded
        'linkedin:in/priya-sharma',
        'phone:+442079460000',
        'phone:+447946000099', // the number on the call linked to her
      ])
      expect(rows.every((s) => s.source === 'erasure')).toBe(true)
      expect(rows.every((s) => s.reason === 'erasure request, 2026-09-15')).toBe(true)
      // NOT the domain: that would silence every person at the company.
      expect(rows.some((s) => s.kind === 'domain')).toBe(false)
    })

    it('scrubs exactly the person’s messages: their words go, the agency’s stay, no address remains', async () => {
      const r = await erase()
      expect(r).toMatchObject({ ok: true, touchesScrubbed: 3 })

      const inbound = await touch(priyaIn)
      expect(inbound).toMatchObject({
        contactId: null, subject: ERASURE_PLACEHOLDER, body: ERASURE_PLACEHOLDER, recipient: ERASURE_PLACEHOLDER,
        // The history stays: which message it answered, what kind of reply.
        inReplyTo: priyaOut, replyKind: 'interested', companyId,
      })
      const out = await touch(priyaOut)
      expect(out).toMatchObject({
        contactId: null, recipient: null, status: 'sent',
        subject: 'A gap on your security page', body: 'Hello — we noticed your security page is missing.',
      })

      // Tom's messages did not move.
      for (const id of ids.tom.touches) {
        const t = await touch(id)
        expect(t.contactId).toBe(tom)
        expect(t.body).not.toBe(ERASURE_PLACEHOLDER)
      }
      expect((await touch(ids.tom.touches[0]!)).recipient).toBe('tom@rentman.io')
    })

    it('refuses what was still waiting to go to them, rather than leaving it for the worker', async () => {
      const r = await erase()
      expect(r).toMatchObject({ ok: true, cancelled: 1 })
      expect(await touch(priyaQueued)).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked', contactId: null })
      expect((await touch(ids.tom.touches[2]!)).status).toBe('awaiting_approval')
    })

    it('scrubs their calls, and names the carrier recordings a person must delete there', async () => {
      const r = await erase()
      expect(r).toMatchObject({ ok: true, callsScrubbed: 1, recordingsAtCarrier: ['CA-priya'] })
      const [call] = await db.select().from(schema.calls).where(eq(schema.calls.id, ids.priya.calls[0]!))
      expect(call).toMatchObject({
        contactId: null, fromNumber: null, toNumber: null, transcript: [], summary: null, recordingUrl: null,
        // Kept: the SID is how the recording is found at the carrier, and the
        // call's facts are the agency's record.
        providerCallSid: 'CA-priya', status: 'completed', companyId,
      })
      const [toms] = await db.select().from(schema.calls).where(eq(schema.calls.id, ids.tom.calls[0]!))
      expect(toms).toMatchObject({ contactId: tom, fromNumber: '+442079460001', summary: 'tom asked about pricing' })
    })

    it('keeps the meeting but not its title or notes; deletes notes and tasks about them only', async () => {
      const r = await erase()
      expect(r).toMatchObject({ ok: true, meetingsScrubbed: 1, notesDeleted: 1, tasksDeleted: 1 })

      const [m] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, ids.priya.meetings[0]!))
      expect(m).toMatchObject({ contactId: null, title: null, notes: null, companyId })
      const [tm] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, ids.tom.meetings[0]!))
      expect(tm).toMatchObject({ contactId: tom, title: 'Intro call with tom' })

      const notes = (await db.select().from(schema.notes)).map((n) => n.id).sort()
      expect(notes).toEqual([companyNote, ...ids.tom.notes].sort())
      const tasks = (await db.select().from(schema.tasks)).map((t) => t.id)
      expect(tasks).toEqual(ids.tom.tasks)
    })

    it('deletes the contact and their consents, and leaves the suppression rows behind', async () => {
      await erase()
      expect(await contactExists(priya)).toBe(false)
      expect(await contactExists(tom)).toBe(true)
      const consents = await db.select().from(schema.consents)
      expect(consents.every((c) => c.contactId === tom)).toBe(true)
      expect(consents).toHaveLength(2)
      expect(await suppressions()).toHaveLength(5)
    })

    it('audits three counts and ids only, and keeps the history before it', async () => {
      await erase()
      const [row] = await audit('contact.erased')
      expect(row).toMatchObject({ actor: userId, subjectType: 'contact', subjectId: priya })
      const [held] = (await suppressions()).filter((s) => s.value === 'priya.old@rentman.io')
      // The message that went out → the suppression row now holding its
      // recipient. The queued draft had no recipient, so it names nothing.
      expect(row!.detail).toEqual({
        touchesScrubbed: 3, callsScrubbed: 1, suppressionsAdded: 5, suppressedRecipients: { [priyaOut]: held!.id },
      })
      expect(JSON.stringify(row!.detail)).not.toContain('@')
      expect(await audit('contact.created')).toHaveLength(1)
    })

    it('counts a key already on the list as kept, and leaves the path that recorded it alone', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'clicked', source: 'unsubscribe' })
      const r = await erase()
      expect(r).toMatchObject({ ok: true, suppressionsAdded: 5, suppressionsNew: 4 })
      const [row] = (await suppressions()).filter((s) => s.value === 'priya@rentman.io')
      expect(row).toMatchObject({ source: 'unsubscribe', reason: 'clicked' })
    })

    it('is not_found the second time, for another org, and for something that is not an id', async () => {
      expect(await erase()).toMatchObject({ ok: true })
      expect(await erase()).toMatchObject({ ok: false, reason: 'not_found' })

      expect(await erase({ contactId: tom, orgId: otherOrgId })).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await contactExists(tom)).toBe(true)
      expect(await suppressions(otherOrgId)).toEqual([])

      expect(await erase({ contactId: 'not-a-uuid' })).toMatchObject({ ok: false, reason: 'not_found' })
    })

    /**
     * The compliance page checks every recorded opt-out against the list with
     * its own key. Erasing that key would leave a row reading "unreadable —
     * nobody can tell whether it was honoured" forever.
     */
    it('keeps the key an opt-out was recorded against, so the compliance page stays at zero', async () => {
      const [stop] = await db
        .insert(schema.touches)
        .values({
          orgId, contactId: priya, companyId, channel: 'email', direction: 'in', status: 'replied', sentAt: NOON,
          recipient: 'priya.home@example.com', subject: 'stop', body: 'Please stop emailing me.', replyKind: 'opted_out',
        })
        .returning()
      const [optedOutCall] = await db
        .insert(schema.calls)
        .values({
          orgId, contactId: priya, companyId, direction: 'in', status: 'completed', fromNumber: '+447700900123',
          toNumber: '+442000000000', optedOutAt: NOON, transcript: [{ role: 'caller', text: 'stop calling me' }],
        })
        .returning()

      const r = await erase()
      expect(r.ok).toBe(true)
      expect(await touch(stop!.id)).toMatchObject({
        recipient: 'priya.home@example.com', body: ERASURE_PLACEHOLDER, subject: ERASURE_PLACEHOLDER,
      })
      const [call] = await db.select().from(schema.calls).where(eq(schema.calls.id, optedOutCall!.id))
      expect(call).toMatchObject({ fromNumber: '+447700900123', transcript: [] })

      const values = (await suppressions()).map((s) => s.value)
      expect(values).toContain('priya.home@example.com')
      expect(values).toContain('+447700900123')
      expect((await complianceOptOutsWithoutSuppression(db, orgId)).count).toBe(0)
    })

    it('does not suppress a company page, and says so', async () => {
      await db.update(schema.contacts).set({ linkedinUrl: 'linkedin.com/company/rentman' }).where(eq(schema.contacts.id, priya))
      const r = await erase()
      expect(r).toMatchObject({ ok: true, skipped: [{ from: 'contact', why: 'company_page' }] })
      expect((await suppressions()).some((s) => s.kind === 'linkedin')).toBe(false)
    })

    it('skips and reports a historical recipient that could never be sent to, rather than being unerasable', async () => {
      await db.insert(schema.touches).values({
        orgId, campaignId, contactId: priya, companyId, channel: 'email', direction: 'out', status: 'sent', sentAt: NOON,
        recipient: 'Priya <not an address>', subject: 's', body: 'b',
      })
      const r = await erase()
      expect(r).toMatchObject({ ok: true, skipped: [{ from: 'message', why: 'unreadable' }] })
    })

    it('is not blocked by a message that named only them', async () => {
      // 0008's touches_names_a_subject: SET NULL would leave this row naming nothing.
      const [bare] = await db
        .insert(schema.touches)
        .values({ orgId, contactId: priya, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'no_consent' })
        .returning()
      expect(await erase()).toMatchObject({ ok: true })
      expect(await touch(bare!.id)).toMatchObject({ contactId: null, companyId })
    })

    it('renames the company the booking page made from a free-mail address', async () => {
      const booked = await bookInbound(db, {
        slug: 'northwind', name: 'Ana Lopez', email: 'Ana.Lopez@gmail.com', startsAt: new Date('2026-09-18T14:00:00Z'),
        timeZone: 'Europe/Madrid', consent: { sms: false, voice: false, whatsapp: false }, consentWording: 'ok', now: NOON,
      })
      expect(booked).toMatchObject({ ok: true, companyDomain: erasureInboundDomainFor('ana.lopez@gmail.com') })
      const [ana] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'ana.lopez@gmail.com'))

      const r = await erase({ contactId: ana!.id })
      expect(r).toMatchObject({ ok: true, companyRenamed: true, meetingsScrubbed: 1 })
      const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, ana!.companyId))
      expect(company!.domain).toBe(`erased-${ana!.companyId.slice(0, 8)}.inbound`)
      expect(company!.name).toBeNull()
      expect(company!.domain).not.toContain('ana')

      // A real company is never renamed.
      expect(await erase()).toMatchObject({ ok: true, companyRenamed: false })
      const [rentman] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId))
      expect(rentman!.domain).toBe('rentman.io')
    })

    it('agrees with booking.ts on the name of a free-mail booker’s company', () => {
      const src = readFileSync(new URL('../src/booking.ts', import.meta.url), 'utf8')
      expect(src).toContain("`${email.replace(/[^a-z0-9]+/g, '-')}.inbound`")
      expect(erasureInboundDomainFor('ana.lopez@gmail.com')).toBe('ana-lopez-gmail-com.inbound')
    })
  })

  // -------------------------------------------------------------------------
  // Failing loudly
  // -------------------------------------------------------------------------

  describe('an erasure that cannot keep its suppression', () => {
    const untouched = async () => {
      expect(await contactExists(priya)).toBe(true)
      for (const id of ids.priya.touches) {
        const t = await touch(id)
        expect(t.contactId).toBe(priya)
        expect(t.body).not.toBe(ERASURE_PLACEHOLDER)
      }
      expect((await touch(priyaOut)).recipient).toBe('priya.old@rentman.io')
      const [call] = await db.select().from(schema.calls).where(eq(schema.calls.id, ids.priya.calls[0]!))
      expect(call!.summary).toBe('priya asked about pricing')
      expect(await db.select().from(schema.consents).where(eq(schema.consents.contactId, priya))).toHaveLength(2)
      expect(await audit('contact.erased')).toEqual([])
    }

    it('aborts everything over a stored phone that cannot be read — the address is not written either', async () => {
      await db.update(schema.contacts).set({ phone: '020 7946 0000' }).where(eq(schema.contacts.id, priya))
      const log = capturingLog()
      const r = await erase({ log })

      expect(r).toMatchObject({ ok: false, reason: 'suppression_failed', why: 'unreadable_phone', paused: true })
      if (r.ok || r.reason !== 'suppression_failed') return
      expect(r.message).toMatch(/Nothing was erased/)
      expect(r.message).toMatch(/international form/)
      expect(r.message).not.toContain('020')
      expect(r.latestTouchId).not.toBeNull()

      await untouched()
      expect(await suppressions()).toEqual([])

      // Loud: the audit row, the log line, and the safe-direction pause.
      const [row] = await audit('contact.erasure_failed')
      expect(row).toMatchObject({ actor: userId, subjectType: 'contact', subjectId: priya })
      expect(row!.detail).toEqual({ why: 'unreadable_phone', paused: true })
      expect(JSON.stringify(row!.detail)).not.toContain('@')
      expect(log.lines).toHaveLength(1)
      expect(log.lines[0]!.message).toMatch(/^OPT-OUT NOT RECORDED/)
      expect(log.lines[0]!.fields).toMatchObject({ path: 'erasure', contactId: priya, why: 'unreadable_phone' })
      expect(JSON.stringify(log.lines)).not.toContain('@')
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, priya))
      expect(c!.pausedAt).not.toBeNull()
      expect(c!.pausedReason).toMatch(/^erasure requested 2026-09-15; not completed/)
    })

    /**
     * The pause OVERWRITES an earlier one. Before, a person already paused by
     * a reply kept "replied …" as their reason, and answering that reply in
     * /inbox resumed somebody who had asked to be erased.
     */
    it('pauses them with the failure as the reason, over a reply’s earlier pause — and the inbox will not answer them', async () => {
      const replied = new Date('2026-09-14T09:00:00.000Z')
      await db
        .update(schema.contacts)
        .set({ pausedAt: replied, pausedReason: `replied ${replied.toISOString()}`, phone: '020 7946 0000' })
        .where(eq(schema.contacts.id, priya))
      const r = await erase()
      expect(r).toMatchObject({ ok: false, reason: 'suppression_failed', paused: true })

      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, priya))
      expect(c!.pausedAt).toEqual(NOON)
      expect(c!.pausedReason).toBe('erasure requested 2026-09-15; not completed (unreadable_phone)')
      expect(pauseReasonClass(c!.pausedReason)).toBe('erasure')

      const answer = await replyQueueDraft(db, {
        orgId, inboundTouchId: priyaIn, subject: 'Re: A gap', body: 'Thanks!', campaignId, actor: userId, now: NOON,
      })
      expect(answer).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
      const [still] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, priya))
      expect(still!.pausedAt).toEqual(NOON)
    })

    it('rolls back the suppressions already written when a later one throws', async () => {
      // A suppression insert that THROWS, which is what a database fault does
      // (`recordOptOut` learned to catch the throw as well as `ok: false`).
      await test.pg.exec(`
        CREATE FUNCTION refuse_phone() RETURNS trigger AS $$
        BEGIN
          IF NEW.kind = 'phone' THEN RAISE EXCEPTION 'disk full'; END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_phone BEFORE INSERT ON suppressions FOR EACH ROW EXECUTE FUNCTION refuse_phone();
      `)
      const log = capturingLog()
      const r = await erase({ log })
      expect(r).toMatchObject({ ok: false, reason: 'suppression_failed', paused: true })
      if (r.ok || r.reason !== 'suppression_failed') return
      expect(r.why).not.toMatch(/unreadable/)
      expect(r.message).not.toContain('disk full')

      await untouched()
      // The email rows went in before the phone threw, and are gone with it.
      expect(await suppressions()).toEqual([])
      expect(await audit('contact.erasure_failed')).toHaveLength(1)
      expect(log.lines[0]!.message).toMatch(/^OPT-OUT NOT RECORDED/)
    })

    it('rolls back the suppressions when the scrub after them fails — one transaction', async () => {
      await test.pg.exec(`
        CREATE FUNCTION refuse_call_update() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'calls are read-only today'; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_call_update BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION refuse_call_update();
      `)
      const r = await erase()
      expect(r).toMatchObject({ ok: false, reason: 'suppression_failed' })
      await untouched()
      expect(await suppressions()).toEqual([])
      expect((await touch(priyaQueued)).status).toBe('awaiting_approval')
    })
  })
})
