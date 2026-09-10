import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { scoreCompany, parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile } from '@agency/core'
import { freshDb, migrations, expectRejection, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'
import * as schema from '../src/schema.js'
import { SEED_DIR } from '../src/paths.js'
import {
  importCompanies, recordScan, latestScanWithFindings, latestScore, companyList,
  markStaleFindings, quotableFindings, findCompanyByDomain, type AgencyDb,
} from '../src/repository.js'

const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
)

function profileWith(over: { gaps?: string[]; unobserved?: string[] } & Partial<SiteProfile> = {}): SiteProfile {
  const { gaps = [], unobserved = [], ...rest } = over
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: false, detail: '', evidence: { header: key, seen: 'present' } }
  }
  for (const key of gaps) observations[key] = { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
  for (const key of unobserved) observations[key] = { observed: false, gap: null, detail: 'timeout', evidence: { outcome: 'no response' } }
  return {
    domain: 'acme.test', company: 'Acme', title: 'Acme',
    fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false,
    outdatedLibs: [], observations, ...rest,
  }
}

describe('the qualification data core', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let icpProfileId: string

  beforeAll(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [p] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown> })
      .returning({ id: schema.icpProfiles.id })
    icpProfileId = p!.id
  })
  afterAll(async () => { await test.close() })

  describe('importCompanies', () => {
    it('imports and reports what was new', async () => {
      const r = await importCompanies(db, orgId, [
        { domain: 'acme.test', name: 'Acme' },
        { domain: 'beta.test', name: 'Beta' },
      ])
      expect(r.inserted).toBe(2)
      expect(r.alreadyPresent).toBe(0)
    })

    // §8.2: "Deduplicate on domain at write time, not at read time." A
    // duplicate that reaches the database has already cost a scan and can
    // already have been emailed twice.
    it('de-duplicates within one import', async () => {
      const r = await importCompanies(db, orgId, [
        { domain: 'gamma.test' }, { domain: 'GAMMA.test' }, { domain: ' gamma.test ' },
      ])
      expect(r.inserted).toBe(1)
      const rows = await db.select().from(schema.companies).where(eq(schema.companies.domain, 'gamma.test'))
      expect(rows).toHaveLength(1)
    })

    it('de-duplicates against what is already stored', async () => {
      const r = await importCompanies(db, orgId, [{ domain: 'acme.test' }, { domain: 'delta.test' }])
      expect(r.inserted).toBe(1)
      expect(r.alreadyPresent).toBe(1)
    })

    it('ignores blank rows', async () => {
      expect((await importCompanies(db, orgId, [{ domain: '   ' }])).inserted).toBe(0)
    })
  })

  describe('recordScan', () => {
    it('writes the scan, every finding and the score in one go', async () => {
      const company = await findCompanyByDomain(db, orgId, 'acme.test')
      const profile = profileWith({ gaps: ['csp', 'trust_page', 'compliance_claim', 'security_txt'] })
      const result = scoreCompany(profile, icp)

      const out = await recordScan(db, {
        orgId, companyId: company!.id, icpProfileId,
        raw: { home: { ok: true } }, profile, result,
      })

      expect(out.findingsWritten).toBe(12)
      expect(out.observedCount).toBe(12)
      expect(out.unobservedCount).toBe(0)

      const score = await latestScore(db, orgId, company!.id)
      expect(score!.score).toBe(49)
      expect(score!.qualified).toBe(true)
    })

    it('gives a gap the weight the ICP says, not one of its own', async () => {
      const company = await findCompanyByDomain(db, orgId, 'acme.test')
      const found = await latestScanWithFindings(db, orgId, company!.id)
      const csp = found!.findings.find((f) => f.signalKey === 'csp')
      expect(csp!.weight).toBe(icp.signals.csp!.weight)
      // A signal that is not a gap carries no weight.
      const hsts = found!.findings.find((f) => f.signalKey === 'hsts')
      expect(hsts!.weight).toBe(0)
    })

    it('stores an unobserved signal as gap NULL, claiming nothing', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'timeout.test' })
        .returning({ id: schema.companies.id })
      const profile = profileWith({ gaps: ['csp'], unobserved: ['tls', 'trust_page'] })
      const result = scoreCompany(profile, icp)

      const out = await recordScan(db, {
        orgId, companyId: company!.id, icpProfileId, raw: {}, profile, result,
      })
      expect(out.unobservedCount).toBe(2)

      const found = await latestScanWithFindings(db, orgId, company!.id)
      const tls = found!.findings.find((f) => f.signalKey === 'tls')
      expect(tls!.observed).toBe(false)
      expect(tls!.gap).toBeNull()
      expect(tls!.weight).toBe(0)
    })

    // §2.2: nothing was reached, so nothing may be claimed.
    it('writes NO findings at all for a scan that never reached the site', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'unreachable.test' })
        .returning({ id: schema.companies.id })
      const profile: SiteProfile = {
        domain: 'unreachable.test', company: '', title: '', fetchOk: false,
        fetchError: 'TimeoutError', hasLoginSurface: false, isSecurityVendor: false,
        mentionsSecurityHiring: false, outdatedLibs: [], observations: {},
      }
      const result = scoreCompany(profile, icp)

      const out = await recordScan(db, {
        orgId, companyId: company!.id, icpProfileId, raw: {}, profile, result,
      })
      expect(out.findingsWritten).toBe(0)

      const found = await latestScanWithFindings(db, orgId, company!.id)
      expect(found!.scan.ok).toBe(false)
      expect(found!.scan.error).toBe('TimeoutError')
      expect(found!.findings).toEqual([])

      const score = await latestScore(db, orgId, company!.id)
      expect(score!.disqualifiedReason).toBe('unreachable (TimeoutError)')
      expect(score!.qualified).toBe(false)
    })

    it('keeps score history rather than overwriting it (§4)', async () => {
      const company = await findCompanyByDomain(db, orgId, 'acme.test')
      const profile = profileWith({ gaps: ['csp'] })
      await recordScan(db, { orgId, companyId: company!.id, icpProfileId, raw: {}, profile, result: scoreCompany(profile, icp) })

      const all = await db.select().from(schema.scores).where(eq(schema.scores.companyId, company!.id))
      expect(all.length).toBeGreaterThan(1)
      // The newest wins for display, but the earlier one is still there.
      expect((await latestScore(db, orgId, company!.id))!.score).toBe(14)
    })

    it('rolls the whole thing back if any part fails', async () => {
      const company = await findCompanyByDomain(db, orgId, 'beta.test')
      const before = await db.select().from(schema.scans).where(eq(schema.scans.companyId, company!.id))

      const profile = profileWith({ gaps: ['csp'] })
      const result = scoreCompany(profile, icp)
      // A findings row the schema will refuse: a claimed gap with no evidence.
      const broken: SiteProfile = {
        ...profile,
        observations: { ...profile.observations, csp: { observed: true, gap: true, detail: '', evidence: {} } },
      }
      await expect(
        recordScan(db, { orgId, companyId: company!.id, icpProfileId, raw: {}, profile: broken, result }),
      ).rejects.toThrow()

      const after = await db.select().from(schema.scans).where(eq(schema.scans.companyId, company!.id))
      expect(after.length).toBe(before.length)
    })
  })

  describe('companyList', () => {
    it('shows every company with its latest score and scan', async () => {
      const rows = await companyList(db, orgId)
      expect(rows.length).toBeGreaterThanOrEqual(4)
      const acme = rows.find((r) => r.domain === 'acme.test')!
      expect(acme.score).toBe(14) // the most recent, not the first
      expect(acme.lastScanOk).toBe(true)
      // Never scanned: honest nulls rather than a zero that reads as a result.
      const gamma = rows.find((r) => r.domain === 'gamma.test')!
      expect(gamma.score).toBeNull()
      expect(gamma.lastScanAt).toBeNull()
    })
  })

  describe('freshness (§2.2)', () => {
    it('marks nothing stale when every scan is recent', async () => {
      expect(await markStaleFindings(db, orgId, 14)).toBe(0)
    })

    it('marks findings stale once their SCAN is older than the threshold', async () => {
      const company = await findCompanyByDomain(db, orgId, 'acme.test')
      // Age is measured from the observation, not the row's insert time.
      await db.update(schema.scans)
        .set({ ranAt: new Date(Date.now() - 20 * 86_400_000) })
        .where(eq(schema.scans.companyId, company!.id))

      const marked = await markStaleFindings(db, orgId, 14)
      expect(marked).toBeGreaterThan(0)

      const stale = await db.select().from(schema.findings).where(eq(schema.findings.companyId, company!.id))
      expect(stale.every((f) => f.stale)).toBe(true)
    })

    it('excludes stale findings from what may be quoted in a draft', async () => {
      const company = await findCompanyByDomain(db, orgId, 'acme.test')
      expect(await quotableFindings(db, orgId, company!.id)).toEqual([])
    })

    it('only ever offers observed gaps for quoting', async () => {
      const company = await findCompanyByDomain(db, orgId, 'timeout.test')
      const quotable = await quotableFindings(db, orgId, company!.id)
      expect(quotable.length).toBeGreaterThan(0)
      expect(quotable.every((f) => f.observed && f.gap === true && !f.stale)).toBe(true)
    })

    it('refuses a nonsensical threshold rather than marking everything', async () => {
      await expect(markStaleFindings(db, orgId, 0)).rejects.toThrow(/positive number/)
      await expect(markStaleFindings(db, orgId, -14)).rejects.toThrow(/positive number/)
    })
  })
})
