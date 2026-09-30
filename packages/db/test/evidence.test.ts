/**
 * §2.2, applied to history: a score belongs to the scan it was computed from,
 * and a blocked fetch is not evidence of anything.
 *
 * The times in these tests are set ADVERSARIALLY on purpose. A reader that
 * paired scores with scans by time would pass every test where the two clocks
 * agree, so here they disagree: the older scan's score is stamped as the
 * newest score. Only a join on `scores.scan_id` gets the answer right.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile } from '@agency/core'
import { migratedDb, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import { SEED_DIR } from '../src/paths.js'
import { recordScan, type AgencyDb } from '../src/repository.js'
import { findingsForScan, latestEvidenceChanges, latestTwoOkScans, scanHistory } from '../src/evidence.js'

const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
)

const DAY = 86_400_000
const now = Date.now()
const daysAgo = (n: number): Date => new Date(now - n * DAY)

function reached(over: { gaps?: string[]; unobserved?: string[] } = {}): SiteProfile {
  const { gaps = [], unobserved = [] } = over
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: false, detail: 'present', evidence: { header: key, seen: 'present' } }
  }
  for (const key of gaps) observations[key] = { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
  for (const key of unobserved) observations[key] = { observed: false, gap: null, detail: 'timeout', evidence: { outcome: 'no response' } }
  return {
    domain: 'acme.test', company: 'Acme', title: 'Acme',
    fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false,
    outdatedLibs: [], observations,
  }
}

const unreachable: SiteProfile = {
  domain: 'acme.test', company: '', title: '', fetchOk: false, fetchError: 'TimeoutError',
  hasLoginSurface: false, isSecurityVendor: false, mentionsSecurityHiring: false,
  outdatedLibs: [], observations: {},
}

describe('evidence queries', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string
  let icpProfile: { id: string; definition: IcpDefinition }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    const [other] = await db.insert(schema.orgs).values({ name: 'Other agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    otherOrgId = other!.id
    const [p] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown> })
      .returning({ id: schema.icpProfiles.id })
    icpProfile = { id: p!.id, definition: icp }
    const [c] = await db
      .insert(schema.companies).values({ orgId, domain: 'acme.test', name: 'Acme' })
      .returning({ id: schema.companies.id })
    companyId = c!.id
  })
  afterEach(async () => { await test.close() })

  /** Record a scan through the real writer, then pin when it ran. */
  async function scanAt(ranAt: Date, profile: SiteProfile) {
    const out = await recordScan(db, { orgId, companyId, icpProfile, raw: { marker: 'raw capture' }, profile })
    await db.update(schema.scans).set({ ranAt }).where(eq(schema.scans.id, out.scanId))
    return out
  }

  describe('scanHistory', () => {
    it('pairs each score with ITS scan, even when the score clocks say otherwise', async () => {
      const older = await scanAt(daysAgo(10), reached({ gaps: ['csp', 'hsts', 'trust_page'] }))
      const newer = await scanAt(daysAgo(2), reached({ gaps: ['hsts'] }))
      expect(older.result.score).not.toBe(newer.result.score)

      // The adversarial part: the OLDER scan's score now looks like the newest
      // score, and the newer scan's looks ancient.
      await db.update(schema.scores).set({ computedAt: daysAgo(0) }).where(eq(schema.scores.id, older.scoreId))
      await db.update(schema.scores).set({ computedAt: daysAgo(30) }).where(eq(schema.scores.id, newer.scoreId))

      const history = await scanHistory(db, orgId, companyId)
      expect(history.map((h) => h.scan.id)).toEqual([newer.scanId, older.scanId])
      expect(history[0]!.score!.score).toBe(newer.result.score)
      expect(history[1]!.score!.score).toBe(older.result.score)
      expect(history[1]!.score!.icpProfileId).toBe(icpProfile.id)
      expect(history[0]!.scan.ok).toBe(true)
    })

    // recordScan DOES write a score row for an unreachable scan — 0,
    // disqualified as unreachable. The history must still not report it.
    it('reports a scan that never reached the site as ok:false with no score, never as 0', async () => {
      await scanAt(daysAgo(5), reached({ gaps: ['csp'] }))
      const down = await scanAt(daysAgo(1), unreachable)

      const [stored] = await db.select().from(schema.scores).where(eq(schema.scores.scanId, down.scanId))
      expect(stored!.score, 'the premise: the writer stores a 0 for it').toBe(0)

      const history = await scanHistory(db, orgId, companyId)
      expect(history).toHaveLength(2)
      expect(history[0]!.scan).toEqual({ id: down.scanId, ranAt: daysAgo(1), ok: false, error: 'TimeoutError' })
      expect(history[0]!.score).toBeNull()
      expect(history[1]!.score!.score).toBeGreaterThan(0)
    })

    it('reports an unreachable scan with no score row at all the same way', async () => {
      const [scan] = await db
        .insert(schema.scans).values({ orgId, companyId, ok: false, error: 'ECONNREFUSED', ranAt: daysAgo(1) })
        .returning({ id: schema.scans.id })
      const history = await scanHistory(db, orgId, companyId)
      expect(history).toEqual([{ scan: { id: scan!.id, ranAt: daysAgo(1), ok: false, error: 'ECONNREFUSED' }, score: null }])
    })

    it('returns one row per scan, with the newest score, when a scan was scored twice', async () => {
      const first = await scanAt(daysAgo(3), reached({ gaps: ['csp'] }))
      // Both stamps pinned: the writer's `now()` is later than this file's `now`.
      await db.update(schema.scores).set({ computedAt: daysAgo(3) }).where(eq(schema.scores.id, first.scoreId))
      await db.insert(schema.scores).values({
        orgId, companyId, scanId: first.scanId, icpProfileId: icpProfile.id,
        score: 91, tier: 'A', qualified: true, computedAt: daysAgo(2),
      })
      const second = await scanAt(daysAgo(1), reached({ gaps: ['hsts'] }))

      // A plain join would return THREE rows here — the first scan twice.
      const history = await scanHistory(db, orgId, companyId)
      expect(history.map((h) => h.scan.id)).toEqual([second.scanId, first.scanId])
      expect(history[1]!.score!.score).toBe(91)
    })

    it('never selects the raw capture', async () => {
      await scanAt(daysAgo(1), reached())
      const [row] = await scanHistory(db, orgId, companyId)
      expect(Object.keys(row!).sort()).toEqual(['scan', 'score'])
      expect(Object.keys(row!.scan).sort()).toEqual(['error', 'id', 'ok', 'ranAt'])
      expect(JSON.stringify(row)).not.toContain('raw capture')
    })

    it('honours the limit, and clamps one that is nonsense', async () => {
      for (let d = 1; d <= 4; d++) await scanAt(daysAgo(d), reached())
      expect(await scanHistory(db, orgId, companyId, 2)).toHaveLength(2)
      expect(await scanHistory(db, orgId, companyId, 0)).toHaveLength(1)
      expect(await scanHistory(db, orgId, companyId, -5)).toHaveLength(1)
      expect(await scanHistory(db, orgId, companyId, Number.NaN)).toHaveLength(4)
      expect(await scanHistory(db, orgId, companyId, 1e9)).toHaveLength(4)
    })

    it('shows another org nothing', async () => {
      await scanAt(daysAgo(1), reached({ gaps: ['csp'] }))
      expect(await scanHistory(db, otherOrgId, companyId)).toEqual([])
    })
  })

  describe('findingsForScan', () => {
    it('returns the scan\'s findings, heaviest first, and nothing to another org', async () => {
      const out = await scanAt(daysAgo(1), reached({ gaps: ['csp', 'hsts'] }))
      const rows = await findingsForScan(db, orgId, out.scanId)
      expect(rows.length).toBe(out.findingsWritten)
      expect(rows.every((f) => f.scanId === out.scanId)).toBe(true)
      const weights = rows.map((f) => f.weight)
      expect(weights).toEqual([...weights].sort((a, b) => b - a))
      expect(rows.slice(0, 2).map((f) => f.signalKey).sort()).toEqual(['csp', 'hsts'])

      expect(await findingsForScan(db, otherOrgId, out.scanId)).toEqual([])
    })
  })

  describe('latestTwoOkScans', () => {
    it('skips a failed scan in between and compares the two that reached the site', async () => {
      const a = await scanAt(daysAgo(10), reached({ gaps: ['csp', 'hsts'] }))
      await scanAt(daysAgo(5), unreachable)
      const c = await scanAt(daysAgo(1), reached({ gaps: ['hsts'] }))

      const pair = await latestTwoOkScans(db, orgId, companyId)
      expect(pair).not.toBeNull()
      expect(pair!.newer.scan.id).toBe(c.scanId)
      expect(pair!.older.scan.id).toBe(a.scanId)
      expect(pair!.newer.findings.every((f) => f.scanId === c.scanId)).toBe(true)
      expect(pair!.older.findings.every((f) => f.scanId === a.scanId)).toBe(true)
      expect(pair!.newer.findings.length).toBe(c.findingsWritten)
      expect('raw' in pair!.newer.scan).toBe(false)
      expect(JSON.stringify(pair!.newer.scan)).not.toContain('raw capture')
    })

    it('is null with fewer than two successful scans, however many failed', async () => {
      expect(await latestTwoOkScans(db, orgId, companyId)).toBeNull()
      await scanAt(daysAgo(3), reached())
      await scanAt(daysAgo(2), unreachable)
      await scanAt(daysAgo(1), unreachable)
      expect(await latestTwoOkScans(db, orgId, companyId)).toBeNull()
    })

    it('shows another org nothing', async () => {
      await scanAt(daysAgo(2), reached())
      await scanAt(daysAgo(1), reached())
      expect(await latestTwoOkScans(db, orgId, companyId)).not.toBeNull()
      expect(await latestTwoOkScans(db, otherOrgId, companyId)).toBeNull()
    })
  })

  describe('latestEvidenceChanges', () => {
    // The §2.2 scenario end to end, through the real writer: a gap the newer
    // scan could not observe is "not assessed", a gap it saw closed is fixed.
    it('never reports a signal the newer scan could not observe as fixed', async () => {
      const a = await scanAt(daysAgo(10), reached({ gaps: ['csp', 'hsts'] }))
      const b = await scanAt(daysAgo(1), reached({ unobserved: ['csp'] }))

      const changes = await latestEvidenceChanges(db, orgId, companyId)
      expect(changes!.newer.id).toBe(b.scanId)
      expect(changes!.older.id).toBe(a.scanId)
      const by = new Map(changes!.diff.rows.map((r) => [r.signalKey, r]))
      expect(by.get('csp')!.change).toBe('not_assessed_this_time')
      expect(by.get('hsts')!.change).toBe('fixed')
      expect(by.get('hsts')!.older!.evidence).toEqual({ header: 'hsts', seen: 'absent' })
      expect(by.get('hsts')!.newer.evidence).toEqual({ header: 'hsts', seen: 'present' })
      expect(changes!.diff.summary.fixed).toBe(1)
      expect(changes!.diff.summary.notAssessed).toBe(1)
    })

    it('is null with nothing to compare, and for another org', async () => {
      await scanAt(daysAgo(1), reached())
      expect(await latestEvidenceChanges(db, orgId, companyId)).toBeNull()
      await scanAt(daysAgo(0), reached())
      expect(await latestEvidenceChanges(db, otherOrgId, companyId)).toBeNull()
    })
  })
})
