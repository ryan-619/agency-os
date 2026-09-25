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
  briefForMeeting, cancelMeeting, createMeeting, meetingsForCompany, openDealFor, schema,
  upcomingMeetings, type AgencyDb,
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

  it('keeps meetings.contact_id when the contact is deleted', async () => {
    const r = await book()
    if (!r.ok) throw new Error(r.message)
    await db.delete(schema.contacts).where(eq(schema.contacts.id, contactId))
    const rows = await meetingsForCompany(db, orgId, companyId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.contactId).toBeNull()
  })
})
