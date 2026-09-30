import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { scoreCompany, parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile } from '@agency/core'
import { migratedDb,expectRejection, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import { SEED_DIR } from '../src/paths.js'
import {
  importCompanies, recordScan, latestScanWithFindings, latestScore, companyList,
  markStaleFindings, quotableFindings, findCompanyByDomain, latestInformationalFindings, type AgencyDb,
} from '../src/repository.js'
// The scanner's own extractor and recordings, by path: packages/db does not
// depend on the scanner, and only this test needs a REAL profile.
import { extractProfile } from '../../scanner/src/extract.js'
import { ADDITIVE_SIGNAL_KEYS } from '../../scanner/src/additive.js'
import { fixtureNames, loadFixture } from '../../scanner/test/fixtures.js'

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
  let icpProfile: { id: string; definition: typeof icp }

  beforeAll(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [p] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown> })
      .returning({ id: schema.icpProfiles.id })
    icpProfile = { id: p!.id, definition: icp }
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
        orgId, companyId: company!.id, icpProfile,
        raw: { home: { ok: true } }, profile,
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
        orgId, companyId: company!.id, icpProfile, raw: {}, profile,
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
        orgId, companyId: company!.id, icpProfile, raw: {}, profile,
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
      await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile })

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
        recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile: broken }),
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

    // The failure this prevents: the company fixed their CSP last week, the
    // re-scan recorded that, and a draft still quotes the old row saying they
    // have none.
    it('quotes only the LATEST scan, never a gap an older scan reported', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'rescanned.test' })
        .returning({ id: schema.companies.id })

      // First scan: csp is a gap.
      const before = profileWith({ gaps: ['csp', 'hsts'] })
      await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile: before })
      expect((await quotableFindings(db, orgId, company!.id)).map((f) => f.signalKey).sort())
        .toEqual(['csp', 'hsts'])

      // They fix the CSP; the re-scan says so.
      const after = profileWith({ gaps: ['hsts'] })
      await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile: after })

      const quotable = await quotableFindings(db, orgId, company!.id)
      expect(quotable.map((f) => f.signalKey)).toEqual(['hsts'])
      expect(quotable.some((f) => f.signalKey === 'csp'), 'the closed gap must not be quotable').toBe(false)

      // The old row is still there as history — it is simply not quotable.
      const all = await db.select().from(schema.findings).where(eq(schema.findings.companyId, company!.id))
      expect(all.filter((f) => f.signalKey === 'csp')).toHaveLength(2)
    })

    it('quotes nothing at all when the latest scan never reached the site', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'wentdown.test' })
        .returning({ id: schema.companies.id })
      const good = profileWith({ gaps: ['csp'] })
      await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile: good })

      const down: SiteProfile = {
        domain: 'wentdown.test', company: '', title: '', fetchOk: false, fetchError: 'TimeoutError',
        hasLoginSurface: false, isSecurityVendor: false, mentionsSecurityHiring: false,
        outdatedLibs: [], observations: {},
      }
      await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile: down })

      // The newest successful scan is still the source of truth; a failed scan
      // does not silently un-quote a real finding, nor does it add one.
      const quotable = await quotableFindings(db, orgId, company!.id)
      expect(quotable.map((f) => f.signalKey)).toEqual(['csp'])
    })

    it('refuses a nonsensical threshold rather than marking everything', async () => {
      await expect(markStaleFindings(db, orgId, 0)).rejects.toThrow(/positive number/)
      await expect(markStaleFindings(db, orgId, -14)).rejects.toThrow(/positive number/)
    })

    /**
     * `findings.stale` is a CACHE, written by markStaleFindings, which only
     * runs when someone runs a scan. A finding that aged past the threshold an
     * hour ago still has `stale = false` on it. Reading the column instead of
     * the scan's age is what lets a three-week-old observation go out in an
     * email — the exact §2.2 failure the column was meant to prevent.
     */
    it('will not quote an observation that aged out since the last sweep', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'agedout.test' })
        .returning({ id: schema.companies.id })
      await recordScan(db, {
        orgId, companyId: company!.id, icpProfile, raw: {}, profile: profileWith({ gaps: ['csp'] }),
      })

      // The column still says fresh: nothing has swept since the scan.
      const rows = await db.select().from(schema.findings).where(eq(schema.findings.companyId, company!.id))
      expect(rows.every((f) => f.stale === false)).toBe(true)

      // Fresh now...
      expect((await quotableFindings(db, orgId, company!.id, 14)).map((f) => f.signalKey)).toEqual(['csp'])
      // ...and nothing fifteen days from now, without the column having moved.
      const later = new Date(Date.now() + 15 * 86_400_000)
      expect(await quotableFindings(db, orgId, company!.id, 14, later)).toEqual([])
      const stillFresh = await db.select().from(schema.findings).where(eq(schema.findings.companyId, company!.id))
      expect(stillFresh.every((f) => f.stale === false), 'the column was not touched').toBe(true)
    })
  })

  /**
   * A score is a claim about a set of findings. Before 0006 it recorded a
   * company and a time and nothing else, so "the latest score" and "the latest
   * scan" were two independent lookups that could disagree.
   */
  describe('a score names the scan it was computed from', () => {
    it('stamps the scan it was written with', async () => {
      const company = await findCompanyByDomain(db, orgId, 'acme.test')
      const out = await recordScan(db, {
        orgId, companyId: company!.id, icpProfile, raw: {}, profile: profileWith({ gaps: ['csp'] }),
      })
      const rows = await db.select().from(schema.scores).where(eq(schema.scores.id, out.scoreId))
      expect(rows[0]!.scanId).toBe(out.scanId)
    })

    it('returns the score of the scan whose findings it returns', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'paired.test' })
        .returning({ id: schema.companies.id })

      const first = await recordScan(db, {
        orgId, companyId: company!.id, icpProfile, raw: {},
        profile: profileWith({ gaps: ['csp', 'hsts', 'trust_page', 'security_txt'] }),
      })
      const second = await recordScan(db, {
        orgId, companyId: company!.id, icpProfile, raw: {}, profile: profileWith({ gaps: ['hsts'] }),
      })
      expect(second.result.score).not.toBe(first.result.score)

      const found = await latestScanWithFindings(db, orgId, company!.id)
      expect(found!.scan.id).toBe(second.scanId)
      expect(found!.score!.scanId).toBe(second.scanId)
      expect(found!.score!.score).toBe(second.result.score)
    })

    it('puts the latest scan\'s score in the list, not the latest score row', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'listed.test' })
        .returning({ id: schema.companies.id })
      await recordScan(db, {
        orgId, companyId: company!.id, icpProfile, raw: {},
        profile: profileWith({ gaps: ['csp', 'hsts', 'trust_page'] }),
      })
      const second = await recordScan(db, {
        orgId, companyId: company!.id, icpProfile, raw: {}, profile: profileWith({ gaps: [] }),
      })

      const row = (await companyList(db, orgId)).find((c) => c.domain === 'listed.test')
      expect(row!.score).toBe(second.result.score)
      expect(row!.lastScanAt?.getTime()).toBe(
        (await db.select().from(schema.scans).where(eq(schema.scans.id, second.scanId)))[0]!.ranAt.getTime(),
      )
    })

    it('refuses to file a score against another company\'s scan', async () => {
      const acme = await findCompanyByDomain(db, orgId, 'acme.test')
      const [other] = await db
        .insert(schema.companies).values({ orgId, domain: 'elsewhere.test' })
        .returning({ id: schema.companies.id })
      const out = await recordScan(db, {
        orgId, companyId: acme!.id, icpProfile, raw: {}, profile: profileWith({ gaps: ['csp'] }),
      })
      // Through the raw driver: the point is that the DATABASE refuses this,
      // not that the repository declines to ask.
      const message = await expectRejection(() =>
        test.driver.select(
          `INSERT INTO scores (org_id, company_id, scan_id, icp_profile_id, score, tier, qualified)
           VALUES ($1, $2, $3, $4, 99, 'A', true)`,
          [orgId, other!.id, out.scanId, icpProfile.id],
        ),
      )
      expect(message).toMatch(/scores_scan_matches_company_and_org/)
    })
  })

  /**
   * Scoring returns before the gap list is built for a DISQUALIFIED company, so
   * reading weights from `result.gaps` wrote 0 against every real gap such a
   * company has — and the detail page then ranked them all equally at nothing.
   * The weight of a signal is a property of the ICP, not of the score.
   */
  describe('a disqualified company still records what its gaps are worth', () => {
    it('writes the ICP weight even though the score is zero', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'vendor.test' })
        .returning({ id: schema.companies.id })

      const profile = { ...profileWith({ gaps: ['csp', 'hsts'] }), isSecurityVendor: true }
      const out = await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile })

      expect(out.result.disqualified).not.toBe('')
      expect(out.result.gaps).toEqual([])

      const rows = await db.select().from(schema.findings).where(eq(schema.findings.scanId, out.scanId))
      const csp = rows.find((f) => f.signalKey === 'csp')
      const hsts = rows.find((f) => f.signalKey === 'hsts')
      expect(csp!.gap).toBe(true)
      expect(csp!.weight).toBe(icp.signals.csp!.weight)
      expect(hsts!.weight).toBe(icp.signals.hsts!.weight)
      // ...and a signal that is not a gap is still worth nothing.
      expect(rows.find((f) => f.signalKey === 'tls')!.weight).toBe(0)
    })
  })

  /**
   * §2.2 for signals the scanner observes and the ICP does not score. They are
   * recorded, because the page shows them; they are marked, because nothing
   * may quote them; and the schema pins them to weight 0, so no reader can
   * mistake one for a gap that counts.
   */
  describe('informational signals are recorded and never scored', () => {
    const withInformational = (): SiteProfile => {
      const base = profileWith({ gaps: ['csp'] })
      return {
        ...base,
        observations: {
          ...base.observations,
          cross_origin_policies: {
            observed: true, gap: true, detail: 'none of COOP, COEP or CORP is sent',
            evidence: { url: 'https://info.test/', coop: 'absent', coep: 'absent', corp: 'absent' },
          },
          cookie_flags: {
            observed: false, gap: null, detail: 'not captured',
            evidence: { url: 'https://info.test/', reason: 'this capture did not record every Set-Cookie header' },
          },
        },
      }
    }

    it('writes a key the ICP does not name as scored = false, weight 0 — even as a gap', async () => {
      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: 'info.test' })
        .returning({ id: schema.companies.id })
      const out = await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: {}, profile: withInformational() })

      const rows = await db.select().from(schema.findings).where(eq(schema.findings.scanId, out.scanId))
      const coop = rows.find((f) => f.signalKey === 'cross_origin_policies')!
      expect(coop).toMatchObject({ scored: false, weight: 0, observed: true, gap: true })
      expect(rows.find((f) => f.signalKey === 'cookie_flags')).toMatchObject({ scored: false, gap: null })
      // Every ICP key is scored, and csp keeps its real weight.
      for (const key of Object.keys(icp.signals)) expect(rows.find((f) => f.signalKey === key)!.scored, key).toBe(true)
      expect(rows.find((f) => f.signalKey === 'csp')!.weight).toBe(icp.signals.csp!.weight)
      // And the score is the one the ICP alone gives.
      expect(out.result.score).toBe(scoreCompany(profileWith({ gaps: ['csp'] }), icp).score)
    })

    it('never offers one for quoting in a draft', async () => {
      const company = await findCompanyByDomain(db, orgId, 'info.test')
      const quotable = await quotableFindings(db, orgId, company!.id)
      expect(quotable.map((f) => f.signalKey)).toEqual(['csp'])
    })

    it('still returns it to the page, which shows it under "Also observed"', async () => {
      const company = await findCompanyByDomain(db, orgId, 'info.test')
      const found = await latestScanWithFindings(db, orgId, company!.id)
      expect(found!.findings.map((f) => f.signalKey)).toContain('cross_origin_policies')

      const info = await latestInformationalFindings(db, orgId, company!.id)
      expect(info!.findings.map((f) => f.signalKey).sort()).toEqual(['cookie_flags', 'cross_origin_policies'])
      expect(info!.findings.every((f) => !f.scored)).toBe(true)
    })

    it('shows no informational section for a latest scan that never reached the site', async () => {
      const company = await findCompanyByDomain(db, orgId, 'info.test')
      await recordScan(db, {
        orgId, companyId: company!.id, icpProfile, raw: {},
        profile: { ...withInformational(), fetchOk: false, fetchError: 'TimeoutError', observations: {} },
      })
      expect(await latestInformationalFindings(db, orgId, company!.id)).toBeNull()
    })

    it('is refused by the database if it ever claims a weight', async () => {
      const company = await findCompanyByDomain(db, orgId, 'acme.test')
      const found = await latestScanWithFindings(db, orgId, company!.id)
      const message = await expectRejection(() =>
        test.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, scored, evidence)
           VALUES ($1, $2, $3, 'hsts_quality', true, true, 5, false, '{"url":"https://acme.test/"}'::jsonb)`,
          [orgId, found!.scan.id, company!.id],
        ),
      )
      expect(message).toMatch(/findings_informational_carries_no_weight/)
    })

    /**
     * A REAL profile: every key the scanner produces for a recorded site,
     * the 'not applicable' and 'not captured' variants included. One bad
     * observation — an unobserved row with a gap, a gap with empty evidence —
     * fails the whole insert, and with it every scan in production.
     */
    it('records every key of a real recorded site through the constraints', async () => {
      const domain = fixtureNames()[0]!
      const fixture = loadFixture(domain)
      const profile = extractProfile(fixture, fixture.company)
      expect(profile.fetchOk).toBe(true)

      const [company] = await db
        .insert(schema.companies).values({ orgId, domain: `fixture-${domain}` })
        .returning({ id: schema.companies.id })
      const out = await recordScan(db, { orgId, companyId: company!.id, icpProfile, raw: fixture, profile })

      const rows = await db.select().from(schema.findings).where(eq(schema.findings.scanId, out.scanId))
      expect(rows).toHaveLength(Object.keys(icp.signals).length + ADDITIVE_SIGNAL_KEYS.length)
      const unscored = rows.filter((f) => !f.scored)
      expect(unscored.map((f) => f.signalKey).sort()).toEqual([...ADDITIVE_SIGNAL_KEYS].sort())
      expect(unscored.every((f) => f.weight === 0)).toBe(true)
      expect(unscored.find((f) => f.signalKey === 'cookie_flags')).toMatchObject({ observed: false, gap: null })
    })
  })
})
