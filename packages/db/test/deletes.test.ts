/**
 * Delete, and what it will not delete (2026-10-15), against a real engine.
 *
 * Every writer is driven through each refusal — the record it keeps, with
 * nothing written — and its happy path, with what CASCADE and SET NULL took
 * counted and checked row by row, and the audit row it leaves. The traps
 * the FK probe found (`del-fk.md`) are here by name: a company with an
 * agent's company-only draft (S3), a company with an inbound reply (S4), a
 * contact whose row is the only subject of a message (S5b), a campaign
 * that is the only subject of one (S6b), and a company with an SMS draft
 * and no campaign (S16) — each either deletes cleanly or is refused with a
 * sentence, never a CHECK violation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, getTableName } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { noSiteDomain } from '@agency/core'
import * as schema from '../src/schema.js'
import type { AgencyDb } from '../src/repository.js'
import {
  addSuppression, appendAudit, campaignDelete, companyDelete, contactDelete, createMeeting, dealDelete, deletedCompanyAt,
  deletedCompanyKeys, deletedCompanyWords, icpProfileDelete, meetingDelete, meetingRescheduleLinks,
  meetingsThatReplacedOne, proposalDelete, quoteCreate, quoteDelete, quoteSend, quotesEverSent, quoteUpdate,
  rescheduleMeeting, taskDelete, templateDelete, cancelMeeting, contactResumeByHand, sharedNumberOptOutReason,
} from '../src/queries.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOON = new Date('2026-09-15T12:00:00.000Z')
const NOWHERE = '00000000-0000-4000-8000-000000000000'

describe('delete, and what it will not delete', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let ownerId: string
  let icpId: string
  let companyId: string
  let campaignId: string
  let tokens = 0
  const tokenHash = () => (++tokens).toString(16).padStart(64, '0')

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning())[0]!.id
    otherOrgId = (await db.insert(schema.orgs).values({ name: 'Somebody Else' }).returning())[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'owner@accemy.test', role: 'owner' }).returning())[0]!.id
    icpId = (await db.insert(schema.icpProfiles).values({ orgId, name: 'Default', definition: {}, active: true }).returning())[0]!.id
    companyId = (
      await db
        .insert(schema.companies)
        .values({ orgId, domain: 'rentman.io', name: 'Rentman', googlePlaceId: 'ChIJrentman', listingCheckedAt: NOON })
        .returning()
    )[0]!.id
    campaignId = (
      await db.insert(schema.campaigns).values({ orgId, name: 'Q4', channel: 'email', status: 'active' }).returning()
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const contact = async (values: Partial<typeof schema.contacts.$inferInsert> = {}, company = companyId) =>
    (await db.insert(schema.contacts).values({ orgId, companyId: company, firstName: 'Alex', email: 'alex@rentman.io', ...values }).returning())[0]!.id
  const touch = async (values: Partial<typeof schema.touches.$inferInsert>) =>
    (await db.insert(schema.touches).values({ orgId, channel: 'email', direction: 'out', status: 'awaiting_approval', ...values }).returning())[0]!.id
  const audit = (action: string, org = orgId) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, org), eq(schema.auditLog.action, action)))
  /** A row by id, from a table that has one — or undefined. */
  const rowOf = async (table: typeof schema.touches, id: string) =>
    (await db.select().from(table).where(eq(table.id, id)))[0]
  const has = async (table: PgTable & { id: PgColumn }, id: string) =>
    (await db.select({ id: table.id }).from(table as typeof schema.touches).where(eq(table.id, id))).length === 1
  const countIn = async (table: PgTable & { orgId: PgColumn }, org = orgId) =>
    (await db.select({ orgId: table.orgId }).from(table as typeof schema.touches).where(eq(table.orgId, org))).length

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  describe('contactDelete', () => {
    it('removes a person nothing went to, their drafts, consents, notes and runs — and keeps what it must', async () => {
      const alex = await contact()
      const other = await contact({ firstName: 'Sam', email: 'sam@rentman.io' })
      await db.insert(schema.consents).values({ orgId, contactId: alex, channel: 'email', granted: true, source: 'form' })
      await db.insert(schema.notes).values([
        { orgId, companyId, contactId: alex, authorUserId: ownerId, body: 'Alex prefers mornings' },
        { orgId, companyId, contactId: null, authorUserId: ownerId, body: 'The company uses Cloudflare.' },
      ])
      const draft = await touch({ campaignId, contactId: alex, companyId, subject: 'Hello', body: 'An opener.' })
      const linkedin = await touch({
        campaignId, contactId: alex, companyId, channel: 'linkedin', status: 'approved', approvedBy: ownerId, approvedAt: NOON,
      })
      const step = (await db.insert(schema.tasks).values({ orgId, companyId, touchId: linkedin, kind: 'linkedin_send', title: 'Send it' }).returning())[0]!.id
      // S5b, as a kept row: a refused message that named only Alex. SET NULL
      // on the contact would leave it naming nothing; it is given the company.
      const refusedAlone = await touch({ contactId: alex, status: 'refused', refusalCode: 'needs_approval' })
      const othersDraft = await touch({ campaignId, contactId: other, companyId })
      const meeting = (await db.insert(schema.meetings).values({ orgId, companyId, contactId: alex, startsAt: NOON, timeZone: 'UTC' }).returning())[0]!.id
      const quote = (await db.insert(schema.quotes).values({ orgId, companyId, contactId: alex, number: 'Q-2026-0001', title: 'Website', validUntil: '2026-10-30' }).returning())[0]!.id
      await db.insert(schema.sequenceRuns).values({ orgId, campaignId, contactId: alex, startedAt: NOON, anchorAt: NOON })

      const r = await contactDelete(db, { orgId, contactId: alex, actor: ownerId })
      expect(r).toEqual({ ok: true, companyId, draftsRemoved: 2, consentsRemoved: 1, notesRemoved: 1 })

      expect(await has(schema.contacts, alex)).toBe(false)
      expect(await has(schema.touches, draft)).toBe(false)
      expect(await has(schema.touches, linkedin)).toBe(false)
      expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, step))).length).toBe(0)
      expect(await rowOf(schema.touches, refusedAlone)).toMatchObject({ contactId: null, companyId, status: 'refused' })
      expect(await has(schema.touches, othersDraft)).toBe(true)
      expect(await has(schema.contacts, other)).toBe(true)
      expect((await db.select().from(schema.meetings).where(eq(schema.meetings.id, meeting)))[0]!.contactId).toBeNull()
      expect((await db.select().from(schema.quotes).where(eq(schema.quotes.id, quote)))[0]!.contactId).toBeNull()
      expect(await countIn(schema.consents)).toBe(0)
      expect(await countIn(schema.sequenceRuns)).toBe(0)
      const notes = await db.select().from(schema.notes).where(eq(schema.notes.orgId, orgId))
      expect(notes.map((n) => n.body)).toEqual(['The company uses Cloudflare.'])

      const [row] = await audit('contact.deleted')
      expect(row).toMatchObject({ actor: ownerId, subjectType: 'contact', subjectId: alex })
      expect(row!.detail).toEqual({ companyId, draftsRemoved: 2, consentsRemoved: 1, notesRemoved: 1 })
      expect(JSON.stringify(row)).not.toContain('rentman.io')
    })

    it('records the agent as the one who deleted, for a card a person approved', async () => {
      const alex = await contact()
      expect(await contactDelete(db, { orgId, contactId: alex, actor: 'agent' })).toMatchObject({ ok: true })
      expect((await audit('contact.deleted'))[0]!.actor).toBe('agent')
    })

    /** Each refusal keeps the person and everything of theirs, and writes no audit row. */
    const refusals: Array<[string, 'in_flight' | 'must_erase' | 'shared_number', (alex: string) => Promise<unknown>]> = [
      ['a message being sent right now', 'in_flight', (alex) => touch({ campaignId, contactId: alex, companyId, status: 'sending' })],
      ['a sent message', 'must_erase', (alex) => touch({ campaignId, contactId: alex, companyId, status: 'sent', sentAt: NOON })],
      ['a failed message, which may have gone', 'must_erase', (alex) => touch({ campaignId, contactId: alex, companyId, status: 'failed' })],
      // S5b: an inbound reply naming only the contact is refused with a sentence, not a CHECK violation.
      ['an inbound reply naming only them', 'must_erase', (alex) => touch({ contactId: alex, direction: 'in', status: 'replied', body: 'Hi' })],
      ['a call', 'must_erase', (alex) => db.insert(schema.calls).values({ orgId, contactId: alex, direction: 'in' })],
      [
        'a recorded refusal, which a delete would lift with no record',
        'must_erase',
        (alex) => db.insert(schema.consents).values({ orgId, contactId: alex, channel: 'email', granted: false, source: 'said no on a call' }),
      ],
      [
        'an opt-out not recorded, by subject',
        'must_erase',
        (alex) => appendAudit(db, { orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: alex, detail: {} }),
      ],
      [
        'an unsubscribe not recorded, by detail.contactId',
        'must_erase',
        (alex) => appendAudit(db, { orgId, actor: 'system', action: 'unsubscribe.not_recorded', subjectType: 'touch', subjectId: NOWHERE, detail: { contactId: alex } }),
      ],
      [
        'an erasure that failed',
        'must_erase',
        (alex) => appendAudit(db, { orgId, actor: ownerId, action: 'contact.erasure_failed', subjectType: 'contact', subjectId: alex, detail: { why: 'x' } }),
      ],
      [
        'a pause for an opt-out nobody could record',
        'must_erase',
        (alex) => db.update(schema.contacts).set({ pausedAt: NOON, pausedReason: 'opt-out not recorded: reply 2026-09-15T12:00:00.000Z (x)' }).where(eq(schema.contacts.id, alex)),
      ],
      [
        'a pause for an erasure that did not finish',
        'must_erase',
        (alex) => db.update(schema.contacts).set({ pausedAt: NOON, pausedReason: 'erasure requested 2026-09-15; not completed (x)' }).where(eq(schema.contacts.id, alex)),
      ],
      // Not their own opt-out: they may not have sent it (review, 2026-10-15).
      [
        'a shared number’s STOP that could not be recorded',
        'shared_number',
        (alex) =>
          appendAudit(db, {
            orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'touch', subjectId: null,
            detail: { channel: 'sms', why: 'suppression_failed', sharedNumber: true, contacts: 1, paused: 1, holders: [alex] },
          }),
      ],
    ]
    /**
     * Each refusal twice: by the id as the database prints it, and in
     * CAPITALS, as `DELETE /api/contacts/[id]` accepts one (review,
     * 2026-10-15). Postgres matched the row whatever its case, while the keep
     * reasons were looked up by the typed spelling, so in capitals a refusal,
     * a call and an unrecorded opt-out were each deleted.
     */
    for (const [what, code, arrange] of refusals) {
      for (const spelt of ['as stored', 'in capitals'] as const) {
        it(`refuses ${what} (${code}), writing nothing — its id ${spelt}`, async () => {
          const alex = await contact({ phone: '+919876543210' })
          const draft = await touch({ campaignId, contactId: alex, companyId })
          await arrange(alex)
          const consentsBefore = await countIn(schema.consents)
          const r = await contactDelete(db, { orgId, contactId: spelt === 'in capitals' ? alex.toUpperCase() : alex, actor: ownerId })
          expect(r).toMatchObject({ ok: false, code })
          if (r.ok) return
          expect(r.message).not.toMatch(/@|\+91|9876/)
          expect(r.message).toMatch(
            code === 'in_flight' ? /being sent right now/ : code === 'shared_number' ? /Record the number on \/suppressions/ : /erase them on \/contacts/,
          )
          expect(await has(schema.contacts, alex)).toBe(true)
          expect(await has(schema.touches, draft)).toBe(true)
          expect(await countIn(schema.consents)).toBe(consentsBefore)
          expect(await audit('contact.deleted')).toHaveLength(0)
        })
      }
    }

    it('deletes by an id in capitals, as the database prints it in the audit row', async () => {
      const alex = await contact()
      expect(await contactDelete(db, { orgId, contactId: alex.toUpperCase(), actor: ownerId })).toMatchObject({ ok: true })
      expect(await has(schema.contacts, alex)).toBe(false)
      expect((await audit('contact.deleted'))[0]!.subjectId).toBe(alex)
    })

    /**
     * Recording the opt-out on /suppressions never lets the delete through —
     * the audit row is permanent, and Resume never lifts the pause — so the
     * refusal names the two acts apart (review, 2026-10-15). It said "Record
     * it on /suppressions, or an owner can erase them", and came back word
     * for word once the person had.
     */
    it('says an unrecorded opt-out is recorded so nothing reaches them, and erased to remove them', async () => {
      const alex = await contact({ pausedAt: NOON, pausedReason: 'opt-out not recorded: reply 2026-09-15T12:00:00.000Z (suppression_failed)' })
      await appendAudit(db, { orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: alex, detail: { channel: 'email', why: 'suppression_failed' } })
      const words =
        'An opt-out or an erasure of this contact’s could not be recorded, and their record is what holds them until it ' +
        'is. Record it on /suppressions so nothing reaches them; to remove the person, an owner can erase them on ' +
        '/contacts, which keeps their addresses on the suppression list.'
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toEqual({ ok: false, code: 'must_erase', message: words })
      // Recorded, as the sentence says to: still held, and the sentence promises nothing else.
      expect(await addSuppression(db, { orgId, kind: 'email', value: 'alex@rentman.io', reason: 'recorded by hand', source: 'manual' })).toMatchObject({ ok: true })
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toEqual({ ok: false, code: 'must_erase', message: words })
      expect(words).not.toMatch(/Record it on \/suppressions, or/)
    })

    /**
     * A shared number's holder is not the one who asked (review, 2026-10-15):
     * the hold was read as their own unrecorded opt-out, whose words said the
     * opt-out was theirs and to erase them — an erasure that puts their email
     * on the suppression list for good, for somebody who may have sent
     * nothing. Recording the NUMBER, then Resume for the hard hold, is the
     * way out, and the delete then goes through.
     */
    const PHONE = '+919876543210'
    const holdersRow = (holders: string[]) =>
      appendAudit(db, {
        orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'touch', subjectId: null,
        detail: { channel: 'sms', why: 'suppression_failed', sharedNumber: true, contacts: holders.length, paused: holders.length, holders },
      })
    const HOLDER_WORDS =
      'A text from a number this contact shares asked to stop, and it could not be recorded — they may not have sent ' +
      'it. Record the number on /suppressions; if that text paused them, Resume them on /contacts too; then they can ' +
      'be deleted.'

    it('words a holder held hard as one who may not have asked, and lets them go once the number is recorded and they are resumed', async () => {
      const reason = sharedNumberOptOutReason(NOON, 'suppression_failed')
      const alex = await contact({ phone: PHONE, pausedAt: NOON, pausedReason: reason })
      await holdersRow([alex])
      const words = { ok: false, code: 'shared_number', message: HOLDER_WORDS }
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toEqual(words)
      expect(HOLDER_WORDS).not.toMatch(/erase|of this contact’s|\+91|9876/)
      // Recorded: the hold stands until Resume lifts it, and the words still say how.
      expect(await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'recorded by hand', source: 'manual' })).toMatchObject({ ok: true })
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toEqual(words)
      expect(await contactResumeByHand(db, { orgId, contact: { id: alex }, expectedReason: reason, actor: ownerId })).toMatchObject({ ok: true })
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toMatchObject({ ok: true })
      // Nothing of theirs but the number went on the list — never their email.
      const listed = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
      expect(listed.map((r) => [r.kind, r.value])).toEqual([['phone', PHONE]])
    })

    it('lets a holder whose own pause stood go once the number is recorded, with no Resume', async () => {
      const alex = await contact({ phone: PHONE, pausedAt: NOON, pausedReason: 'held by hand (by owner@accemy.test)' })
      await holdersRow([alex])
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toEqual({ ok: false, code: 'shared_number', message: HOLDER_WORDS })
      await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'recorded by hand', source: 'manual' })
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toMatchObject({ ok: true })
    })

    it('keeps their own unrecorded opt-out as theirs, ahead of a shared number’s hold', async () => {
      const alex = await contact({ phone: PHONE })
      await holdersRow([alex])
      await appendAudit(db, { orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: alex, detail: { channel: 'email', why: 'suppression_failed' } })
      const r = await contactDelete(db, { orgId, contactId: alex, actor: ownerId })
      expect(r).toMatchObject({ ok: false, code: 'must_erase' })
      if (!r.ok) expect(r.message).toContain('Record it on /suppressions so nothing reaches them')
    })

    it('words a company held by a holder the same way, and deletes it once the number is recorded', async () => {
      const reason = sharedNumberOptOutReason(NOON, 'suppression_failed')
      const alex = await contact({ phone: PHONE, pausedAt: NOON, pausedReason: reason })
      await holdersRow([alex])
      expect(await companyDelete(db, { orgId, companyId, actor: ownerId })).toEqual({
        ok: false,
        code: 'shared_number',
        message:
          'A person at rentman.io shares a number a text asked to stop from, and it could not be recorded — they may ' +
          'not have sent it. Record the number on /suppressions; if that text paused them, Resume them on /contacts ' +
          'too; then the company can be deleted.',
      })
      await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'recorded by hand', source: 'manual' })
      expect(await contactResumeByHand(db, { orgId, contact: { id: alex }, expectedReason: reason, actor: ownerId })).toMatchObject({ ok: true })
      expect(await companyDelete(db, { orgId, companyId, actor: ownerId })).toMatchObject({ ok: true })
    })

    it('does not refuse a shared number’s STOP once the number is on the suppression list', async () => {
      const alex = await contact({ phone: '+919876543210' })
      await appendAudit(db, {
        orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'touch', subjectId: null,
        detail: { channel: 'sms', why: 'suppression_failed', sharedNumber: true, contacts: 1, paused: 1, holders: [alex] },
      })
      await db.insert(schema.suppressions).values({ orgId, kind: 'phone', value: '+919876543210', reason: 'STOP', source: 'manual' })
      expect(await contactDelete(db, { orgId, contactId: alex, actor: ownerId })).toMatchObject({ ok: true })
      // The suppression is keyed by value and outlives the person.
      expect(await countIn(schema.suppressions)).toBe(1)
    })

    it('answers not_found for another org’s contact, a made-up id and a malformed one', async () => {
      const theirCompany = (await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.test' }).returning())[0]!.id
      const theirs = (await db.insert(schema.contacts).values({ orgId: otherOrgId, companyId: theirCompany, email: 'x@theirs.test' }).returning())[0]!.id
      for (const id of [theirs, NOWHERE, 'not-a-uuid']) {
        expect(await contactDelete(db, { orgId, contactId: id, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      }
      expect(await has(schema.contacts, theirs)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Companies
  // -------------------------------------------------------------------------

  describe('companyDelete', () => {
    it('removes a company and everything that hangs off it, with the S3 and S16 drafts that would trip the subject CHECK', async () => {
      const scanId = (await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning())[0]!.id
      await db.insert(schema.findings).values({ orgId, scanId, companyId, signalKey: 'csp', observed: true, gap: false })
      await db.insert(schema.scores).values({ orgId, companyId, icpProfileId: icpId, score: 50, scanId })
      const dealId = (await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted' }).returning())[0]!.id
      await db.insert(schema.meetings).values({ orgId, companyId, dealId, startsAt: NOON, timeZone: 'UTC' })
      // A draft quote that never went out: a link is made only for a sent
      // one, so a quote with a link went out, and keeps its company (below).
      await db.insert(schema.quotes).values({ orgId, companyId, number: 'Q-2026-0001', title: 'Website', validUntil: '2026-10-30' })
      await db.insert(schema.shareLinks).values([
        { orgId, kind: 'report', companyId, tokenHash: tokenHash(), expiresAt: new Date(Date.now() + 86_400_000) },
        { orgId, kind: 'preview', companyId, tokenHash: tokenHash(), expiresAt: new Date(Date.now() + 86_400_000) },
      ])
      await db.insert(schema.proposals).values({ orgId, companyId, dealId, scanId, title: 'Proposal', document: {} })
      await db.insert(schema.notes).values({ orgId, companyId, authorUserId: ownerId, body: 'A note.' })
      await db.insert(schema.tasks).values({ orgId, companyId, dealId, kind: 'todo', title: 'Call them' })
      await db.insert(schema.companyResearch).values({ orgId, companyId, claim: 'Has three offices', sourceUrl: 'https://inc42.com/rentman' })
      await db.insert(schema.siteAudits).values({ orgId, companyId, strategy: 'mobile', url: 'https://rentman.io/', ok: true })

      const alex = await contact()
      const sam = await contact({ firstName: 'Sam', email: 'sam@rentman.io', phone: '+919876543210' })
      await db.insert(schema.consents).values({ orgId, contactId: alex, channel: 'email', granted: true, source: 'form' })
      await touch({ campaignId, contactId: alex, companyId })
      // S3: the agent's company-only draft — no contact, no campaign.
      await touch({ companyId, subject: 'Hello', body: 'From queue_touch.' })
      // S16: an SMS draft with its template and no campaign.
      const template = (await db.insert(schema.messageTemplates).values({ orgId, channel: 'sms', externalId: '1107', senderId: 'ACMEIN', category: 'transactional', body: 'Hi {#var#}' }).returning())[0]!.id
      await touch({ contactId: sam, companyId, channel: 'sms', templateId: template, body: 'Hi Sam' })
      // A refused, never-sent enrolment row: it has a campaign, so it is kept, naming the campaign alone.
      const enrolRefused = await touch({ campaignId, contactId: alex, companyId, status: 'refused', refusalCode: 'needs_approval' })
      // A refused company-only draft: with no campaign it would name nothing, so it goes.
      const deniedAlone = await touch({ companyId, status: 'refused', refusalCode: 'needs_approval' })

      const r = await companyDelete(db, { orgId, companyId, actor: ownerId })
      expect(r).toEqual({ ok: true, contacts: 2, drafts: 4, deals: 1, meetings: 1, quotes: 1, proposals: 1, scans: 1 })

      expect(await has(schema.companies, companyId)).toBe(false)
      for (const table of [
        schema.contacts, schema.consents, schema.scans, schema.findings, schema.scores, schema.deals, schema.meetings,
        schema.quotes, schema.shareLinks, schema.proposals, schema.notes, schema.tasks, schema.companyResearch, schema.siteAudits,
      ]) {
        expect(await countIn(table), getTableName(table)).toBe(0)
      }
      const left = await db.select().from(schema.touches).where(eq(schema.touches.orgId, orgId))
      expect(left.map((t) => t.id)).toEqual([enrolRefused])
      expect(left[0]).toMatchObject({ campaignId, contactId: null, companyId: null, status: 'refused' })
      expect(await has(schema.touches, deniedAlone)).toBe(false)
      // The registration a message was checked against is the template's own record, untouched.
      expect((await db.select().from(schema.messageTemplates).where(eq(schema.messageTemplates.id, template))).length).toBe(1)

      const [row] = await audit('company.deleted')
      expect(row).toMatchObject({ actor: ownerId, subjectType: 'company', subjectId: companyId })
      expect(row!.detail).toEqual({
        domain: 'rentman.io', name: 'Rentman', placeId: 'ChIJrentman',
        contacts: 2, drafts: 4, deals: 1, meetings: 1, quotes: 1, proposals: 1, scans: 1,
      })
      expect(JSON.stringify(row)).not.toContain('alex@')
    })

    it('refuses an inbound reply (S4) with a sentence, not a CHECK violation', async () => {
      const alex = await contact()
      await touch({ contactId: alex, companyId, direction: 'in', status: 'replied', body: 'Interested' })
      const r = await companyDelete(db, { orgId, companyId, actor: ownerId })
      expect(r).toMatchObject({ ok: false, code: 'has_history' })
      if (!r.ok) expect(r.message).toContain('rentman.io')
      expect(await has(schema.companies, companyId)).toBe(true)
      expect(await has(schema.contacts, alex)).toBe(true)
    })

    const refusals: Array<[string, string, () => Promise<unknown>, RegExp?]> = [
      ['a message being sent', 'in_flight', () => touch({ companyId, status: 'sending' })],
      ['a sent company-only message', 'has_history', () => touch({ companyId, status: 'sent', sentAt: NOON })],
      ['a sent message to a person there', 'has_history', async () => touch({ campaignId, contactId: await contact(), status: 'sent', sentAt: NOON })],
      ['a call to the company', 'has_history', () => db.insert(schema.calls).values({ orgId, companyId, direction: 'in' })],
      ['a call from a person there', 'has_history', async () => db.insert(schema.calls).values({ orgId, contactId: await contact(), direction: 'in' })],
      [
        'a person there with a recorded refusal',
        'contact_must_be_erased',
        async () => db.insert(schema.consents).values({ orgId, contactId: await contact(), channel: 'sms', granted: false, source: 'said no' }),
        /said no/,
      ],
      [
        'a person there held for an opt-out nobody could record',
        'contact_must_be_erased',
        () => contact({ pausedAt: NOON, pausedReason: 'opt-out not recorded: reply 2026-09-15T12:00:00.000Z (x)' }),
        // Recorded so nothing reaches them; erased to remove them — never "record it, or erase them".
        /could not be recorded[\s\S]*Record it on \/suppressions so nothing reaches them; to remove the person, an owner can erase them/,
      ],
      // A person's call where they asked to stop: `taskDelete` keeps it, and
      // the cascade took it with the company (review, 2026-10-15).
      [
        'a call where they asked to stop',
        'call_record',
        () =>
          db.insert(schema.tasks).values({
            orgId, companyId, kind: 'call', title: 'Call Rentman', doneAt: NOON, doneBy: ownerId, outcome: 'asked_to_stop',
          }),
        /asked to stop[\s\S]*suppression on their number/,
      ],
      [
        'a visit where they asked to stop',
        'call_record',
        () =>
          db.insert(schema.tasks).values({
            orgId, companyId, kind: 'visit', title: 'Visit Rentman', doneAt: NOON, doneBy: ownerId, outcome: 'asked_to_stop',
          }),
      ],
      ['a won deal', 'deal_won', () => db.insert(schema.deals).values({ orgId, companyId, stage: 'won', closedAt: NOON })],
      [
        'a sent quote',
        'quote_sent',
        () =>
          db.insert(schema.quotes).values({
            orgId, companyId, number: 'Q-2026-0007', title: 'Website', validUntil: '2026-10-30', status: 'sent', sentAt: NOON,
            seller: { name: 'Accemy' }, items: [{ name: 'Website', quantity: 1, unit: 'one_off', unitPrice: 25000 }],
          }),
        /Q-2026-0007/,
      ],
      // Sent, then revised back to a draft: a buyer holds its number (review, 2026-10-15).
      [
        'a quote sent and then revised back to a draft',
        'quote_sent',
        async () => {
          const q = (await db.insert(schema.quotes).values({ orgId, companyId, number: 'Q-2026-0008', title: 'Website', validUntil: '2026-10-30' }).returning())[0]!.id
          await appendAudit(db, { orgId, actor: ownerId, action: 'quote.sent', subjectType: 'quote', subjectId: q, detail: { companyId, number: 'Q-2026-0008' } })
        },
        /Q-2026-0008\) went out before it was revised back to a draft/,
      ],
      [
        'a draft quote a link was made for, since revoked',
        'quote_sent',
        async () => {
          const q = (await db.insert(schema.quotes).values({ orgId, companyId, number: 'Q-2026-0009', title: 'Website', validUntil: '2026-10-30' }).returning())[0]!.id
          await db.insert(schema.shareLinks).values({
            orgId, kind: 'quote', companyId, quoteId: q, tokenHash: tokenHash(), expiresAt: new Date(Date.now() + 86_400_000), revokedAt: NOON,
          })
        },
        /Q-2026-0009/,
      ],
      [
        'a sent proposal',
        'proposal_sent',
        async () => {
          const scanId = (await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning())[0]!.id
          await db.insert(schema.proposals).values({ orgId, companyId, scanId, title: 'P', document: {}, status: 'sent' })
        },
      ],
      [
        'a meeting with its outcome recorded',
        'meeting_held',
        () => db.insert(schema.meetings).values({ orgId, companyId, startsAt: NOON, timeZone: 'UTC', outcome: 'held' }),
      ],
    ]
    for (const [what, code, arrange, says] of refusals) {
      for (const spelt of ['as stored', 'in capitals'] as const) {
        it(`refuses ${what} (${code}), writing nothing — its id ${spelt}`, async () => {
          const draft = await touch({ companyId })
          await arrange()
          const tasksBefore = await countIn(schema.tasks)
          const r = await companyDelete(db, { orgId, companyId: spelt === 'in capitals' ? companyId.toUpperCase() : companyId, actor: ownerId })
          expect(r).toMatchObject({ ok: false, code })
          if (!r.ok && says) expect(r.message).toMatch(says)
          if (!r.ok) expect(r.message).not.toContain('@')
          expect(await has(schema.companies, companyId)).toBe(true)
          expect(await has(schema.touches, draft)).toBe(true)
          expect(await countIn(schema.tasks)).toBe(tasksBefore)
          expect(await audit('company.deleted')).toHaveLength(0)
        })
      }
    }

    it('deletes a company with a call that reached them, or one still to make — only "asked to stop" keeps it', async () => {
      await db.insert(schema.tasks).values([
        { orgId, companyId, kind: 'call', title: 'Call', doneAt: NOON, doneBy: ownerId, outcome: 'reached' },
        { orgId, companyId, kind: 'call', title: 'Call again' },
      ])
      expect(await companyDelete(db, { orgId, companyId: companyId.toUpperCase(), actor: ownerId })).toMatchObject({ ok: true })
      expect(await countIn(schema.tasks)).toBe(0)
    })

    it('answers not_found for another org’s company', async () => {
      const theirs = (await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.test' }).returning())[0]!.id
      expect(await companyDelete(db, { orgId, companyId: theirs, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await has(schema.companies, theirs)).toBe(true)
      expect(await companyDelete(db, { orgId, companyId: 'nope', actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
    })

    it('keeps a booking page’s placeholder out of the audit row, and names it "this company"', async () => {
      const inbound = (await db.insert(schema.companies).values({ orgId, domain: 'priya-gmail-com.inbound', name: 'Priya Sharma', source: 'inbound' }).returning())[0]!.id
      await touch({ companyId: inbound, status: 'sent', sentAt: NOON })
      const refused = await companyDelete(db, { orgId, companyId: inbound, actor: ownerId })
      expect(refused).toMatchObject({ ok: false, code: 'has_history' })
      if (!refused.ok) expect(refused.message).not.toMatch(/priya|gmail/i)

      const other = (await db.insert(schema.companies).values({ orgId, domain: 'sam-gmail-com.inbound', name: 'Sam Rao', source: 'inbound' }).returning())[0]!.id
      expect(await companyDelete(db, { orgId, companyId: other, actor: ownerId })).toMatchObject({ ok: true })
      const [row] = await audit('company.deleted')
      expect(row!.detail).toMatchObject({ domain: null, name: null, placeId: null })
    })

    /**
     * A no-website business's placeholder is kept: it is built from its own
     * name and place, never a person's address, and it is the only key a
     * business add_company filed with website "none" has (review,
     * 2026-10-15: stored as null, a deleted café was filed again at once).
     */
    it('records a no-website business by its placeholder, its name and its place id', async () => {
      const domain = noSiteDomain('Yummy Bites', 'place:ChIJyummy')
      const cafe = (await db.insert(schema.companies).values({ orgId, domain, name: 'Yummy Bites', googlePlaceId: 'ChIJyummy', listingCheckedAt: NOON }).returning())[0]!.id
      expect(await companyDelete(db, { orgId, companyId: cafe, actor: 'agent' })).toMatchObject({ ok: true })
      const [row] = await audit('company.deleted')
      expect(row!.detail).toMatchObject({ domain, name: 'Yummy Bites', placeId: 'ChIJyummy' })
      expect(row!.actor).toBe('agent')
    })
  })

  describe('deletedCompanyKeys', () => {
    it('reads what this org deleted, by domain and by place, and says when', async () => {
      expect(await companyDelete(db, { orgId, companyId, actor: ownerId })).toMatchObject({ ok: true })
      const cafe = (
        await db
          .insert(schema.companies)
          .values({ orgId, domain: noSiteDomain('Yummy Bites', 'place:ChIJyummy'), name: 'Yummy Bites', googlePlaceId: 'ChIJyummy', listingCheckedAt: NOON })
          .returning()
      )[0]!.id
      expect(await companyDelete(db, { orgId, companyId: cafe, actor: ownerId })).toMatchObject({ ok: true })
      // Another org's deletion is not this org's.
      const theirs = (await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.test', googlePlaceId: 'ChIJtheirs', listingCheckedAt: NOON }).returning())[0]!.id
      expect(await companyDelete(db, { orgId: otherOrgId, companyId: theirs, actor: 'agent' })).toMatchObject({ ok: true })

      const keys = await deletedCompanyKeys(db, orgId)
      expect([...keys.domains.keys()].sort()).toEqual([noSiteDomain('Yummy Bites', 'place:ChIJyummy'), 'rentman.io'].sort())
      expect([...keys.placeIds.keys()].sort()).toEqual(['ChIJrentman', 'ChIJyummy'])
      const at = deletedCompanyAt(keys, { domain: 'RENTMAN.io' })
      expect(at).toBeInstanceOf(Date)
      expect(deletedCompanyAt(keys, { placeId: 'ChIJyummy', domain: 'a-new-name.nosite.invalid' })).toBeInstanceOf(Date)
      expect(deletedCompanyAt(keys, { domain: 'theirs.test', placeId: 'ChIJtheirs' })).toBeNull()
      expect(deletedCompanyWords('rentman.io', NOON)).toBe(
        'rentman.io was deleted by a teammate on 2026-09-15; a person can add it again on /companies.',
      )
      // A business with no website cannot be added on /companies, so its words promise nothing there.
      expect(deletedCompanyWords('Yummy Bites', NOON, true)).toBe(
        'Yummy Bites was deleted by a teammate on 2026-09-15, so it is not filed again here; a business with no website cannot be added on /companies.',
      )
    })

    it('knows a no-website business filed with no place id by its placeholder, and never keeps a booking page’s', async () => {
      // As add_company's website "none" files one: by its name, city and address.
      const placeholder = noSiteDomain('Yummy Bites', 'name:yummy bites|delhi|')
      const cafe = (await db.insert(schema.companies).values({ orgId, domain: placeholder, name: 'Yummy Bites', source: 'agent' }).returning())[0]!.id
      expect(await companyDelete(db, { orgId, companyId: cafe, actor: 'agent' })).toMatchObject({ ok: true })
      const lead = (await db.insert(schema.companies).values({ orgId, domain: 'jo-gmail-com.inbound', name: 'Jo', source: 'inbound' }).returning())[0]!.id
      expect(await companyDelete(db, { orgId, companyId: lead, actor: ownerId })).toMatchObject({ ok: true })
      const keys = await deletedCompanyKeys(db, orgId)
      expect(deletedCompanyAt(keys, { domain: placeholder })).toBeInstanceOf(Date)
      expect(deletedCompanyAt(keys, { domain: placeholder.toUpperCase() })).toBeInstanceOf(Date)
      // Another city is another placeholder, and is not known (a stated residual).
      expect(deletedCompanyAt(keys, { domain: noSiteDomain('Yummy Bites', 'name:yummy bites|new delhi|') })).toBeNull()
      expect([...keys.domains.keys()]).toEqual([placeholder])
      expect(deletedCompanyAt(keys, { domain: 'jo-gmail-com.inbound' })).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Deals, meetings, proposals, quotes, tasks
  // -------------------------------------------------------------------------

  describe('dealDelete', () => {
    it('deletes an open or lost deal, taking it off its meetings, proposals and tasks', async () => {
      const dealId = (await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' }).returning())[0]!.id
      const scanId = (await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning())[0]!.id
      const meeting = (await db.insert(schema.meetings).values({ orgId, companyId, dealId, startsAt: NOON, timeZone: 'UTC' }).returning())[0]!.id
      const proposal = (await db.insert(schema.proposals).values({ orgId, companyId, dealId, scanId, title: 'P', document: {} }).returning())[0]!.id
      const task = (await db.insert(schema.tasks).values({ orgId, companyId, dealId, title: 'T' }).returning())[0]!.id

      expect(await dealDelete(db, { orgId, dealId, actor: ownerId })).toEqual({ ok: true, companyId })
      expect((await db.select().from(schema.deals).where(eq(schema.deals.orgId, orgId))).length).toBe(0)
      expect((await db.select().from(schema.meetings).where(eq(schema.meetings.id, meeting)))[0]!.dealId).toBeNull()
      expect((await db.select().from(schema.proposals).where(eq(schema.proposals.id, proposal)))[0]!.dealId).toBeNull()
      expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, task)))[0]!.dealId).toBeNull()
      const [row] = await audit('deal.deleted')
      expect(row).toMatchObject({ actor: ownerId, subjectType: 'deal', subjectId: dealId, detail: { companyId, stage: 'meeting' } })

      const lost = (await db.insert(schema.deals).values({ orgId, companyId, stage: 'lost', lostReason: 'went quiet', closedAt: NOON }).returning())[0]!.id
      expect(await dealDelete(db, { orgId, dealId: lost, actor: ownerId })).toMatchObject({ ok: true })
    })

    it('refuses a won deal, and another org’s', async () => {
      const won = (await db.insert(schema.deals).values({ orgId, companyId, stage: 'won', closedAt: NOON }).returning())[0]!.id
      expect(await dealDelete(db, { orgId, dealId: won, actor: ownerId })).toMatchObject({ ok: false, code: 'deal_won' })
      expect(await dealDelete(db, { orgId: otherOrgId, dealId: won, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      expect((await db.select().from(schema.deals).where(eq(schema.deals.id, won))).length).toBe(1)
      expect(await audit('deal.deleted')).toHaveLength(0)
    })
  })

  describe('meetingDelete', () => {
    it('deletes a meeting with no outcome, and refuses one with an outcome', async () => {
      const m = (await db.insert(schema.meetings).values({ orgId, companyId, startsAt: NOON, timeZone: 'UTC', source: 'agent' }).returning())[0]!.id
      expect(await meetingDelete(db, { orgId, meetingId: m, actor: 'agent' })).toEqual({ ok: true, companyId })
      const [row] = await audit('meeting.deleted')
      expect(row).toMatchObject({ actor: 'agent', subjectType: 'meeting', subjectId: m })
      expect(row!.detail).toEqual({ companyId, startsAt: NOON.toISOString(), source: 'agent' })

      const held = (await db.insert(schema.meetings).values({ orgId, companyId, startsAt: NOON, timeZone: 'UTC', outcome: 'no_show' }).returning())[0]!.id
      expect(await meetingDelete(db, { orgId, meetingId: held, actor: ownerId })).toMatchObject({
        ok: false, code: 'outcome_recorded', message: 'Its outcome is recorded; it stays.',
      })
      expect(await meetingDelete(db, { orgId: otherOrgId, meetingId: held, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await meetingDelete(db, { orgId, meetingId: held.toUpperCase(), actor: ownerId })).toMatchObject({ ok: false, code: 'outcome_recorded' })
      expect(await audit('meeting.deleted')).toHaveLength(1)
    })

    /**
     * A reschedule's replacement (review, 2026-10-15): the original's outcome
     * says `rescheduled` and points at it, and deleted, the original was
     * "rescheduled" to nothing — never correctable, never deletable, and its
     * company held for good by `meeting_held`. It is cancelled instead.
     */
    it('refuses the meeting that replaced a rescheduled one, cancelled or not, and leaves the original pointing at it', async () => {
      const started = new Date(Date.now() - 3 * 3_600_000)
      const booked = await createMeeting(db, { orgId, companyId, startsAt: started, timeZone: 'UTC', source: 'manual', createdBy: ownerId, actor: ownerId })
      if (!booked.ok) throw new Error(booked.message)
      const moved = await rescheduleMeeting(db, { orgId, id: booked.meeting.id, startsAt: new Date(Date.now() + 86_400_000), timeZone: 'UTC', actor: ownerId })
      if (!moved.ok) throw new Error(moved.message)
      const replacement = moved.replacement.id
      expect(await meetingsThatReplacedOne(db, orgId, [booked.meeting.id, replacement.toUpperCase()])).toEqual(new Set([replacement]))

      for (const id of [replacement, replacement.toUpperCase()]) {
        expect(await meetingDelete(db, { orgId, meetingId: id, actor: ownerId })).toEqual({
          ok: false, code: 'replaces_rescheduled', message: 'It replaced a rescheduled meeting; cancel it instead.',
        })
      }
      expect(await cancelMeeting(db, orgId, replacement, ownerId)).toBe(true)
      expect(await meetingDelete(db, { orgId, meetingId: replacement, actor: ownerId })).toMatchObject({
        ok: false, code: 'replaces_rescheduled', message: expect.stringContaining('it is already cancelled'),
      })
      expect(await has(schema.meetings, replacement)).toBe(true)
      expect((await meetingRescheduleLinks(db, orgId, booked.meeting.id)).to?.id).toBe(replacement)
      expect(await audit('meeting.deleted')).toHaveLength(0)
    })

    it('knows a replacement by the original’s row alone, which is never caught', async () => {
      const m = (await db.insert(schema.meetings).values({ orgId, companyId, startsAt: NOON, timeZone: 'UTC' }).returning())[0]!.id
      await appendAudit(db, {
        orgId, actor: ownerId, action: 'meeting.outcome_recorded', subjectType: 'meeting', subjectId: NOWHERE,
        detail: { outcome: 'rescheduled', companyId, rescheduledTo: m },
      })
      expect(await meetingDelete(db, { orgId, meetingId: m, actor: ownerId })).toMatchObject({ ok: false, code: 'replaces_rescheduled' })
    })
  })

  describe('proposalDelete', () => {
    it('deletes a draft and refuses anything past draft', async () => {
      const scanId = (await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning())[0]!.id
      const draft = (await db.insert(schema.proposals).values({ orgId, companyId, scanId, title: 'P', document: {} }).returning())[0]!.id
      const sent = (await db.insert(schema.proposals).values({ orgId, companyId, scanId, title: 'P', document: {}, status: 'sent' }).returning())[0]!.id
      expect(await proposalDelete(db, { orgId, proposalId: draft, actor: ownerId })).toEqual({ ok: true, companyId })
      expect(await proposalDelete(db, { orgId, proposalId: sent, actor: ownerId })).toMatchObject({ ok: false, code: 'not_draft' })
      expect(await proposalDelete(db, { orgId: otherOrgId, proposalId: sent, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      const rows = await db.select().from(schema.proposals).where(eq(schema.proposals.orgId, orgId))
      expect(rows.map((p) => p.id)).toEqual([sent])
      expect((await audit('proposal.deleted'))[0]).toMatchObject({ subjectType: 'proposal', subjectId: draft, detail: { companyId } })
      // The scan it quoted is free to go with its company now; a sent proposal still holds it.
    })
  })

  describe('quoteDelete', () => {
    it('deletes a draft quote that never went out, leaving the company’s links, and refuses a sent one', async () => {
      const draft = (await db.insert(schema.quotes).values({ orgId, companyId, number: 'Q-2026-0001', title: 'Website', validUntil: '2026-10-30' }).returning())[0]!.id
      await db.insert(schema.shareLinks).values([
        { orgId, kind: 'report', companyId, tokenHash: tokenHash(), expiresAt: new Date(Date.now() + 86_400_000) },
      ])
      expect(await quoteDelete(db, { orgId, quoteId: draft, actor: ownerId })).toEqual({ ok: true, companyId, number: 'Q-2026-0001' })
      const links = await db.select().from(schema.shareLinks).where(eq(schema.shareLinks.orgId, orgId))
      expect(links.map((l) => l.kind)).toEqual(['report'])

      // A link is made only for a sent quote: a draft with one, revoked or not, went out (review, 2026-10-15).
      const revised = (await db.insert(schema.quotes).values({ orgId, companyId, number: 'Q-2026-0003', title: 'Website', validUntil: '2026-10-30' }).returning())[0]!.id
      await db.insert(schema.shareLinks).values({
        orgId, kind: 'quote', companyId, quoteId: revised, tokenHash: tokenHash(), expiresAt: new Date(Date.now() + 86_400_000), revokedAt: NOON,
      })
      expect(await quoteDelete(db, { orgId, quoteId: revised, actor: ownerId })).toMatchObject({ ok: false, code: 'not_draft' })
      expect((await audit('quote.deleted'))[0]).toMatchObject({ subjectType: 'quote', subjectId: draft, detail: { companyId, number: 'Q-2026-0001' } })

      const sent = (
        await db
          .insert(schema.quotes)
          .values({
            orgId, companyId, number: 'Q-2026-0002', title: 'Website', validUntil: '2026-10-30', status: 'sent', sentAt: NOON,
            seller: { name: 'Accemy' }, items: [{ name: 'Website', quantity: 1, unit: 'one_off', unitPrice: 25000 }],
          })
          .returning()
      )[0]!.id
      expect(await quoteDelete(db, { orgId, quoteId: sent, actor: ownerId })).toMatchObject({
        ok: false, code: 'not_draft', message: 'Only a draft quote can be deleted; withdraw a sent one.',
      })
      expect(await quoteDelete(db, { orgId, quoteId: sent.toUpperCase(), actor: ownerId })).toMatchObject({ ok: false, code: 'not_draft' })
      expect(await quoteDelete(db, { orgId: otherOrgId, quoteId: sent, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
    })

    /**
     * Sent, then edited — which makes it a draft again, with `sent_at` and its
     * seller cleared (`quoteUpdate`) — a quote is still a number in a buyer's
     * hands (review, 2026-10-15): deleted, the next quote raised took it.
     */
    it('refuses a quote that went out and was revised back to a draft, and keeps its number taken', async () => {
      const items = [{ serviceId: null, name: 'Website', description: null, quantity: 1, unit: 'one_off' as const, unitPrice: 25000 }]
      const raised = await quoteCreate(db, { orgId, companyId, items, createdBy: ownerId, actor: ownerId })
      if (!raised.ok) throw new Error(raised.message)
      const id = raised.quote.id
      expect(await quoteSend(db, { orgId, quoteId: id, actor: ownerId })).toMatchObject({ ok: true })
      expect(await quoteUpdate(db, { orgId, quoteId: id, patch: { title: 'Website, revised' }, actor: ownerId })).toMatchObject({
        ok: true, revised: true, quote: { status: 'draft', sentAt: null },
      })
      expect(await quotesEverSent(db, orgId, [id.toUpperCase()])).toEqual(new Set([id]))

      const r = await quoteDelete(db, { orgId, quoteId: id, actor: ownerId })
      expect(r).toMatchObject({ ok: false, code: 'not_draft' })
      if (!r.ok) expect(r.message).toBe(`${raised.quote.number} went out before it was revised back to a draft, and a buyer holds its number, so it stays. Mark it sent and withdraw it if it is no longer offered.`)
      expect(await companyDelete(db, { orgId, companyId, actor: ownerId })).toMatchObject({ ok: false, code: 'quote_sent' })
      expect((await db.select().from(schema.quotes).where(eq(schema.quotes.id, id))).length).toBe(1)
      expect(await audit('quote.deleted')).toHaveLength(0)

      // A draft that never went is the residual case: nothing outside holds its number.
      const never = await quoteCreate(db, { orgId, companyId, items, createdBy: ownerId, actor: ownerId })
      if (!never.ok) throw new Error(never.message)
      expect(await quotesEverSent(db, orgId, [never.quote.id])).toEqual(new Set())
      expect(await quoteDelete(db, { orgId, quoteId: never.quote.id, actor: ownerId })).toMatchObject({ ok: true })
    })
  })

  describe('taskDelete', () => {
    it('deletes a to-do and a call, and refuses a LinkedIn step and a call where they asked to stop', async () => {
      const todo = (await db.insert(schema.tasks).values({ orgId, companyId, kind: 'todo', title: 'T' }).returning())[0]!.id
      expect(await taskDelete(db, { orgId, taskId: todo, actor: ownerId })).toEqual({ ok: true, companyId, kind: 'todo' })
      expect((await audit('task.deleted'))[0]).toMatchObject({ subjectType: 'task', subjectId: todo, detail: { companyId, kind: 'todo' } })

      const reached = (await db.insert(schema.tasks).values({ orgId, companyId, kind: 'call', title: 'Call', doneAt: NOON, doneBy: ownerId, outcome: 'reached' }).returning())[0]!.id
      expect(await taskDelete(db, { orgId, taskId: reached, actor: ownerId })).toMatchObject({ ok: true, kind: 'call' })

      const linkedin = await touch({ campaignId, companyId, channel: 'linkedin', status: 'approved', approvedBy: ownerId, approvedAt: NOON })
      const step = (await db.insert(schema.tasks).values({ orgId, companyId, kind: 'linkedin_send', touchId: linkedin, title: 'Send' }).returning())[0]!.id
      expect(await taskDelete(db, { orgId, taskId: step, actor: ownerId })).toMatchObject({ ok: false, code: 'linkedin_step' })

      const stop = (await db.insert(schema.tasks).values({ orgId, companyId, kind: 'call', title: 'Call', doneAt: NOON, doneBy: ownerId, outcome: 'asked_to_stop' }).returning())[0]!.id
      expect(await taskDelete(db, { orgId, taskId: stop, actor: ownerId })).toMatchObject({
        ok: false, code: 'call_record', message: 'It records the call where they asked to stop; it stays.',
      })
      expect(await taskDelete(db, { orgId: otherOrgId, taskId: stop, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      expect((await db.select().from(schema.tasks).where(eq(schema.tasks.orgId, orgId))).map((t) => t.id).sort()).toEqual([step, stop].sort())
    })
  })

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------

  describe('campaignDelete', () => {
    it('deletes a campaign with its drafts, steps and runs, keeps a refused row naming a person, and removes the S6b row', async () => {
      const alex = await contact()
      const draft = await touch({ campaignId, contactId: alex, companyId })
      const queued = await touch({ campaignId, contactId: alex, companyId, status: 'queued' })
      const refusedForAlex = await touch({ campaignId, contactId: alex, companyId, status: 'refused', refusalCode: 'needs_approval' })
      // S6b: a refused row naming the campaign and nothing else.
      const refusedAlone = await touch({ campaignId, status: 'refused', refusalCode: 'campaign_inactive' })
      await db.insert(schema.campaignSteps).values({ orgId, campaignId, position: 2, kind: 'call', afterDays: 3 })
      await db.insert(schema.sequenceRuns).values({ orgId, campaignId, contactId: alex, startedAt: NOON, anchorAt: NOON, waitingTouchId: draft })

      expect(await campaignDelete(db, { orgId, campaignId, actor: ownerId })).toEqual({ ok: true, draftsRemoved: 3 })
      expect((await db.select().from(schema.campaigns).where(eq(schema.campaigns.orgId, orgId))).length).toBe(0)
      for (const id of [draft, queued, refusedAlone]) expect(await has(schema.touches, id)).toBe(false)
      expect(await rowOf(schema.touches, refusedForAlex)).toMatchObject({ campaignId: null, contactId: alex, status: 'refused' })
      expect(await countIn(schema.campaignSteps)).toBe(0)
      expect(await countIn(schema.sequenceRuns)).toBe(0)
      expect(await has(schema.contacts, alex)).toBe(true)
      const [row] = await audit('campaign.deleted')
      expect(row).toMatchObject({ subjectType: 'campaign', subjectId: campaignId })
      expect(row!.detail).toEqual({ name: 'Q4', channel: 'email', draftsRemoved: 3 })
    })

    const refusals: Array<[string, string, () => Promise<unknown>]> = [
      ['a message going out now', 'in_flight', () => touch({ campaignId, companyId, status: 'sending' })],
      ['a message that went', 'has_history', () => touch({ campaignId, companyId, status: 'sent', sentAt: NOON })],
      ['a message that may have gone', 'has_history', () => touch({ campaignId, companyId, status: 'failed' })],
      [
        'an answer to somebody’s reply waiting under it',
        'answer_waiting',
        async () => {
          const sam = await contact({ firstName: 'Sam', email: 'sam@rentman.io' })
          const reply = await touch({ contactId: sam, companyId, direction: 'in', status: 'replied', body: 'Tell me more' })
          await touch({ campaignId, contactId: sam, companyId, answersTouchId: reply, status: 'approved', approvedBy: ownerId, approvedAt: NOON })
        },
      ],
    ]
    for (const [what, code, arrange] of refusals) {
      it(`refuses ${what} (${code}), writing nothing`, async () => {
        const draft = await touch({ campaignId, companyId })
        await arrange()
        expect(await campaignDelete(db, { orgId, campaignId, actor: ownerId })).toMatchObject({ ok: false, code })
        expect((await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId))).length).toBe(1)
        expect(await has(schema.touches, draft)).toBe(true)
        expect(await audit('campaign.deleted')).toHaveLength(0)
      })
    }

    it('answers not_found for another org’s campaign', async () => {
      expect(await campaignDelete(db, { orgId: otherOrgId, campaignId, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
    })
  })

  // -------------------------------------------------------------------------
  // Every writer reads an id as the database prints it
  // -------------------------------------------------------------------------

  /**
   * An id in capitals finds the row in Postgres whatever the writer does;
   * each writer lower-cases it first (review, 2026-10-15), so every refusal
   * is asked of the same id the rows it reads come back with.
   */
  it('refuses in capitals what it refuses as stored, in every writer', async () => {
    const up = (id: string) => id.toUpperCase()
    const won = (await db.insert(schema.deals).values({ orgId, companyId, stage: 'won', closedAt: NOON }).returning())[0]!.id
    expect(await dealDelete(db, { orgId, dealId: up(won), actor: ownerId })).toMatchObject({ ok: false, code: 'deal_won' })
    const scanId = (await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning())[0]!.id
    const sent = (await db.insert(schema.proposals).values({ orgId, companyId, scanId, title: 'P', document: {}, status: 'sent' }).returning())[0]!.id
    expect(await proposalDelete(db, { orgId, proposalId: up(sent), actor: ownerId })).toMatchObject({ ok: false, code: 'not_draft' })
    const stop = (await db.insert(schema.tasks).values({ orgId, companyId, kind: 'call', title: 'Call', doneAt: NOON, doneBy: ownerId, outcome: 'asked_to_stop' }).returning())[0]!.id
    expect(await taskDelete(db, { orgId, taskId: up(stop), actor: ownerId })).toMatchObject({ ok: false, code: 'call_record' })
    await touch({ campaignId, companyId, status: 'sent', sentAt: NOON })
    expect(await campaignDelete(db, { orgId, campaignId: up(campaignId), actor: ownerId })).toMatchObject({ ok: false, code: 'has_history' })
    const used = (await db.insert(schema.messageTemplates).values({ orgId, channel: 'sms', externalId: '1108', senderId: 'ACMEIN', category: 'transactional', body: 'Hi {#var#}' }).returning())[0]!.id
    await touch({ contactId: await contact({ phone: '+919876543210' }), companyId, channel: 'sms', templateId: used, body: 'Hi Alex' })
    expect(await templateDelete(db, { orgId, templateId: up(used), actor: ownerId })).toMatchObject({ ok: false, code: 'in_use' })
    expect(await icpProfileDelete(db, { orgId, profileId: up(icpId), actor: ownerId })).toMatchObject({ ok: false, code: 'active' })

    // …and deletes in capitals what it may, with the id as stored on its row.
    const open = (await db.insert(schema.deals).values({ orgId, companyId, stage: 'lost', lostReason: 'x', closedAt: NOON }).returning())[0]!.id
    expect(await dealDelete(db, { orgId, dealId: up(open), actor: ownerId })).toMatchObject({ ok: true })
    expect((await audit('deal.deleted'))[0]!.subjectId).toBe(open)
    for (const action of ['proposal.deleted', 'task.deleted', 'campaign.deleted', 'template.deleted', 'icp.deleted']) {
      expect(await audit(action), action).toHaveLength(0)
    }
  })

  // -------------------------------------------------------------------------
  // Templates and profiles
  // -------------------------------------------------------------------------

  describe('templateDelete', () => {
    it('deletes a registration nothing names, and keeps one a message was checked against', async () => {
      const unused = (await db.insert(schema.messageTemplates).values({ orgId, channel: 'sms', externalId: '1107', senderId: 'ACMEIN', category: 'transactional', body: 'Hi {#var#}' }).returning())[0]!.id
      expect(await templateDelete(db, { orgId, templateId: unused, actor: ownerId })).toEqual({ ok: true })
      expect((await audit('template.deleted'))[0]).toMatchObject({
        subjectType: 'message_template', subjectId: unused, detail: { channel: 'sms', externalId: '1107' },
      })

      const used = (await db.insert(schema.messageTemplates).values({ orgId, channel: 'sms', externalId: '1108', senderId: 'ACMEIN', category: 'transactional', body: 'Hi {#var#}' }).returning())[0]!.id
      const alex = await contact({ phone: '+919876543210' })
      await touch({ contactId: alex, companyId, channel: 'sms', templateId: used, body: 'Hi Alex' })
      expect(await templateDelete(db, { orgId, templateId: used, actor: ownerId })).toEqual({
        ok: false, code: 'in_use', message: 'Messages were checked against this registration, so it stays; switch it off instead.',
      })
      expect(await templateDelete(db, { orgId: otherOrgId, templateId: used, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await audit('template.deleted')).toHaveLength(1)
    })
  })

  describe('icpProfileDelete', () => {
    it('deletes an inactive profile that scored nothing, and keeps the active one and one that scored', async () => {
      const spare = (await db.insert(schema.icpProfiles).values({ orgId, name: 'Spare', definition: {}, active: false }).returning())[0]!.id
      await db.update(schema.campaigns).set({ icpProfileId: spare }).where(eq(schema.campaigns.id, campaignId))
      expect(await icpProfileDelete(db, { orgId, profileId: spare, actor: ownerId })).toEqual({ ok: true, name: 'Spare' })
      expect((await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)))[0]!.icpProfileId).toBeNull()
      expect((await audit('icp.deleted'))[0]).toMatchObject({ subjectType: 'icp_profile', subjectId: spare, detail: { label: 'Spare' } })

      expect(await icpProfileDelete(db, { orgId, profileId: icpId, actor: ownerId })).toMatchObject({ ok: false, code: 'active' })

      const scored = (await db.insert(schema.icpProfiles).values({ orgId, name: 'Old', definition: {}, active: false }).returning())[0]!.id
      const scanId = (await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning())[0]!.id
      await db.insert(schema.scores).values({ orgId, companyId, icpProfileId: scored, score: 40, scanId })
      expect(await icpProfileDelete(db, { orgId, profileId: scored, actor: ownerId })).toEqual({
        ok: false, code: 'scored', message: 'Scores were computed under it, so it stays as their record.',
      })
      expect(await icpProfileDelete(db, { orgId: otherOrgId, profileId: scored, actor: ownerId })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await audit('icp.deleted')).toHaveLength(1)
    })
  })
})
