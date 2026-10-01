/**
 * The evidence tools, against a real Postgres engine (§2.2).
 *
 * Three reads nobody is asked to approve, so what they put in the model's
 * context is the only guard there is. The rules asserted are the ones the
 * obvious implementation breaks without anything looking wrong: a timeout
 * shown as a 0, "we could not see it this time" read as "they fixed it", and
 * freshness read from the `findings.stale` cache instead of the scan's time.
 *
 * Scans go through the real writer (`recordScan`), then have `ran_at` pinned,
 * so the rows here are the rows a real scan leaves — including the 0 score
 * the writer stores for a scan that never reached the site.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  AGENCY_TOOL_RISK, parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile,
} from '@agency/core'
import { SEED_DIR, importCompanies, recordScan, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  AGENCY_TOOLS, TOOL_TEXT_BUDGET, getEvidenceChanges, getScanHistory, getStaleCompanies,
  type AgencyToolSpec, type ToolContext,
} from '../src/index.js'

const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
)

const DAY = 86_400_000
const NOW = new Date('2026-09-30T12:00:00.000Z')
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY)

function reached(
  over: { gaps?: string[]; unobserved?: string[]; extra?: Record<string, Observation> } = {},
): SiteProfile {
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: false, detail: 'present', evidence: { header: key, seen: 'present' } }
  }
  for (const key of over.gaps ?? []) {
    observations[key] = { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
  }
  for (const key of over.unobserved ?? []) {
    observations[key] = { observed: false, gap: null, detail: 'timed out', evidence: { outcome: 'no response' } }
  }
  Object.assign(observations, over.extra ?? {})
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

describe('the evidence tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let icpProfile: { id: string; definition: IcpDefinition }
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [profile] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown>, active: true })
      .returning({ id: schema.icpProfiles.id })
    icpProfile = { id: profile!.id, definition: icp }

    await importCompanies(db, orgId, [
      { domain: 'acme.test', name: 'Acme' },
      { domain: 'beta.test', name: 'Beta' },
      { domain: 'never.test', name: 'Never Scanned' },
    ])
    // Another org's company, never scanned: a stale-list that leaked across
    // orgs would list it, because "never scanned" is one of its reasons.
    await importCompanies(db, otherOrgId, [{ domain: 'rival.test', name: 'Rival Only' }])
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db,
    orgId,
    principal: { id: userId, orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx())

  /** Record a scan through the real writer, then pin when it ran. */
  const scanAt = async (domain: string, ranAt: Date, profile: SiteProfile) => {
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.domain, domain)).limit(1)
    const out = await recordScan(db, {
      orgId, companyId: company!.id, icpProfile, raw: {}, profile: { ...profile, domain },
    })
    await db.update(schema.scans).set({ ranAt }).where(eq(schema.scans.id, out.scanId))
    return out
  }

  it('is registered and classified as three reads', () => {
    for (const name of ['get_scan_history', 'get_evidence_changes', 'get_stale_companies'] as const) {
      expect(AGENCY_TOOLS.map((t) => t.name)).toContain(name)
      expect(AGENCY_TOOL_RISK[name][0]).toBe('low')
      expect(AGENCY_TOOL_RISK[name][1]).toBe('read_only')
    }
  })

  // -------------------------------------------------------------------------
  // get_scan_history
  // -------------------------------------------------------------------------

  describe('get_scan_history', () => {
    it('reports a scan that never reached the site as unreachable, never as a 0', async () => {
      const good = await scanAt('acme.test', daysAgo(5), reached({ gaps: ['csp'] }))
      const down = await scanAt('acme.test', daysAgo(1), unreachable)
      const [stored] = await db.select().from(schema.scores).where(eq(schema.scores.scanId, down.scanId))
      expect(stored!.score, 'the premise: the writer stores a 0 for it').toBe(0)

      const out = await run(getScanHistory, { domain: 'acme.test' })
      if (!out.ok) throw new Error(out.message)
      const data = out.data as {
        scans: Array<{ scanId: string; reachedTheSite: boolean; score: number | null; error: string | null }>
      }
      expect(data.scans.map((s) => s.scanId)).toEqual([down.scanId, good.scanId])
      expect(data.scans[0]).toMatchObject({ reachedTheSite: false, score: null, error: 'TimeoutError' })
      expect(data.scans[1]!.score).toBe(good.result.score)
      expect(good.result.score).toBeGreaterThan(0)

      const downLine = out.summary.split('\n').find((l) => l.includes(daysAgo(1).toISOString().slice(0, 10)))!
      expect(downLine).toContain('not reached · unreachable (TimeoutError)')
      expect(downLine).not.toMatch(/\b0\/100/)
      expect(out.summary).not.toMatch(/\b0\/100/)
      expect(out.summary).toContain(`reached · ${good.result.score}/100`)
      expect(out.summary).toContain('it is not a 0')
    })

    it('says when the newest scan that reached the site has aged out, from its ran_at', async () => {
      await scanAt('acme.test', daysAgo(30), reached({ gaps: ['csp'] }))
      // The cache says fresh; the scan's time says otherwise, and wins.
      await db.update(schema.findings).set({ stale: false })
      const out = await run(getScanHistory, { domain: 'https://www.acme.test/pricing' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toContain('older than 14 days')
      expect((out.data as { scans: Array<{ stale: boolean }> }).scans[0]!.stale).toBe(true)
    })

    it('says a company nobody has scanned has no history, rather than failing', async () => {
      const out = await run(getScanHistory, { domain: 'never.test' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toMatch(/never been scanned/)
      expect((out.data as { scans: unknown[] }).scans).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // get_evidence_changes
  // -------------------------------------------------------------------------

  describe('get_evidence_changes', () => {
    it('reads unobserved → observed as now_observed, never as fixed or regressed', async () => {
      await scanAt('acme.test', daysAgo(10), reached({ gaps: ['hsts'], unobserved: ['csp'] }))
      await scanAt('acme.test', daysAgo(1), reached({ gaps: ['csp'] }))

      const out = await run(getEvidenceChanges, { domain: 'acme.test' })
      if (!out.ok) throw new Error(out.message)
      const data = out.data as { changes: Array<{ signal: string; change: string }>; quotable: boolean }
      const change = (key: string) => data.changes.find((c) => c.signal === key)!.change
      expect(change('csp')).toBe('now_observed')
      expect(change('hsts')).toBe('fixed')
      expect(data.quotable).toBe(true)

      const [, afterNow] = out.summary.split('Now observed (1)')
      expect(afterNow).toBeDefined()
      expect(afterNow!.split('\n')[1]).toMatch(/ csp — a gap/)
      // csp appears under "Now observed" and nowhere as a fix or a regression.
      const fixedSection = out.summary.split('Fixed (1)')[1]!.split('Now observed')[0]!
      expect(fixedSection).toContain('hsts')
      expect(fixedSection).not.toContain('csp')
      expect(out.summary).not.toContain('Regressed')
    })

    it('never reads "could not see it this time" as fixed, and carries nothing for the unseen side', async () => {
      await scanAt('acme.test', daysAgo(10), reached({ gaps: ['csp'] }))
      await scanAt('acme.test', daysAgo(1), reached({ unobserved: ['csp'] }))

      const out = await run(getEvidenceChanges, { domain: 'acme.test' })
      if (!out.ok) throw new Error(out.message)
      const data = out.data as {
        changes: Array<{ signal: string; change: string; newer: Record<string, unknown> }>
        counts: { fixed: number; notAssessed: number }
      }
      const csp = data.changes.find((c) => c.signal === 'csp')!
      expect(csp.change).toBe('not_assessed_this_time')
      expect(csp.newer).toEqual({ observed: false })
      expect(data.counts).toMatchObject({ fixed: 0, notAssessed: 1 })
      expect(out.summary).toContain('Not assessed is not fixed')
      expect(out.summary).not.toContain('Fixed (')
      expect(out.summary).toContain('Nothing observed on both scans changed.')
    })

    it('compares the two scans that reached the site, skipping a timeout between them', async () => {
      const older = await scanAt('acme.test', daysAgo(20), reached({ gaps: ['csp'] }))
      await scanAt('acme.test', daysAgo(10), unreachable)
      const newer = await scanAt('acme.test', daysAgo(1), reached())

      const out = await run(getEvidenceChanges, { domain: 'acme.test' })
      if (!out.ok) throw new Error(out.message)
      const data = out.data as { newer: { scanId: string }; older: { scanId: string } }
      expect(data.newer.scanId).toBe(newer.scanId)
      expect(data.older.scanId).toBe(older.scanId)
      expect(out.summary).toMatch(/Fixed \(1\)[^\n]*\n\s+\d+\s+csp/)
    })

    it('says not_found when fewer than two scans reached the site — not "nothing changed"', async () => {
      await scanAt('acme.test', daysAgo(10), reached({ gaps: ['csp'] }))
      await scanAt('acme.test', daysAgo(1), unreachable)
      const out = await run(getEvidenceChanges, { domain: 'acme.test' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_found')
      expect(out.message).toContain('not the same as nothing having changed')
    })

    it('warns that a stale comparison may not be quoted', async () => {
      await scanAt('acme.test', daysAgo(40), reached({ gaps: ['csp'] }))
      await scanAt('acme.test', daysAgo(20), reached())
      const out = await run(getEvidenceChanges, { domain: 'acme.test' })
      if (!out.ok) throw new Error(out.message)
      expect((out.data as { quotable: boolean }).quotable).toBe(false)
      expect(out.summary).toContain('may be quoted to anyone until it is re-verified')
    })

    it('reports an unscored signal apart, as context, never as a fix or a regression', async () => {
      const hsts = (gap: boolean): Observation => ({
        observed: true, gap, detail: gap ? 'max-age=3600 is under 180 days' : 'max-age=31536000',
        evidence: { url: 'https://acme.test/', maxAge: gap ? 3600 : 31536000 },
      })
      await scanAt('acme.test', daysAgo(10), reached({ extra: { hsts_quality: hsts(false) } }))
      await scanAt('acme.test', daysAgo(1), reached({ extra: { hsts_quality: hsts(true) } }))
      const out = await run(getEvidenceChanges, { domain: 'acme.test' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).not.toContain('Regressed')
      expect(out.summary).toContain('not scored')
      expect(out.summary).toContain('hsts_quality regressed')
    })

    // additive.ts stores "not applicable" as observed with no gap. Read two
    // ways, an HSTS max-age=300 that was later dropped altogether was
    // "fixed", in the summary the model repeats to people.
    it('reads a gap → not applicable as no longer applicable, never as fixed', async () => {
      const short: Observation = {
        observed: true, gap: true, detail: 'max-age=300 is under 180 days',
        evidence: { url: 'https://acme.test/', maxAge: 300 },
      }
      const gone: Observation = {
        observed: true, gap: false, detail: 'not applicable — no Strict-Transport-Security header',
        evidence: { url: 'https://acme.test/', maxAge: null },
      }
      await scanAt('acme.test', daysAgo(10), reached({ extra: { hsts_quality: short } }))
      await scanAt('acme.test', daysAgo(1), reached({ extra: { hsts_quality: gone } }))
      const out = await run(getEvidenceChanges, { domain: 'acme.test' })
      if (!out.ok) throw new Error(out.message)
      const data = out.data as {
        changes: Array<{ signal: string; change: string; newer: Record<string, unknown> }>
        counts: { fixed: number; noLongerApplicable: number }
      }
      const row = data.changes.find((c) => c.signal === 'hsts_quality')!
      expect(row.change).toBe('no_longer_applicable')
      expect(row.newer).toMatchObject({ observed: true, gap: false, notApplicable: true })
      expect(data.counts).toMatchObject({ fixed: 0, noLongerApplicable: 1 })
      expect(out.summary).toContain('hsts_quality no longer applicable (nothing to judge now; not a fix)')
      expect(out.summary).not.toContain('Fixed (')
      expect(out.summary).not.toMatch(/hsts_quality (fixed|no_longer_applicable)/)
    })
  })

  // -------------------------------------------------------------------------
  // get_stale_companies
  // -------------------------------------------------------------------------

  describe('get_stale_companies', () => {
    it('lists a company as stale from its scan time, even when findings.stale says fresh', async () => {
      await scanAt('acme.test', daysAgo(30), reached({ gaps: ['csp'] }))
      await db.update(schema.findings).set({ stale: false })
      await scanAt('beta.test', daysAgo(1), reached())

      const out = await run(getStaleCompanies, {})
      if (!out.ok) throw new Error(out.message)
      const rows = (out.data as { companies: Array<{ domain: string; why: string; lastScanAt: string | null }> }).companies
      expect(rows.find((r) => r.domain === 'acme.test')).toMatchObject({
        why: 'stale', lastScanAt: daysAgo(30).toISOString(),
      })
      expect(rows.map((r) => r.domain)).not.toContain('beta.test')
      expect(out.summary).toMatch(/stale\s+acme\.test \(Acme\) — last observed \d{4}-\d{2}-\d{2}, 30 days ago/)
    })

    it('names unreachable and never-scanned as their own reasons, and never quotes a timeout’s 0', async () => {
      await scanAt('beta.test', daysAgo(20), reached({ gaps: ['csp'] }))
      await scanAt('beta.test', daysAgo(1), unreachable)

      const out = await run(getStaleCompanies, {})
      if (!out.ok) throw new Error(out.message)
      const rows = (out.data as {
        companies: Array<{ domain: string; why: string; lastScore: number | null }>
      }).companies
      expect(rows).toEqual([
        expect.objectContaining({ domain: 'beta.test', why: 'unreachable', lastScore: null }),
        expect.objectContaining({ domain: 'acme.test', why: 'no_scan', lastScore: null }),
        expect.objectContaining({ domain: 'never.test', why: 'no_scan', lastScore: null }),
      ])
      expect(out.summary).toContain('did not reach the site; nothing was observed')
      expect(out.summary).not.toMatch(/scored 0\b/)
      expect(out.summary).toContain('Nothing was scanned by this call.')
    })

    it('says so when every company’s evidence is current', async () => {
      await db.delete(schema.companies).where(eq(schema.companies.domain, 'never.test'))
      await scanAt('acme.test', daysAgo(1), reached())
      await scanAt('beta.test', daysAgo(2), reached({ gaps: ['csp'] }))
      const out = await run(getStaleCompanies, {})
      if (!out.ok) throw new Error(out.message)
      expect((out.data as { total: number }).total).toBe(0)
      expect(out.summary).toMatch(/Every company's evidence is current/)
    })
  })

  // -------------------------------------------------------------------------
  // Every evidence tool
  // -------------------------------------------------------------------------

  describe('every evidence tool', () => {
    it('never reads another org’s company', async () => {
      for (const spec of [getScanHistory, getEvidenceChanges] as AgencyToolSpec[]) {
        const out = await run(spec, { domain: 'rival.test' })
        expect(out.ok, spec.name).toBe(false)
        if (!out.ok) expect(out.code, spec.name).toBe('not_found')
      }
      const out = await run(getStaleCompanies, { limit: 100 })
      if (!out.ok) throw new Error(out.message)
      const rows = (out.data as { companies: Array<{ domain: string }> }).companies
      expect(rows.map((r) => r.domain).sort()).toEqual(['acme.test', 'beta.test', 'never.test'])
      expect(out.summary).not.toContain('rival.test')
    })

    it('says not_found for a domain that is not in the CRM, or is not a domain at all', async () => {
      for (const spec of [getScanHistory, getEvidenceChanges] as AgencyToolSpec[]) {
        for (const domain of ['nobody.test', 'https://']) {
          const out = await run(spec, { domain })
          expect(out.ok, `${spec.name} ${domain}`).toBe(false)
          if (!out.ok) expect(out.code, `${spec.name} ${domain}`).toBe('not_found')
        }
      }
    })

    it('keeps every summary inside TOOL_TEXT_BUDGET, and says what it left out', async () => {
      await importCompanies(
        db,
        orgId,
        Array.from({ length: 120 }, (_, i) => ({
          domain: `a-company-with-a-deliberately-long-name-number-${String(i).padStart(3, '0')}.test`,
          name: `A company whose name is also longer than anybody would type, number ${i}`,
        })),
      )
      for (let i = 0; i < 20; i++) {
        await scanAt('acme.test', daysAgo(40 - i), i % 3 === 0 ? unreachable : reached({ gaps: ['csp'] }))
      }

      const stale = await run(getStaleCompanies, { limit: 100 })
      if (!stale.ok) throw new Error(stale.message)
      expect(stale.summary.length).toBeLessThan(TOOL_TEXT_BUDGET)
      expect(stale.summary).toMatch(/more rows omitted — narrow the filter/)

      const history = await run(getScanHistory, { domain: 'acme.test', limit: 20 })
      if (!history.ok) throw new Error(history.message)
      expect(history.summary.length).toBeLessThan(TOOL_TEXT_BUDGET)
      expect(history.summary).toContain('the 20 most recent')

      const changes = await run(getEvidenceChanges, { domain: 'acme.test' })
      if (!changes.ok) throw new Error(changes.message)
      expect(changes.summary.length).toBeLessThan(TOOL_TEXT_BUDGET)
    })

    it('audits agent.<tool> with ids and counts, never a domain', async () => {
      await scanAt('acme.test', daysAgo(10), reached({ gaps: ['csp'] }))
      await scanAt('acme.test', daysAgo(1), reached())
      await run(getScanHistory, { domain: 'acme.test' })
      await run(getEvidenceChanges, { domain: 'acme.test' })
      await run(getStaleCompanies, {})
      expect(audited.map((a) => a.action)).toEqual([
        'agent.get_scan_history', 'agent.get_evidence_changes', 'agent.get_stale_companies',
      ])
      for (const a of audited) {
        expect(JSON.stringify(a.detail), a.action).not.toMatch(/acme|beta|never\.test/)
      }
      expect(audited[1]!.detail).toMatchObject({ fixed: 1, regressed: 0 })
    })
  })
})
