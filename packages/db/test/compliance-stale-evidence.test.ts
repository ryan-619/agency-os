/**
 * /compliance's "messages waiting to go on stale or missing evidence", told
 * the way the send path will treat each one (§2.2).
 *
 * The round-1 review added `stale_evidence` to `decideSend`: a message whose
 * words were written from a successful scan that is past its deadline at the
 * moment of sending is refused, whoever approved it. The page, the tool and
 * this module's own doc kept saying approved, queued and sending rows "go
 * with nobody looking at the evidence again" — true of some of them, false of
 * most. And the count judged each company's LATEST scan only, so a message
 * written from a scan that has gone stale since the company was re-scanned —
 * which the sender refuses, and `/approvals` blocks — was not counted at all.
 *
 * Each listed row now says whether the send path refuses it for its evidence,
 * and that answer is checked here against the send path's own dry run, row by
 * row, rather than restated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  complianceDraftsOnStaleEvidence, complianceSummary, evidenceAsOfFor, previewSend, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
/** No ICP row, so the sender reads the default — the same 14 this count is handed. */
const STALE_DAYS = 14

describe('stale or missing evidence, split by what the send path does at sending', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let campaignId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    campaignId = (
      await db.insert(schema.campaigns).values({ orgId, name: 'Opener', channel: 'email', status: 'active' }).returning({ id: schema.campaigns.id })
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A company with one contact, and a successful scan at each age given. */
  const companyWith = async (domain: string, scannedDaysAgo: readonly number[]) => {
    const [c] = await db.insert(schema.companies).values({ orgId, domain, timeZone: 'Europe/London' }).returning({ id: schema.companies.id })
    const [p] = await db.insert(schema.contacts).values({ orgId, companyId: c!.id, email: `p@${domain}` }).returning({ id: schema.contacts.id })
    for (const d of scannedDaysAgo) await db.insert(schema.scans).values({ orgId, companyId: c!.id, ranAt: ago(d), ok: true })
    return { companyId: c!.id, contactId: p!.id }
  }
  /** An outbound email about that company, its words written `writtenDaysAgo`. */
  const draft = async (
    to: { companyId: string; contactId: string },
    writtenDaysAgo: number,
    status: 'awaiting_approval' | 'approved' | 'queued' | 'sending',
    answersTouchId: string | null = null,
  ) =>
    (
      await db.insert(schema.touches).values({
        orgId, companyId: to.companyId, contactId: to.contactId, campaignId, channel: 'email', direction: 'out', status,
        subject: 'Your CSP', body: 'words', createdAt: ago(writtenDaysAgo), answersTouchId,
        ...(status === 'approved' ? { approvedBy: userId, approvedAt: ago(writtenDaysAgo) } : {}),
      }).returning({ id: schema.touches.id, createdAt: schema.touches.createdAt, answersTouchId: schema.touches.answersTouchId })
    )[0]!

  it('lists a message written from a scan that has gone stale since, though the company was re-scanned', async () => {
    // Written 19 days ago from the scan 20 days ago; the company was re-scanned yesterday.
    const r = await companyWith('rescanned.test', [20, 1])
    const t = await draft(r, 19, 'approved')

    const out = await complianceDraftsOnStaleEvidence(db, orgId, STALE_DAYS, NOW)
    expect(out.rows.map((x) => [x.touchId, x.why, x.refusedAtSending])).toEqual([[t.id, 'rescanned_since', true]])
    expect(out.rows[0]!.writtenFromScanAt?.toISOString()).toBe(ago(20).toISOString())
    expect(out.rows[0]!.lastOkScanAt?.toISOString()).toBe(ago(1).toISOString())
    // The sender agrees: these words are refused, the new scan notwithstanding.
    const preview = await previewSend(db, { orgId, campaignId, contactId: r.contactId, writtenAt: evidenceAsOfFor(t), now: NOW })
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.facts.evidenceStale).toBe(true)
  })

  it('says which rows the send path refuses for their evidence, and agrees with its dry run row by row', async () => {
    // Refused at sending: written from the only scan, which is 20 days old.
    const stale = await companyWith('stale.test', [20])
    const refusedAwaiting = await draft(stale, 19, 'awaiting_approval')
    const refusedQueued = await draft(stale, 18, 'queued')
    // Not judged by evidence: written BEFORE the company's first successful scan.
    const early = await companyWith('early.test', [20])
    const writtenFirst = await draft(early, 25, 'queued')
    // Not judged by evidence: an answer to a reply quotes no scan.
    const reply = (
      await db.insert(schema.touches).values({
        orgId, companyId: stale.companyId, contactId: stale.contactId, channel: 'email', direction: 'in', status: 'replied', replyKind: 'interested',
      }).returning({ id: schema.touches.id })
    )[0]!
    const answer = await draft(stale, 1, 'awaiting_approval', reply.id)
    // Not judged by evidence: no successful scan at all.
    const never = await companyWith('never.test', [])
    const noScan = await draft(never, 1, 'sending')
    // On fresh evidence: measured, not listed.
    const fresh = await companyWith('fresh.test', [2])
    await draft(fresh, 1, 'queued')

    const out = await complianceDraftsOnStaleEvidence(db, orgId, STALE_DAYS, NOW)
    const byId = new Map(out.rows.map((x) => [x.touchId, [x.why, x.refusedAtSending]]))
    expect(byId.get(refusedAwaiting.id)).toEqual(['stale', true])
    expect(byId.get(refusedQueued.id)).toEqual(['stale', true])
    expect(byId.get(writtenFirst.id)).toEqual(['stale', false])
    expect(byId.get(answer.id)).toEqual(['stale', false])
    expect(byId.get(noScan.id)).toEqual(['no_evidence', false])
    expect(out.count).toBe(5)
    expect(out.unsent).toBe(6)
    expect(out.byWhy).toEqual({ stale: 4, no_evidence: 1, rescanned_since: 0 })
    expect(out.refusedAtSending).toBe(2)
    expect(out.notJudgedAtSending).toBe(3)
    // Of the three, the answer waits on a person; the queued and the sending one do not.
    expect(out.notJudgedNoFurtherLook).toBe(2)

    // Every row's answer is the sender's own: `previewSend` at the moment the words were written.
    const touches = [refusedAwaiting, refusedQueued, writtenFirst, answer, noScan]
    const contactOf = new Map([
      [refusedAwaiting.id, stale.contactId], [refusedQueued.id, stale.contactId], [writtenFirst.id, early.contactId],
      [answer.id, stale.contactId], [noScan.id, never.contactId],
    ])
    for (const t of touches) {
      const preview = await previewSend(db, { orgId, campaignId, contactId: contactOf.get(t.id)!, writtenAt: evidenceAsOfFor(t), now: NOW })
      if (!preview.ok) throw new Error(preview.message)
      expect(preview.facts.evidenceStale, t.id).toBe(out.rows.find((x) => x.touchId === t.id)!.refusedAtSending)
    }
  })

  it('the summary the page, the dashboard and the tool read carries the split', async () => {
    const r = await companyWith('rescanned.test', [20, 1])
    await draft(r, 19, 'queued')
    const never = await companyWith('never.test', [])
    await draft(never, 1, 'approved')
    const s = await complianceSummary(db, orgId, { staleDays: STALE_DAYS, now: NOW })
    expect(s.draftsOnStaleEvidence).toMatchObject({
      count: 2, refusedAtSending: 1, notJudgedAtSending: 1, notJudgedNoFurtherLook: 1,
      byWhy: { stale: 0, no_evidence: 1, rescanned_since: 1 },
    })
  })
})
