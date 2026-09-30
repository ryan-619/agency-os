/**
 * Meetings and the brief, against a real engine (PROMPT.md §8.6).
 *
 * Recording a meeting moves the deal forward; the brief is built from the
 * rows and flags what it may not quote. Both are asserted here against the
 * schema 0012 introduced, including what it refuses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  briefForMeeting, cancelMeeting, createMeeting, meetingRescheduleLinks, meetingsForCompany, openDealFor,
  readMeeting, readMeetingWithCompany, rescheduleMeeting, schema, setMeetingOutcome, upcomingMeetings,
  type AgencyDb,
} from '../src/index.js'
import { migratedDb,expectRejection, type TestDb } from './helpers.js'

const ICP = JSON.parse(readFileSync(fileURLToPath(new URL('../seed/icp-security-gap-saas.json', import.meta.url)), 'utf8'))
const NOW = new Date('2026-09-15T12:00:00.000Z')
const SOON = new Date('2026-09-18T14:00:00.000Z')

describe('meetings', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: 'ICP', definition: ICP, active: true })
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', lastName: 'Sharma', email: 'priya@rentman.io' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const book = (over: Record<string, unknown> = {}) =>
    createMeeting(db, {
      orgId, companyId, contactId, startsAt: SOON, timeZone: 'Europe/London', source: 'manual', actor: 'test',
      ...over,
    })

  it('records a meeting and moves the deal to meeting', async () => {
    const r = await book()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.deal).toBe('created:meeting')
    expect(r.meeting.dealId).not.toBeNull()
    expect((await openDealFor(db, orgId, companyId))!.stage).toBe('meeting')
  })

  it('does not move a deal that is already further along', async () => {
    const [deal] = await db.insert(schema.deals).values({ orgId, companyId, stage: 'proposal' }).returning()
    const r = await book()
    if (!r.ok) throw new Error(r.message)
    expect(r.deal).toBe('unchanged:proposal')
    expect(r.meeting.dealId).toBe(deal!.id)
  })

  it.each([
    ['a timezone it does not know', { timeZone: 'Mars/Olympus' }, /timezone/],
    ['an end before the start', { endsAt: new Date(SOON.getTime() - 60_000) }, /end after it starts/],
    ['a company that is not there', { companyId: '00000000-0000-4000-8000-00000000dead' }, /not in the CRM/],
    ['a contact that is not there', { contactId: '00000000-0000-4000-8000-00000000dead' }, /not in the CRM/],
  ])('refuses %s', async (_label, over, matches) => {
    const r = await book(over)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(matches)
    expect(await meetingsForCompany(db, orgId, companyId)).toEqual([])
  })

  it('refuses a contact at a different company', async () => {
    const [other] = await db.insert(schema.companies).values({ orgId, domain: 'other.io' }).returning({ id: schema.companies.id })
    const [stranger] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: other!.id, email: 'x@other.io' })
      .returning({ id: schema.contacts.id })
    const r = await book({ contactId: stranger!.id })
    expect(r).toMatchObject({ ok: false })
    if (r.ok) return
    expect(r.message).toMatch(/different company/)
  })

  it('lists upcoming meetings soonest first, and not cancelled ones', async () => {
    const later = await book({ startsAt: new Date('2026-09-20T09:00:00.000Z') })
    await book({ startsAt: SOON })
    const cancelled = await book({ startsAt: new Date('2026-09-16T09:00:00.000Z') })
    if (!later.ok || !cancelled.ok) throw new Error('setup')
    expect(await cancelMeeting(db, orgId, cancelled.meeting.id, 'test')).toBe(true)
    const up = await upcomingMeetings(db, orgId, NOW)
    expect(up.map((m) => m.startsAt.toISOString())).toEqual([SOON.toISOString(), '2026-09-20T09:00:00.000Z'])
    expect(up[0]!.companyDomain).toBe('rentman.io')
  })

  it('cannot cancel twice, or another org’s', async () => {
    const r = await book()
    if (!r.ok) throw new Error(r.message)
    expect(await cancelMeeting(db, orgId, r.meeting.id, 'test')).toBe(true)
    expect(await cancelMeeting(db, orgId, r.meeting.id, 'test')).toBe(false)
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    const again = await book()
    if (!again.ok) throw new Error(again.message)
    expect(await cancelMeeting(db, other!.id, again.meeting.id, 'test')).toBe(false)
  })

  /** 0012's own constraints, at the database. */
  it('refuses a meeting whose end is not after its start, at the database', async () => {
    const msg = await expectRejection(() =>
      test.driver.select(
        `INSERT INTO meetings (org_id, company_id, starts_at, ends_at, time_zone)
         VALUES ($1, $2, '2026-09-18T14:00:00Z', '2026-09-18T13:00:00Z', 'Europe/London')`,
        [orgId, companyId],
      ),
    )
    expect(msg).toContain('meetings_end_after_start')
  })

  describe('the brief', () => {
    const scan = async (ranAt: Date, ok = true) => {
      const [s] = await db.insert(schema.scans).values({ orgId, companyId, ranAt, ok, error: ok ? null : 'timeout' }).returning()
      if (ok) {
        await db.insert(schema.findings).values([
          { orgId, scanId: s!.id, companyId, signalKey: 'csp', observed: true, gap: true, weight: 15, detail: 'absent', evidence: { seen: 'absent' } },
          { orgId, scanId: s!.id, companyId, signalKey: 'tls', observed: true, gap: false, weight: 8, evidence: { seen: 'ok' } },
          { orgId, scanId: s!.id, companyId, signalKey: 'trust_page', observed: false, gap: null, weight: 0, evidence: {} },
        ])
      }
      return s!
    }

    it('quotes a fresh scan’s gaps and flags nothing', async () => {
      await scan(new Date('2026-09-12T08:00:00.000Z'))
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const out = await briefForMeeting(db, orgId, r.meeting.id, NOW)
      expect(out).not.toBeNull()
      expect(out!.brief.posture.gaps.map((g) => g.signalKey)).toEqual(['csp'])
      expect(out!.brief.posture.gaps[0]!.why).toMatch(/Content-Security-Policy/)
      expect(out!.brief.posture.caveat).toBeNull()
      expect(out!.brief.who).toEqual(['Priya Sharma <priya@rentman.io>'])
    })

    /**
     * Freshness from the scan's `ran_at`, never from `findings.stale`. A scan
     * from three weeks ago with `stale = false` on every row is still stale.
     */
    it('flags a scan that has aged out even though findings.stale says otherwise', async () => {
      await scan(new Date('2026-08-01T08:00:00.000Z'))
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const out = await briefForMeeting(db, orgId, r.meeting.id, NOW)
      expect(out!.brief.posture.gaps).toEqual([])
      expect(out!.brief.posture.caveat).toMatch(/aged out/)
    })

    it('flags a company that was never scanned', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const out = await briefForMeeting(db, orgId, r.meeting.id, NOW)
      expect(out!.brief.posture.caveat).toMatch(/never been scanned/)
    })

    it('is null for another org’s meeting', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await briefForMeeting(db, other!.id, r.meeting.id, NOW)).toBeNull()
    })

    it('includes the thread', async () => {
      await db.insert(schema.touches).values({
        orgId, companyId, contactId, channel: 'email', direction: 'in', status: 'replied',
        subject: 'Re: hi', body: 'Thursday works.', sentAt: new Date('2026-09-14T10:00:00.000Z'),
      })
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const out = await briefForMeeting(db, orgId, r.meeting.id, NOW)
      expect(out!.brief.conversation[0]).toContain('They wrote: Re: hi')
    })
  })

  /**
   * What happened at a meeting (0018). One UPDATE decides each write; these
   * pin what it refuses, that the refusal is named, and what it leaves
   * alone — the deal above all.
   */
  describe('outcomes', () => {
    /** An hour after SOON starts: the meeting has happened. */
    const AFTER = new Date('2026-09-18T15:00:00.000Z')

    const audits = (action: string) =>
      db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))

    it('records held on a meeting that has started', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const out = await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'held', actor: 'test', now: AFTER })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.meeting.outcome).toBe('held')
      // set_updated_at() stamps the row; the ICS file's LAST-MODIFIED reads it.
      expect(out.meeting.updatedAt).not.toBeNull()
      const rows = await audits('meeting.outcome_recorded')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.subjectId).toBe(r.meeting.id)
      expect(rows[0]!.detail).toEqual({ outcome: 'held', companyId })
    })

    it('refuses an outcome for a meeting that has not started, and names why', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const out = await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'held', actor: 'test', now: NOW })
      expect(out).toMatchObject({ ok: false, reason: 'not_yet' })
      if (out.ok) return
      expect(out.message).toMatch(/has not started/)
      expect((await readMeeting(db, orgId, r.meeting.id))!.outcome).toBeNull()
      expect(await audits('meeting.outcome_recorded')).toEqual([])
    })

    it('counts the start instant itself as started', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const out = await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'held', actor: 'test', now: SOON })
      expect(out.ok).toBe(true)
    })

    it('refuses an outcome for a cancelled meeting', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      expect(await cancelMeeting(db, orgId, r.meeting.id, 'test')).toBe(true)
      const out = await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'no_show', actor: 'test', now: AFTER })
      expect(out).toMatchObject({ ok: false, reason: 'cancelled' })
      expect((await readMeeting(db, orgId, r.meeting.id))!.outcome).toBeNull()
    })

    it('is not_found for another org’s meeting, and writes nothing to it', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const out = await setMeetingOutcome(db, { orgId: other!.id, id: r.meeting.id, outcome: 'held', actor: 'test', now: AFTER })
      expect(out).toMatchObject({ ok: false, reason: 'not_found' })
      expect((await readMeeting(db, orgId, r.meeting.id))!.outcome).toBeNull()
    })

    it('refuses an outcome the schema does not know, at the database', async () => {
      const msg = await expectRejection(() =>
        test.driver.select(
          `INSERT INTO meetings (org_id, company_id, starts_at, time_zone, outcome)
           VALUES ($1, $2, '2026-09-18T14:00:00Z', 'Europe/London', 'maybe')`,
          [orgId, companyId],
        ),
      )
      expect(msg).toContain('meetings_outcome_known')
    })

    /**
     * A person may correct what they recorded: "held" clicked for a meeting
     * nobody turned up to is fixed by recording "no-show". Each write leaves
     * its own audit row, so the correction is visible, not silent.
     */
    it('lets a second outcome overwrite the first, and audits both', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'held', actor: 'test', now: AFTER })
      const out = await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'no_show', actor: 'test', now: AFTER })
      expect(out.ok).toBe(true)
      expect((await readMeeting(db, orgId, r.meeting.id))!.outcome).toBe('no_show')
      expect((await audits('meeting.outcome_recorded')).map((a) => (a.detail as { outcome: string }).outcome).sort())
        .toEqual(['held', 'no_show'])
    })

    it('does not move the deal on a no-show', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const before = await openDealFor(db, orgId, companyId)
      await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'no_show', actor: 'test', now: AFTER })
      const after = await openDealFor(db, orgId, companyId)
      expect(after).toEqual(before)
      expect(after!.stage).toBe('meeting')
    })

    it('will not cancel a meeting whose outcome is recorded', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'held', actor: 'test', now: AFTER })
      expect(await cancelMeeting(db, orgId, r.meeting.id, 'test')).toBe(false)
      expect((await readMeeting(db, orgId, r.meeting.id))!.cancelledAt).toBeNull()
    })

    describe('rescheduling', () => {
      const LATER = new Date('2026-09-25T09:00:00.000Z')

      it('marks the old meeting rescheduled and records the new one, linked both ways', async () => {
        const r = await book({ title: 'Intro', endsAt: new Date(SOON.getTime() + 45 * 60_000), notes: 'wants SOC 2 help' })
        if (!r.ok) throw new Error(r.message)
        const out = await rescheduleMeeting(db, {
          orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Asia/Kolkata', actor: 'test', now: AFTER,
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.meeting.outcome).toBe('rescheduled')
        const next = out.replacement
        expect(next.id).not.toBe(r.meeting.id)
        expect(next).toMatchObject({
          companyId, contactId, title: 'Intro', timeZone: 'Asia/Kolkata', source: 'manual',
          notes: 'wants SOC 2 help', outcome: null, cancelledAt: null, dealId: r.meeting.dealId,
        })
        expect(next.startsAt.toISOString()).toBe(LATER.toISOString())
        // The length is kept: 45 minutes then, 45 minutes now.
        expect(next.endsAt!.getTime() - next.startsAt.getTime()).toBe(45 * 60_000)

        const outcome = (await audits('meeting.outcome_recorded'))[0]!
        expect(outcome.subjectId).toBe(r.meeting.id)
        expect(outcome.detail).toMatchObject({ outcome: 'rescheduled', companyId, rescheduledTo: next.id })
        const booked = (await audits('meeting.booked')).find((a) => a.subjectId === next.id)!
        expect(booked.detail).toMatchObject({ rescheduledFrom: r.meeting.id })

        const fromOld = await meetingRescheduleLinks(db, orgId, r.meeting.id)
        expect(fromOld.to?.id).toBe(next.id)
        expect(fromOld.to?.timeZone).toBe('Asia/Kolkata')
        expect(fromOld.from).toBeNull()
        const fromNew = await meetingRescheduleLinks(db, orgId, next.id)
        expect(fromNew.from?.id).toBe(r.meeting.id)
        expect(fromNew.to).toBeNull()
        // Another org sees no link at all.
        const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
        expect(await meetingRescheduleLinks(db, other!.id, r.meeting.id)).toEqual({ to: null, from: null })
      })

      it('keeps a null end null, rather than inventing a length', async () => {
        const r = await book()
        if (!r.ok) throw new Error(r.message)
        const out = await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Europe/London', actor: 'test', now: AFTER })
        if (!out.ok) throw new Error(out.message)
        expect(out.replacement.endsAt).toBeNull()
      })

      it('refuses a second reschedule of the same meeting, and records no second meeting', async () => {
        const r = await book()
        if (!r.ok) throw new Error(r.message)
        const first = await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Europe/London', actor: 'test', now: AFTER })
        expect(first.ok).toBe(true)
        const again = await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Europe/London', actor: 'test', now: AFTER })
        expect(again).toMatchObject({ ok: false, reason: 'already_rescheduled' })
        expect(await meetingsForCompany(db, orgId, companyId)).toHaveLength(2)
      })

      it.each([
        ['a meeting that has not started', 'not_yet', NOW],
        ['a cancelled meeting', 'cancelled', AFTER],
      ] as const)('refuses %s and records nothing', async (_label, reason, now) => {
        const r = await book()
        if (!r.ok) throw new Error(r.message)
        if (reason === 'cancelled') await cancelMeeting(db, orgId, r.meeting.id, 'test')
        const out = await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Europe/London', actor: 'test', now })
        expect(out).toMatchObject({ ok: false, reason })
        expect(await meetingsForCompany(db, orgId, companyId)).toHaveLength(1)
      })

      it('refuses a zone it does not know before writing anything', async () => {
        const r = await book()
        if (!r.ok) throw new Error(r.message)
        const out = await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Mars/Olympus', actor: 'test', now: AFTER })
        expect(out).toMatchObject({ ok: false, reason: 'invalid' })
        expect((await readMeeting(db, orgId, r.meeting.id))!.outcome).toBeNull()
      })

      /**
       * The two writes are one transaction. A new meeting `createMeeting`
       * refuses (here: the contact has since moved company) must leave the
       * old meeting exactly as it was — not marked rescheduled to nowhere.
       */
      it('rolls the outcome back when the new meeting is refused', async () => {
        const r = await book()
        if (!r.ok) throw new Error(r.message)
        const [elsewhere] = await db.insert(schema.companies).values({ orgId, domain: 'elsewhere.io' }).returning({ id: schema.companies.id })
        await db.update(schema.contacts).set({ companyId: elsewhere!.id }).where(eq(schema.contacts.id, contactId))
        const out = await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Europe/London', actor: 'test', now: AFTER })
        expect(out).toMatchObject({ ok: false, reason: 'invalid' })
        if (out.ok) return
        expect(out.message).toMatch(/different company/)
        expect((await readMeeting(db, orgId, r.meeting.id))!.outcome).toBeNull()
        expect(await meetingsForCompany(db, orgId, companyId)).toHaveLength(1)
        expect(await audits('meeting.outcome_recorded')).toEqual([])
      })

      it('moves no deal when the original did not', async () => {
        const r = await book({ moveDeal: false })
        if (!r.ok) throw new Error(r.message)
        expect(r.meeting.dealId).toBeNull()
        const out = await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Europe/London', actor: 'test', now: AFTER })
        if (!out.ok) throw new Error(out.message)
        expect(out.replacement.dealId).toBeNull()
        expect(await openDealFor(db, orgId, companyId)).toBeNull()
      })

      it('lets a mis-clicked reschedule be corrected to held', async () => {
        const r = await book()
        if (!r.ok) throw new Error(r.message)
        await rescheduleMeeting(db, { orgId, id: r.meeting.id, startsAt: LATER, timeZone: 'Europe/London', actor: 'test', now: AFTER })
        const out = await setMeetingOutcome(db, { orgId, id: r.meeting.id, outcome: 'held', actor: 'test', now: AFTER })
        expect(out.ok).toBe(true)
        expect((await readMeeting(db, orgId, r.meeting.id))!.outcome).toBe('held')
      })
    })
  })

  describe('readMeetingWithCompany', () => {
    it('returns the meeting and its company, and nothing for another org', async () => {
      const r = await book()
      if (!r.ok) throw new Error(r.message)
      const found = await readMeetingWithCompany(db, orgId, r.meeting.id)
      expect(found?.meeting.id).toBe(r.meeting.id)
      expect(found?.company).toEqual({ domain: 'rentman.io', name: 'Rentman' })
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await readMeetingWithCompany(db, other!.id, r.meeting.id)).toBeNull()
    })
  })

  it('keeps meetings.contact_id when the contact is deleted', async () => {
    const r = await book()
    if (!r.ok) throw new Error(r.message)
    await db.delete(schema.contacts).where(eq(schema.contacts.id, contactId))
    const rows = await meetingsForCompany(db, orgId, companyId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.contactId).toBeNull()
  })
})
