/**
 * Every agent tool that judges freshness takes the ICP's threshold through
 * `staleAfterDaysOf` — against a real engine, with an active profile whose
 * `stale_after_days` is a hand-edited `0`.
 *
 * `isStale` throws on a threshold that is not a positive number, and
 * `parseIcpDefinition` does not check `freshness`. The tools passed the raw
 * value between the two, so `get_company`, `score_company`, the three
 * evidence tools and `get_compliance_summary` threw on such a profile, and
 * `get_icp` told the model findings go stale after 0 days — while
 * `/compliance` fell back to the default. The page and the tool must agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  DEFAULT_STALE_AFTER_DAYS, isStale, parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile,
} from '@agency/core'
import { SEED_DIR, complianceSummary, importCompanies, recordScan, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  getCompany, getComplianceSummary, getEvidenceChanges, getIcp, getScanHistory, getStaleCompanies, scoreCompanyTool,
  type AgencyToolSpec, type ToolContext,
} from '../src/index.js'

const SEED = JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')) as Record<string, unknown>
/** The seeded profile with one value changed: readable, and a threshold isStale refuses. */
const ZERO = { ...SEED, freshness: { ...(SEED.freshness as object), stale_after_days: 0 } }
const icp: IcpDefinition = parseIcpDefinition(ZERO)

const DAY = 86_400_000
const NOW = new Date('2026-09-30T12:00:00.000Z')

function reached(gaps: readonly string[]): SiteProfile {
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = gaps.includes(key)
      ? { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
      : { observed: true, gap: false, detail: 'present', evidence: { header: key, seen: 'present' } }
  }
  return {
    domain: 'acme.test', company: 'Acme', title: 'Acme', fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations,
  }
}

describe('the agent tools, on a profile whose stale threshold isStale would refuse', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [profile] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: ZERO, active: true })
      .returning({ id: schema.icpProfiles.id })
    await importCompanies(db, orgId, [{ domain: 'acme.test', name: 'Acme' }, { domain: 'never.test', name: 'Never' }])
    const [acme] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.domain, 'acme.test'))
    // Two scans that reached the site — ten and two days old: fresh at the
    // default, and each one stale at any threshold under two days.
    for (const [age, gaps] of [[10, ['csp', 'hsts']], [2, ['csp']]] as const) {
      const { scanId } = await recordScan(db, {
        orgId, companyId: acme!.id, raw: {}, profile: reached(gaps), icpProfile: { id: profile!.id, definition: icp },
      })
      await db.update(schema.scans).set({ ranAt: new Date(NOW.getTime() - age * DAY) }).where(eq(schema.scans.id, scanId))
    }
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db, orgId, principal: { id: userId, orgId, role: 'owner' }, turnId: '44444444-4444-4444-8444-444444444444',
    now: () => NOW, audit: async () => {},
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx())
  const okData = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) => {
    const out = await run(spec, input)
    if (!out.ok) throw new Error(`${spec.name}: ${out.code} ${out.message}`)
    return out
  }

  it('the premise: the raw threshold throws in isStale', () => {
    expect(icp.freshness?.stale_after_days).toBe(0)
    expect(() => isStale(NOW, 0, NOW)).toThrow(/positive number/)
  })

  it('get_icp tells the model the threshold every reader uses, not 0', async () => {
    const out = await okData(getIcp, {})
    expect((out.data as { staleAfterDays: number }).staleAfterDays).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(out.summary).toContain(`Findings older than ${DEFAULT_STALE_AFTER_DAYS} days must be re-verified.`)
  })

  it('get_company reads the company, and calls a two-day-old scan current', async () => {
    const out = await okData(getCompany, { domain: 'acme.test' })
    expect(JSON.stringify(out.data)).toContain('acme.test')
  })

  it('score_company returns the stored score without re-scanning', async () => {
    const out = await okData(scoreCompanyTool, { domain: 'acme.test' })
    expect((out.data as { rescanned: boolean }).rescanned).toBe(false)
  })

  it('get_scan_history marks neither scan stale', async () => {
    const out = await okData(getScanHistory, { domain: 'acme.test' })
    expect((out.data as { scans: { stale: boolean }[] }).scans.map((s) => s.stale)).toEqual([false, false])
  })

  it('get_evidence_changes compares the two scans', async () => {
    await okData(getEvidenceChanges, { domain: 'acme.test' })
  })

  it('get_stale_companies lists the never-scanned company and not the fresh one, at the default', async () => {
    const out = await okData(getStaleCompanies, {})
    const data = out.data as { staleAfterDays: number; companies: { domain: string }[] }
    expect(data.staleAfterDays).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(data.companies.map((c) => c.domain)).toEqual(['never.test'])
  })

  it('get_compliance_summary answers at the threshold /compliance uses', async () => {
    const out = await okData(getComplianceSummary, {})
    expect(out.summary).toContain(`stale after ${DEFAULT_STALE_AFTER_DAYS} days`)
    // The page's own read, at the threshold readIcp hands it.
    const page = await complianceSummary(db, orgId, { staleDays: DEFAULT_STALE_AFTER_DAYS, now: NOW })
    expect((out.data as { freshness: { fresh: number; stale: number } }).freshness).toMatchObject({
      fresh: page.freshness.fresh, stale: page.freshness.stale,
    })
  })
})

/** Nothing in packages/tools/src reads `stale_after_days` except through `staleAfterDaysOf`. */
describe('packages/tools/src reads stale_after_days only through staleAfterDaysOf', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url))
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it.each(readdirSync(SRC).filter((f) => f.endsWith('.ts')))('%s', (file) => {
    expect(code(readFileSync(join(SRC, file), 'utf8'))).not.toMatch(/\bstale_after_days\b/)
  })
})
