/**
 * /compliance: the questions an auditor asks, as counts of rows (§2.1, §2.2).
 *
 * Every block is seeded with rows that SHOULD count and rows that should
 * not, in two orgs, because a count that only ever sees the rows it expects
 * cannot tell a working filter from a missing one. Three cases are the ones
 * the page exists for:
 *
 *   * stale is DERIVED from `ran_at` while `findings.stale` still says fresh;
 *   * a voice/SMS message that went out with no granted consent is listed,
 *     one with a grant is not — and one the send path REFUSED is the gate
 *     working, counted apart, never as a breach;
 *   * an opt-out that never reached the suppression list is found, through
 *     the real writer rather than a hand-forced row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { decideSend, type SendFacts, type SendRefusalCode } from '@agency/core'
import {
  COMPLIANCE_AUTO_SEND_OFF_COLD_WHERE, COMPLIANCE_REFUSAL_HUMAN_CAN_RESOLVE,
  appendAudit, complianceAutoSendOffCold, complianceColdOptInTouches, complianceConsentsByChannel,
  complianceDisclosure, complianceDraftsOnStaleEvidence, complianceEvidenceFreshness,
  complianceHumanCanResolve, complianceLateApprovals, complianceOptOutsNotRecorded,
  complianceOptOutsWithoutSuppression, complianceRefusalsByCode, complianceSummary,
  complianceSuppressionsBySource, recordInboundReply, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
const STALE_DAYS = 14

describe('the compliance counts', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let otherUserId: string
  /** One company per evidence state, and one in the other org. */
  let fresh: string
  let stale: string
  let down: string
  let never: string
  let theirs: string

  const company = async (org: string, domain: string) =>
    (await db.insert(schema.companies).values({ orgId: org, domain }).returning({ id: schema.companies.id }))[0]!.id

  const contact = async (org: string, companyId: string, email: string, phone?: string) =>
    (
      await db
        .insert(schema.contacts)
        .values({ orgId: org, companyId, email, phone: phone ?? null })
        .returning({ id: schema.contacts.id })
    )[0]!.id

  /** A scan at `ranAt`; a successful one carries an observed gap whose cached `stale` says FRESH. */
  const scan = async (org: string, companyId: string, ranAt: Date, ok: boolean) => {
    const [row] = await db
      .insert(schema.scans)
      .values({ orgId: org, companyId, ranAt, ok, error: ok ? null : 'timeout' })
      .returning({ id: schema.scans.id })
    if (ok) {
      await db.insert(schema.findings).values({
        orgId: org, scanId: row!.id, companyId, signalKey: 'csp', observed: true, gap: true,
        weight: 10, evidence: { header: null }, stale: false,
      })
    }
    return row!.id
  }

  const touch = async (values: Partial<typeof schema.touches.$inferInsert> & { orgId: string; channel: string; direction: string }) =>
    (await db.insert(schema.touches).values(values).returning({ id: schema.touches.id }))[0]!.id

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    otherOrgId = other!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    otherUserId = (await db.insert(schema.users).values({ orgId: otherOrgId, email: 'owner@rival.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    fresh = await company(orgId, 'fresh.test')
    stale = await company(orgId, 'stale.test')
    down = await company(orgId, 'down.test')
    never = await company(orgId, 'never.test')
    theirs = await company(otherOrgId, 'theirs.test')
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  // -------------------------------------------------------------------------
  describe('consent, per channel and by where it was recorded', () => {
    it('counts granted and refused per channel, and classes the source by what its writer stamps', async () => {
      const a = await contact(orgId, fresh, 'a@fresh.test')
      const b = await contact(orgId, fresh, 'b@fresh.test')
      const c = await contact(orgId, stale, 'c@stale.test')
      await db.insert(schema.consents).values([
        // The booking page's own stamp, source and form both.
        { orgId, contactId: a, channel: 'email', granted: true, source: 'booking page, 2026-09-15', evidence: { form: 'booking_page' } },
        { orgId, contactId: a, channel: 'sms', granted: true, source: 'booking page, 2026-09-15', evidence: { form: 'booking_page' } },
        // The contacts page's form, and the older route's suffix with no form.
        { orgId, contactId: b, channel: 'voice', granted: false, source: 'said no on a call (recorded by owner@agency.test)' },
        { orgId, contactId: b, channel: 'email', granted: true, source: 'a signed form', evidence: { form: 'contacts_page' } },
        // A person typing "booking page" into that form is a person's record, not the booking page's.
        { orgId, contactId: c, channel: 'whatsapp', granted: true, source: 'booking page (recorded by owner@agency.test)' },
        { orgId, contactId: c, channel: 'email', granted: false, source: 'seed' },
      ])
      const theirContact = await contact(otherOrgId, theirs, 'x@theirs.test')
      await db.insert(schema.consents).values({ orgId: otherOrgId, contactId: theirContact, channel: 'email', granted: true, source: 'booking page, 2026-09-01' })

      const r = await complianceConsentsByChannel(db, orgId)
      expect(r.total).toEqual({ granted: 4, refused: 2 })
      expect(r.byChannel).toEqual([
        { channel: 'email', granted: 2, refused: 1 },
        { channel: 'sms', granted: 1, refused: 0 },
        { channel: 'voice', granted: 0, refused: 1 },
        { channel: 'whatsapp', granted: 1, refused: 0 },
      ])
      expect(r.bySource).toEqual([
        { source: 'booking_page', granted: 2, refused: 0 },
        { source: 'contacts_page', granted: 2, refused: 1 },
        { source: 'other', granted: 0, refused: 1 },
      ])
    })

    it('shows every channel at zero for an org with no consent rows — absence is NO, not missing data', async () => {
      const r = await complianceConsentsByChannel(db, otherOrgId)
      expect(r.byChannel.map((c) => c.channel)).toEqual(['email', 'sms', 'voice', 'whatsapp'])
      expect(r.total).toEqual({ granted: 0, refused: 0 })
    })
  })

  // -------------------------------------------------------------------------
  describe('suppressions, by the path that recorded them', () => {
    it('counts each source, NULL as unrecorded, inside and outside the window', async () => {
      await db.insert(schema.suppressions).values([
        { orgId, kind: 'email', value: 'a@x.test', reason: 'asked', source: 'manual', createdAt: ago(2) },
        { orgId, kind: 'email', value: 'b@x.test', reason: 'replied stop', source: 'reply', createdAt: ago(3) },
        { orgId, kind: 'phone', value: '+14155550100', reason: 'said stop', source: 'voice', createdAt: ago(4) },
        { orgId, kind: 'domain', value: 'old.test', reason: 'before 0018', source: null, createdAt: ago(5) },
        { orgId, kind: 'email', value: 'c@x.test', reason: 'long ago', source: 'manual', createdAt: ago(40) },
        { orgId: otherOrgId, kind: 'email', value: 'a@x.test', reason: 'theirs', source: 'manual', createdAt: ago(1) },
      ])
      const window = await complianceSuppressionsBySource(db, orgId, ago(30))
      expect(window.total).toBe(4)
      expect(window.bySource).toEqual([
        { source: 'manual', n: 1 },
        { source: 'reply', n: 1 },
        { source: 'voice', n: 1 },
        { source: 'unsubscribe', n: 0 },
        { source: 'erasure', n: 0 },
        { source: 'unrecorded', n: 1 },
      ])
      const all = await complianceSuppressionsBySource(db, orgId, null)
      expect(all.total).toBe(5)
      expect(all.bySource.find((s) => s.source === 'manual')?.n).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  describe('refusals, by the rule that refused', () => {
    it('counts by code inside the window, measured from when the row was REFUSED, with the human split', async () => {
      await touch({ orgId, companyId: fresh, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'suppressed', createdAt: ago(1) })
      await touch({ orgId, companyId: fresh, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'suppressed', createdAt: ago(2) })
      await touch({ orgId, companyId: fresh, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'quiet_hours', createdAt: ago(3) })
      // Drafted in August, refused yesterday: yesterday's refusal.
      await touch({ orgId, companyId: stale, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'needs_approval', createdAt: ago(45), updatedAt: ago(0.5) })
      // Refused long ago: outside the window.
      await touch({ orgId, companyId: stale, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'daily_cap', createdAt: ago(45) })
      // Not refused at all.
      await touch({ orgId, companyId: stale, channel: 'email', direction: 'out', status: 'sent', sentAt: ago(1), createdAt: ago(1) })
      await touch({ orgId: otherOrgId, companyId: theirs, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'suppressed', createdAt: ago(1) })

      const r = await complianceRefusalsByCode(db, orgId, ago(30))
      expect(r.total).toBe(4)
      expect(r.byCode).toEqual([
        { code: 'suppressed', n: 2, humanCanResolve: false },
        { code: 'needs_approval', n: 1, humanCanResolve: true },
        { code: 'quiet_hours', n: 1, humanCanResolve: true },
      ])
      expect(r.humanCanResolve).toBe(2)
      expect(r.noOneCanOverride).toBe(2)
      expect(r.unknownCode).toBe(0)
      expect(r.recent.map((x) => x.code)).toEqual(['needs_approval', 'suppressed', 'suppressed', 'quiet_hours'])
      expect(r.recent[0]!.companyDomain).toBe('stale.test')
    })

    it('never folds a code it does not know into either side', () => {
      expect(complianceHumanCanResolve('something_new')).toBeNull()
      expect(complianceHumanCanResolve('toString')).toBeNull()
    })

    /**
     * The split is `decideSend`'s own `humanCanResolve`, restated per code
     * because the row stores the code. Driving the real function into every
     * code it can produce is what stops the restatement drifting.
     */
    it('agrees with decideSend on every code it can produce', () => {
      const base: SendFacts = {
        channel: 'email', recipient: 'priya@rentman.io', suppressed: false, consent: null,
        recipientTimeZone: 'Europe/London', quietStart: '21:00', quietEnd: '08:00',
        sentToday: 0, dailyCap: 25, campaignStatus: 'active', autoSend: true,
        now: new Date('2026-09-15T12:00:00.000Z'),
      }
      const cases: Record<Exclude<SendRefusalCode, 'no_consent'>, Partial<SendFacts>> = {
        cold_channel_forbidden: { channel: 'sms', recipient: '+14155550100' },
        unparseable_recipient: { recipient: 'not an address' },
        suppressed: { suppressed: true },
        bounced: { recipientBounced: true },
        consent_revoked: { consent: { granted: false, source: 'reply' } },
        unknown_timezone: { recipientTimeZone: null },
        quiet_hours: { now: new Date('2026-09-15T23:00:00.000Z') },
        daily_cap: { sentToday: 25 },
        campaign_inactive: { campaignStatus: 'paused' },
        needs_approval: { autoSend: false },
      }
      for (const [code, over] of Object.entries(cases)) {
        const d = decideSend({ ...base, ...over })
        expect(d.allowed).toBe(false)
        if (d.allowed) continue
        expect(d.code).toBe(code)
        expect(COMPLIANCE_REFUSAL_HUMAN_CAN_RESOLVE[d.code]).toBe(d.humanCanResolve)
      }
    })
  })

  // -------------------------------------------------------------------------
  describe('the AI disclosure', () => {
    it('lists an answered inbound call with no disclosure, and nothing else', async () => {
      const [bad] = await db.insert(schema.calls).values({
        orgId, direction: 'in', status: 'completed', fromNumber: '+14155550101', startedAt: ago(1), answeredAt: ago(1),
      }).returning({ id: schema.calls.id })
      await db.insert(schema.calls).values([
        { orgId, direction: 'in', status: 'completed', fromNumber: '+14155550102', startedAt: ago(1), answeredAt: ago(1), disclosedAiAt: ago(1) },
        // Never answered, so it never had to disclose.
        { orgId, direction: 'in', status: 'no_answer', fromNumber: '+14155550103', startedAt: ago(1) },
        { orgId: otherOrgId, direction: 'in', status: 'completed', fromNumber: '+14155550104', startedAt: ago(1), answeredAt: ago(1) },
      ])
      const r = await complianceDisclosure(db, orgId)
      expect(r.calls).toBe(3)
      expect(r.answeredInbound).toBe(2)
      expect(r.undisclosed.map((c) => c.id)).toEqual([bad!.id])
    })
  })

  // -------------------------------------------------------------------------
  describe('evidence freshness', () => {
    /**
     * THE case. `findings.stale` on the 20-day-old scan still says false,
     * because nothing has run `markStaleFindings` since. The page must call
     * it stale anyway, and say how many the cache disagrees about.
     */
    it('derives stale from ran_at while findings.stale still says fresh', async () => {
      await scan(orgId, fresh, ago(2), true)
      await scan(orgId, stale, ago(20), true)
      await scan(orgId, down, ago(40), true)
      await scan(orgId, down, ago(1), false)
      await scan(otherOrgId, theirs, ago(90), true)

      const cached = await db.select({ stale: schema.findings.stale }).from(schema.findings).where(eq(schema.findings.companyId, stale))
      expect(cached.map((f) => f.stale)).toEqual([false])

      const r = await complianceEvidenceFreshness(db, orgId, STALE_DAYS, NOW)
      expect(r).toMatchObject({ total: 4, fresh: 1, stale: 1, unreachable: 1, neverScanned: 1, staleColumnSaysFresh: 1 })
      expect(r.notFresh.map((c) => [c.domain, c.state])).toEqual([
        ['never.test', 'never_scanned'],
        ['down.test', 'unreachable'],
        ['stale.test', 'stale'],
      ])
      // Three weeks on, the fresh one is not.
      expect((await complianceEvidenceFreshness(db, orgId, STALE_DAYS, new Date(NOW.getTime() + 21 * DAY))).fresh).toBe(0)
    })

    it('stops counting the cache once the sweep has caught up', async () => {
      await scan(orgId, stale, ago(20), true)
      await db.update(schema.findings).set({ stale: true }).where(eq(schema.findings.companyId, stale))
      const r = await complianceEvidenceFreshness(db, orgId, STALE_DAYS, NOW)
      expect(r.stale).toBe(1)
      expect(r.staleColumnSaysFresh).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  describe('drafts awaiting approval on stale or missing evidence', () => {
    it('lists drafts whose company the generator could not quote today, by company or through the contact', async () => {
      await scan(orgId, fresh, ago(2), true)
      await scan(orgId, stale, ago(20), true)
      // Down now, but its last SUCCESSFUL scan is what a draft would quote — and that is 40 days old.
      await scan(orgId, down, ago(40), true)
      await scan(orgId, down, ago(1), false)
      const viaContact = await contact(orgId, stale, 'c@stale.test')

      const onFresh = await touch({ orgId, companyId: fresh, channel: 'email', direction: 'out', status: 'awaiting_approval' })
      const onStale = await touch({ orgId, companyId: stale, channel: 'email', direction: 'out', status: 'awaiting_approval' })
      const onNever = await touch({ orgId, companyId: never, channel: 'email', direction: 'out', status: 'awaiting_approval' })
      const onDown = await touch({ orgId, companyId: down, channel: 'email', direction: 'out', status: 'awaiting_approval' })
      const throughContact = await touch({ orgId, contactId: viaContact, channel: 'email', direction: 'out', status: 'awaiting_approval' })
      // Already decided: not awaiting anybody.
      await touch({ orgId, companyId: stale, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'needs_approval' })
      await scan(otherOrgId, theirs, ago(90), true)
      await touch({ orgId: otherOrgId, companyId: theirs, channel: 'email', direction: 'out', status: 'awaiting_approval' })

      const r = await complianceDraftsOnStaleEvidence(db, orgId, STALE_DAYS, NOW)
      expect(r.awaiting).toBe(5)
      expect(r.count).toBe(4)
      const why = new Map(r.rows.map((d) => [d.touchId, d.why]))
      expect(why.has(onFresh)).toBe(false)
      expect(why.get(onStale)).toBe('stale')
      expect(why.get(onNever)).toBe('no_evidence')
      expect(why.get(onDown)).toBe('stale')
      expect(why.get(throughContact)).toBe('stale')
      expect(r.rows.find((d) => d.touchId === throughContact)?.domain).toBe('stale.test')
    })

    it('tags an answer to a reply rather than leaving it out', async () => {
      const reply = await touch({ orgId, companyId: never, channel: 'email', direction: 'in', status: 'replied', replyKind: 'interested' })
      await touch({ orgId, companyId: never, channel: 'email', direction: 'out', status: 'awaiting_approval', answersTouchId: reply })
      const r = await complianceDraftsOnStaleEvidence(db, orgId, STALE_DAYS, NOW)
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0]!.answersReply).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  describe('voice, SMS and WhatsApp that went out without a granted consent row', () => {
    it('lists a message with no grant, not one with a grant — and counts a refusal apart as the gate working', async () => {
      const noConsent = await contact(orgId, fresh, 'p@fresh.test', '+14155550110')
      const granted = await contact(orgId, fresh, 'q@fresh.test', '+14155550111')
      const saidNo = await contact(orgId, fresh, 'r@fresh.test', '+14155550112')
      await db.insert(schema.consents).values([
        { orgId, contactId: granted, channel: 'voice', granted: true, source: 'booking page, 2026-09-01' },
        { orgId, contactId: saidNo, channel: 'whatsapp', granted: false, source: 'replied no', recordedAt: ago(1) },
      ])

      const listed = await touch({ orgId, contactId: noConsent, companyId: fresh, channel: 'sms', direction: 'out', status: 'sent', sentAt: ago(5) })
      await touch({ orgId, contactId: granted, companyId: fresh, channel: 'voice', direction: 'out', status: 'sent', sentAt: ago(5) })
      const refusedSince = await touch({ orgId, contactId: saidNo, channel: 'whatsapp', direction: 'out', status: 'delivered', sentAt: ago(5) })
      // The send path refusing a cold SMS is the rule working, never a breach.
      await touch({ orgId, contactId: noConsent, companyId: fresh, channel: 'sms', direction: 'out', status: 'refused', refusalCode: 'cold_channel_forbidden' })
      // Not yet out of the building.
      await touch({ orgId, contactId: noConsent, companyId: fresh, channel: 'sms', direction: 'out', status: 'awaiting_approval' })
      // Cold email needs no opt-in: that is what makes it a cold channel.
      await touch({ orgId, contactId: noConsent, companyId: fresh, channel: 'email', direction: 'out', status: 'sent', sentAt: ago(5) })
      // An inbound SMS is somebody writing to us.
      await touch({ orgId, contactId: noConsent, channel: 'sms', direction: 'in', status: 'replied' })
      const theirContact = await contact(otherOrgId, theirs, 'x@theirs.test', '+14155550113')
      await touch({ orgId: otherOrgId, contactId: theirContact, channel: 'sms', direction: 'out', status: 'sent', sentAt: ago(5) })

      const r = await complianceColdOptInTouches(db, orgId)
      expect(r.touches).toBe(2)
      expect(r.contacts).toBe(2)
      expect(r.stoppedBySendPath).toBe(1)
      expect(r.stoppedRows.map((x) => [x.code, x.channel, x.companyDomain])).toEqual([['cold_channel_forbidden', 'sms', 'fresh.test']])
      const row = new Map(r.rows.map((x) => [x.touchId, x]))
      expect(row.get(listed)).toMatchObject({ consentNow: 'never_asked', companyDomain: 'fresh.test', channel: 'sms' })
      // Said no AFTER the message: the ledger keeps today's answer, and the row shows when.
      expect(row.get(refusedSince)).toMatchObject({ consentNow: 'refused', companyDomain: 'fresh.test' })
      expect(row.get(refusedSince)!.consentRecordedAt!.getTime()).toBeGreaterThan(row.get(refusedSince)!.sentAt!.getTime())
    })

    it('reports a message whose contact was erased as uncheckable, and does not count it as a contact', async () => {
      const gone = await contact(orgId, fresh, 'gone@fresh.test', '+14155550114')
      await touch({ orgId, contactId: gone, companyId: fresh, channel: 'voice', direction: 'out', status: 'sent', sentAt: ago(5) })
      await db.delete(schema.contacts).where(eq(schema.contacts.id, gone))
      const r = await complianceColdOptInTouches(db, orgId)
      expect(r.touches).toBe(1)
      expect(r.contacts).toBe(0)
      expect(r.rows[0]).toMatchObject({ consentNow: 'contact_erased', companyDomain: 'fresh.test' })
    })
  })

  // -------------------------------------------------------------------------
  describe('opt-outs that did not reach the suppression list', () => {
    it('matches opted-out replies and calls with the send path’s own keys', async () => {
      await db.insert(schema.suppressions).values([
        { orgId, kind: 'email', value: 'sam@acme.test', reason: 'replied stop', source: 'reply' },
        { orgId, kind: 'domain', value: 'blocked.test', reason: 'whole company', source: 'manual' },
        { orgId, kind: 'phone', value: '+14155550123', reason: 'said stop', source: 'voice' },
        // The other org's list does not cover this org's opt-outs.
        { orgId: otherOrgId, kind: 'email', value: 'kim@nowhere.test', reason: 'theirs', source: 'reply' },
      ])
      const opted = (recipient: string) =>
        touch({ orgId, companyId: fresh, channel: 'email', direction: 'in', status: 'replied', replyKind: 'opted_out', recipient })
      await opted(' Sam@Acme.test ')
      await opted('lee@blocked.test')
      const missing = await opted('kim@nowhere.test')
      const unreadable = await opted('not an address')
      await touch({ orgId, channel: 'email', companyId: fresh, direction: 'in', status: 'replied', replyKind: 'interested', recipient: 'pat@nowhere.test' })

      await db.insert(schema.calls).values({ orgId, direction: 'in', status: 'completed', fromNumber: '+1 (415) 555-0123', optedOutAt: ago(1) })
      const [unmatchedCall] = await db.insert(schema.calls).values({ orgId, direction: 'in', status: 'completed', fromNumber: '+14155550999', optedOutAt: ago(1) }).returning({ id: schema.calls.id })
      const [withheld] = await db.insert(schema.calls).values({ orgId, direction: 'in', status: 'completed', fromNumber: null, optedOutAt: ago(1) }).returning({ id: schema.calls.id })
      await db.insert(schema.calls).values({ orgId: otherOrgId, direction: 'in', status: 'completed', fromNumber: '+14155550888', optedOutAt: ago(1) })

      const r = await complianceOptOutsWithoutSuppression(db, orgId)
      expect(r.replies).toBe(2)
      expect(r.calls).toBe(2)
      expect(r.count).toBe(4)
      const why = new Map(r.rows.map((x) => [x.id, x.why]))
      expect(why.get(missing)).toBe('no_matching_row')
      expect(why.get(unreadable)).toBe('unreadable')
      expect(why.get(unmatchedCall!.id)).toBe('no_matching_row')
      expect(why.get(withheld!.id)).toBe('unreadable')
    })

    /**
     * Through the real writer: a reply that says stop from an address the
     * normaliser cannot read. `recordInboundReply` audits
     * `contact.opt_out_not_recorded`; the page must count that AND still
     * find the reply outstanding.
     */
    it('counts the writer’s own opt_out_not_recorded row and still finds the reply outstanding', async () => {
      const priya = await contact(orgId, fresh, 'priya@fresh.test')
      const errors: string[] = []
      const reply = await recordInboundReply(db, {
        orgId, contactId: priya, channel: 'email', from: 'not an address', subject: null, body: 'stop',
        log: { error: (message) => errors.push(message) },
      })
      expect(reply.optOutNotRecorded).toBe(true)
      expect(errors).toHaveLength(1)

      const recorded = await complianceOptOutsNotRecorded(db, orgId, null)
      expect(recorded.count).toBe(1)
      expect(recorded.rows[0]).toMatchObject({ channel: 'email', companyDomain: 'fresh.test' })
      const outstanding = await complianceOptOutsWithoutSuppression(db, orgId)
      expect(outstanding.rows.map((x) => [x.id, x.why])).toEqual([[reply.touchId, 'unreadable']])
      expect((await complianceOptOutsNotRecorded(db, otherOrgId, null)).count).toBe(0)
    })

    it('counts the audit rows inside the window and all time', async () => {
      const entry = { orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', detail: { channel: 'email', why: 'unparseable_address' } }
      await db.insert(schema.auditLog).values([
        { ...entry, createdAt: ago(3) },
        { ...entry, createdAt: ago(45) },
        { ...entry, action: 'contact.replied', createdAt: ago(3) },
        { ...entry, orgId: otherOrgId, createdAt: ago(3) },
      ])
      expect((await complianceOptOutsNotRecorded(db, orgId, ago(30))).count).toBe(1)
      expect((await complianceOptOutsNotRecorded(db, orgId, null)).count).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  describe('approvals decided after expiry — informational', () => {
    it('counts a decision stamped after its expiry, and nothing decided in time', async () => {
      // Requested by a person: an agent's request must name its turn (0007),
      // which is beside the point here.
      const base = { toolName: 'queue_touch', risk: 'high' } as const
      const [late] = await db.insert(schema.approvals).values({
        ...base, requestedBy: userId, orgId, status: 'approved', decidedBy: userId, decidedAt: ago(1), expiresAt: new Date(ago(1).getTime() - 60_000),
      }).returning({ id: schema.approvals.id })
      await db.insert(schema.approvals).values([
        { ...base, requestedBy: userId, orgId, status: 'denied', decidedBy: userId, decidedAt: ago(2), expiresAt: ago(1) },
        { ...base, requestedBy: userId, orgId, status: 'expired', expiresAt: ago(3) },
        { ...base, requestedBy: userId, orgId, status: 'pending', expiresAt: ago(3) },
        { ...base, requestedBy: otherUserId, orgId: otherOrgId, status: 'approved', decidedBy: otherUserId, decidedAt: ago(1), expiresAt: ago(2) },
      ])
      const r = await complianceLateApprovals(db, orgId)
      expect(r.count).toBe(1)
      expect(r.rows[0]!.id).toBe(late!.id)
    })
  })

  // -------------------------------------------------------------------------
  describe('auto_send off email and LinkedIn', () => {
    it('answers zero because the CHECK refuses the row', async () => {
      await db.insert(schema.campaigns).values({ orgId, name: 'Cold email', channel: 'email', autoSend: true })
      await expect(
        db.insert(schema.campaigns).values({ orgId, name: 'Cold SMS', channel: 'sms', autoSend: true }),
      ).rejects.toThrow()
      const r = await complianceAutoSendOffCold(db, orgId)
      expect(r).toMatchObject({ count: 0, constraint: 'campaigns_no_auto_send_on_voice_or_sms' })
      expect(r.where).toBe(COMPLIANCE_AUTO_SEND_OFF_COLD_WHERE)
    })

    /**
     * A query that cannot report failure reads as evidence and is not
     * (CLAUDE.md, the disclosure audit). The rows it would find cannot be
     * stored, so the same predicate is run over rows that are not stored.
     */
    it('is a predicate that WOULD find a voice, SMS or WhatsApp auto-send if one existed', async () => {
      const r = await test.pg.query<{ channel: string }>(
        `SELECT channel FROM (VALUES (true, 'sms'), (true, 'voice'), (true, 'whatsapp'), (true, 'email'),
           (true, 'linkedin'), (false, 'sms')) AS campaigns(auto_send, channel)
         WHERE ${COMPLIANCE_AUTO_SEND_OFF_COLD_WHERE} ORDER BY channel`,
      )
      expect(r.rows.map((x) => x.channel)).toEqual(['sms', 'voice', 'whatsapp'])
    })
  })

  // -------------------------------------------------------------------------
  describe('the summary', () => {
    it('carries every block, and nothing of another org', async () => {
      await scan(orgId, stale, ago(20), true)
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'a@x.test', reason: 'asked', source: 'manual', createdAt: ago(2) })
      await touch({ orgId, companyId: stale, channel: 'email', direction: 'out', status: 'awaiting_approval' })
      await appendAudit(db, { orgId, actor: 'system', action: 'contact.opt_out_not_recorded', detail: { channel: 'email', why: 'x' } })

      const mine = await complianceSummary(db, orgId, { staleDays: STALE_DAYS, now: NOW })
      expect(mine.windowDays).toBe(30)
      expect(mine.since.toISOString()).toBe(ago(30).toISOString())
      expect(mine.freshness).toMatchObject({ total: 4, stale: 1, neverScanned: 3 })
      expect(mine.draftsOnStaleEvidence.count).toBe(1)
      expect(mine.suppressions.allTime.total).toBe(1)
      expect(mine.optOuts.notRecorded.allTime).toBe(1)
      expect(mine.autoSendOffCold.count).toBe(0)

      const theirsSummary = await complianceSummary(db, otherOrgId, { staleDays: STALE_DAYS, now: NOW })
      expect(theirsSummary.freshness).toMatchObject({ total: 1, neverScanned: 1 })
      expect(theirsSummary.draftsOnStaleEvidence.count).toBe(0)
      expect(theirsSummary.suppressions.allTime.total).toBe(0)
      expect(theirsSummary.optOuts.notRecorded.allTime).toBe(0)
      expect(theirsSummary.refusals.total).toBe(0)
      expect(theirsSummary.coldOptIn.touches).toBe(0)
      expect(theirsSummary.disclosure.calls).toBe(0)
      expect(theirsSummary.lateApprovals.count).toBe(0)
    })
  })
})
