/**
 * The moment a stored message's words were written, as the sender asks it
 * (§2.2) — at the stored microsecond, not at a JavaScript millisecond.
 *
 * `sendFactsFor` judged the words by the latest successful scan with
 * `ran_at <= writtenAt`, where `writtenAt` was `touches.created_at` read back
 * as a `Date`. A `Date` holds milliseconds and `timestamptz` microseconds, so
 * the comparison ran against the start of the draft's millisecond: a scan
 * stamped 300 µs before the words, inside the same millisecond, was not seen.
 * The sender then read "no scan behind these words, so nothing to be stale"
 * while `/compliance`, which compares in SQL against the stored value, read
 * the same row as written from that scan and refused at sending. Two answers
 * to one question, and the sender's was the one that sends.
 *
 * Every case below builds that exact shape — the touch's `created_at` and the
 * scan's `ran_at` set in SQL, 300 µs apart in one millisecond — and asserts
 * that every reader of a stored message's evidence moment agrees with the
 * compliance count: the sender, its dry run, the deny path and the LinkedIn
 * step's re-check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import {
  complianceDraftsOnStaleEvidence, denyDraft, dispatchTouch, evidenceAsOfFor, linkedinStepsDue, previewSend, schema,
  type AgencyDb, type MessageProvider,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const DAY = 86_400_000
/** Nineteen days ago: past the default fourteen-day window (no ICP row here). */
const WRITTEN = new Date(NOW.getTime() - 19 * DAY)
const STALE_DAYS = 14
const PROFILE = 'https://www.linkedin.com/in/jane-doe/'

/** Counts, never sends. */
function countingProvider(channels: MessageProvider['channels']): MessageProvider & { sent: string[] } {
  const sent: string[] = []
  return {
    name: 'test',
    channels,
    sent,
    async send(m) {
      sent.push(m.to)
      return { providerId: `test-${sent.length}` }
    },
  }
}

describe('a stored message’s evidence moment is its stored created_at, to the microsecond', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let emailCampaign: string
  let linkedinCampaign: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id }))[0]!.id
    userId = (
      await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    )[0]!.id
    companyId = (
      await db.insert(schema.companies).values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' }).returning({ id: schema.companies.id })
    )[0]!.id
    contactId = (
      await db
        .insert(schema.contacts)
        .values({ orgId, companyId, email: 'jane@rentman.io', linkedinUrl: PROFILE, firstName: 'Jane', timeZone: 'Europe/London' })
        .returning({ id: schema.contacts.id })
    )[0]!.id
    emailCampaign = (
      await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Opener', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id })
    )[0]!.id
    linkedinCampaign = (
      await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: false, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id })
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /**
   * A message whose stored `created_at` is WRITTEN + 456 µs, and a successful
   * scan of its company at `created_at` + `scanOffsetMicros` — both set in SQL,
   * so neither ever passes through a millisecond `Date` on the way in.
   */
  const wordsAndScan = async (
    over: Partial<typeof schema.touches.$inferInsert>,
    scanOffsetMicros: number,
  ) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, companyId, contactId, campaignId: emailCampaign, channel: 'email', direction: 'out',
        status: 'approved', approvedBy: userId, approvedAt: WRITTEN, subject: 'Your CSP', body: 'words',
        createdAt: WRITTEN, ...over,
      })
      .returning({ id: schema.touches.id })
    const id = row!.id
    await db.execute(sql`UPDATE touches SET created_at = created_at + interval '456 microseconds' WHERE id = ${id}::uuid`)
    await db.execute(sql`
      INSERT INTO scans (org_id, company_id, ran_at, ok)
      SELECT org_id, company_id, created_at + make_interval(secs => ${scanOffsetMicros}::double precision / 1000000), true
        FROM touches WHERE id = ${id}::uuid`)
    const touch = (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
    const scan = (await db.select().from(schema.scans).where(eq(schema.scans.companyId, companyId)))[0]!
    return { touch, scan }
  }

  it('the premise: the scan and the words share one millisecond, and the scan came first', async () => {
    const { touch, scan } = await wordsAndScan({}, -300)
    // Read back as Dates they are the same instant…
    expect(scan.ranAt.getTime()).toBe(touch.createdAt.getTime())
    // …and in the database the scan is 300 µs earlier.
    const res: unknown = await db.execute(sql`
      SELECT (s.ran_at < t.created_at) AS before, extract(microseconds FROM t.created_at - s.ran_at)::int AS gap
        FROM scans s, touches t WHERE s.id = ${scan.id}::uuid AND t.id = ${touch.id}::uuid`)
    const rows = (res as { rows: { before: boolean; gap: number }[] }).rows
    expect(rows[0]).toEqual({ before: true, gap: 300 })
  })

  it('the sender refuses what the compliance count says it refuses, and calls no provider', async () => {
    const { touch, scan } = await wordsAndScan({}, -300)

    const counted = await complianceDraftsOnStaleEvidence(db, orgId, STALE_DAYS, NOW)
    expect(counted.rows.map((r) => [r.touchId, r.refusedAtSending])).toEqual([[touch.id, true]])
    expect(counted.rows[0]!.writtenFromScanAt?.getTime()).toBe(scan.ranAt.getTime())

    const preview = await previewSend(db, {
      orgId, contactId, campaignId: emailCampaign, now: NOW, writtenAt: evidenceAsOfFor(touch),
    })
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.facts.evidenceStale).toBe(true)
    expect(preview.decision).toMatchObject({ allowed: false, code: 'stale_evidence' })

    const provider = countingProvider(['email'])
    const sent = await dispatchTouch(db, provider, touch, { now: NOW })
    expect(sent.decision).toMatchObject({ allowed: false, code: 'stale_evidence' })
    expect(provider.sent).toEqual([])
    const after = (await db.select().from(schema.touches).where(eq(schema.touches.id, touch.id)))[0]!
    expect(after.refusalCode).toBe('stale_evidence')
  })

  it('a scan 300 µs AFTER the words, in the same millisecond, is not what they quote', async () => {
    const { touch } = await wordsAndScan({}, 300)
    const counted = await complianceDraftsOnStaleEvidence(db, orgId, STALE_DAYS, NOW)
    expect(counted.rows.map((r) => [r.touchId, r.refusedAtSending])).toEqual([[touch.id, false]])
    const preview = await previewSend(db, {
      orgId, contactId, campaignId: emailCampaign, now: NOW, writtenAt: evidenceAsOfFor(touch),
    })
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.facts.evidenceStale).toBe(false)
  })

  it('denying the draft records stale_evidence, which a re-scan resolves, not a person’s no', async () => {
    const { touch } = await wordsAndScan({ status: 'awaiting_approval', approvedBy: null, approvedAt: null }, -300)
    const denied = await denyDraft(db, { orgId, touchId: touch.id, decidedBy: userId, now: NOW })
    expect(denied.ok).toBe(true)
    const after = (await db.select().from(schema.touches).where(eq(schema.touches.id, touch.id)))[0]!
    expect(after.refusalCode).toBe('stale_evidence')
  })

  it('the LinkedIn step’s dry run reads the same scan', async () => {
    await wordsAndScan({ channel: 'linkedin', campaignId: linkedinCampaign, subject: '' }, -300)
    const [step] = await linkedinStepsDue(db, orgId, NOW)
    expect(step!.preview).toMatchObject({ ok: true, decision: { allowed: false, code: 'stale_evidence' } })
  })

  /** "Written now" is still now: a message nobody has stored has no row to read. */
  it('a hypothetical message is judged as written at the moment asked', async () => {
    await wordsAndScan({}, -300)
    const now = await previewSend(db, { orgId, contactId, campaignId: emailCampaign, now: NOW })
    if (!now.ok) throw new Error(now.message)
    expect(now.facts.evidenceStale).toBe(true)
  })
})
