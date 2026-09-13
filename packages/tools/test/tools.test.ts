/**
 * The agency tools, against a real Postgres engine.
 *
 * This suite exists in this shape because of one fact about the environment:
 * the Agent SDK ships no mock transport and no recorded-session mode, so
 * anything that needed the SDK to be *defined* would also be untestable.
 * Keeping the tool specs as plain data means the half that touches the
 * database — which is the half that can violate §2.2 — is tested directly,
 * with no API key and no model.
 *
 * The rules being asserted are the ones a careless handler breaks silently:
 * a finding nobody observed reaching the model's context, stale evidence
 * presented as current, `orgId` taken from an argument, and a channel §2.1
 * forbids slipping through below the gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  AGENCY_TOOL_NAMES, parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile,
} from '@agency/core'
import {
  SEED_DIR, importCompanies, recordScan, type AgencyDb,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { freshDb, migrations, type TestDb } from '../../db/test/helpers.js'
import { migrateUp } from '../../db/src/migrator.js'
import {
  AGENCY_TOOLS, bounded, getCompany, getIcp, queueTouch, scoreCompanyTool, searchCompanies,
  type AgencyToolSpec, type ToolContext,
} from '../src/index.js'

const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
)

const DAY = 86_400_000

describe('the agency tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let icpProfile: { id: string; definition: IcpDefinition }
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: 'user-1', orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => new Date(),
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })

  /** Run a tool the way the adapter will: parse with zod, then hand over. */
  const run = async <S extends z.ZodRawShape>(
    spec: AgencyToolSpec<S>,
    input: unknown,
    over: Partial<ToolContext> = {},
  ) => {
    const parsed = z.object(spec.shape).parse(input)
    return spec.handler(parsed as never, ctx(over))
  }

  const profileFor = (over: { gaps?: string[]; unobserved?: string[]; fetchOk?: boolean } = {}): SiteProfile => {
    const observations: Record<string, Observation> = {}
    for (const key of AGENCY_SIGNALS) {
      observations[key] = { observed: true, gap: false, detail: '', evidence: { header: key, seen: 'present' } }
    }
    for (const key of over.gaps ?? []) {
      observations[key] = { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
    }
    for (const key of over.unobserved ?? []) {
      observations[key] = { observed: false, gap: null, detail: 'timed out', evidence: { outcome: 'no response' } }
    }
    return {
      domain: 'acme.test', company: 'Acme', title: 'Acme',
      fetchOk: over.fetchOk ?? true, fetchError: over.fetchOk === false ? 'TimeoutError' : '',
      hasLoginSurface: true, isSecurityVendor: false, mentionsSecurityHiring: false,
      outdatedLibs: [], observations: over.fetchOk === false ? {} : observations,
    }
  }

  const AGENCY_SIGNALS = Object.keys(icp.signals)

  beforeAll(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id

    const [profile] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown>, active: true })
      .returning({ id: schema.icpProfiles.id })
    icpProfile = { id: profile!.id, definition: icp }

    await importCompanies(db, orgId, [
      { domain: 'acme.test', name: 'Acme' },
      { domain: 'beta.test', name: 'Beta' },
      { domain: 'never-scanned.test', name: 'Fresh Lead' },
      // Its own company, because backdating a scan on a company that has
      // others makes an EARLIER scan the latest one.
      { domain: 'aged-out.test', name: 'Aged Out' },
    ])
    // A company in ANOTHER org, to prove org scoping is not decorative.
    await importCompanies(db, otherOrgId, [{ domain: 'rival-only.test', name: 'Rival Only' }])
  }, 30_000)

  afterAll(async () => {
    await test?.close()
  })

  const scanOf = async (domain: string, over: Parameters<typeof profileFor>[0] = {}, ranAt?: Date) => {
    const company = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.domain, domain))
      .limit(1)
    const out = await recordScan(db, {
      orgId, companyId: company[0]!.id, icpProfile, raw: {}, profile: { ...profileFor(over), domain },
    })
    if (ranAt) {
      await db.update(schema.scans).set({ ranAt }).where(eq(schema.scans.id, out.scanId))
    }
    return out
  }

  // -------------------------------------------------------------------------

  describe('the registry', () => {
    /**
     * A tool that is implemented but unclassified would be refused by the gate
     * at run time; a tool that is classified but unimplemented is a registry
     * entry claiming something exists. Both directions, so neither can drift.
     */
    it('is exactly the set of tools the risk classifier knows about', () => {
      expect(AGENCY_TOOLS.map((t) => t.name).sort()).toEqual([...AGENCY_TOOL_NAMES].sort())
    })

    it('gives the model a description long enough to choose by', () => {
      for (const t of AGENCY_TOOLS) {
        expect(t.description.length, t.name).toBeGreaterThan(80)
      }
    })

    it('declares a raw zod shape, not a z.object — which is what tool() takes', () => {
      for (const t of AGENCY_TOOLS) {
        expect(typeof t.shape, t.name).toBe('object')
        expect(t.shape instanceof z.ZodType, t.name).toBe(false)
      }
    })
  })

  describe('bounded', () => {
    it('says how much it dropped rather than truncating silently', () => {
      const out = bounded(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)], 40)
      expect(out).toContain('2 more rows omitted')
    })

    it('leaves a short result alone', () => {
      expect(bounded(['one', 'two'])).toBe('one\ntwo')
    })
  })

  describe('get_icp', () => {
    it('returns the signals in the order the scorer uses, not jsonb key order', async () => {
      const out = await run(getIcp, {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { signals: Array<{ key: string; weight: number }>; qualifyAt: number }
      expect(data.qualifyAt).toBe(icp.scoring.qualify_at)
      // Authored heaviest-first; a jsonb walk would reorder it.
      const weights = data.signals.map((s) => s.weight)
      expect(weights).toEqual([...weights].sort((a, b) => b - a))
      expect(data.signals[0]!.key).toBe('csp')
    })

    it('says so plainly when no ICP is configured', async () => {
      const out = await run(getIcp, {}, { orgId: otherOrgId })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_found')
    })
  })

  describe('search_companies', () => {
    beforeAll(async () => {
      await scanOf('acme.test', { gaps: ['csp', 'trust_page', 'compliance_claim', 'security_txt'] })
      await scanOf('beta.test', { gaps: ['csp'] })
    })

    it('ranks by score so "the top N by fit" is one query, not a second ranking path', async () => {
      const out = await run(searchCompanies, { sort: 'score_desc', limit: 2 })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { companies: Array<{ domain: string; score: number | null }> }
      expect(data.companies).toHaveLength(2)
      expect(data.companies[0]!.score).toBeGreaterThanOrEqual(data.companies[1]!.score ?? 0)
    })

    it('never returns a company from another org, whatever the filters say', async () => {
      const out = await run(searchCompanies, { limit: 100 })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { companies: Array<{ domain: string }> }
      expect(data.companies.map((c) => c.domain)).not.toContain('rival-only.test')
    })

    /**
     * Freshness is derived from the scan's time. Reading findings.stale would
     * report "fresh" for anything not swept since it aged out, which is how a
     * three-week-old gap gets quoted in an email.
     */
    it('marks a company stale from its scan time, not from the cached column', async () => {
      await scanOf('aged-out.test', { gaps: ['csp'] }, new Date(Date.now() - 40 * DAY))
      const rows = await db.select().from(schema.findings)
      expect(rows.every((f) => f.stale === false), 'the cache still says fresh').toBe(true)

      const out = await run(searchCompanies, { limit: 100 })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { companies: Array<{ domain: string; stale: boolean }> }
      expect(data.companies.find((c) => c.domain === 'aged-out.test')!.stale).toBe(true)
      expect(data.companies.find((c) => c.domain === 'acme.test')!.stale).toBe(false)
    })

    it('treats a company nobody has scanned as having no evidence at all', async () => {
      const out = await run(searchCompanies, { neverScanned: true, limit: 100 })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { companies: Array<{ domain: string; stale: boolean; score: number | null }> }
      const fresh = data.companies.find((c) => c.domain === 'never-scanned.test')!
      expect(fresh.score).toBeNull()
      expect(fresh.stale).toBe(true)
    })
  })

  describe('get_company', () => {
    /**
     * §2.2 and §12. The model's context is a rendering like any other, so a
     * signal the scan could not observe must not appear in it — not as a gap,
     * and not as a strength either.
     */
    it('drops every unobserved finding before the model ever sees it', async () => {
      await scanOf('acme.test', { gaps: ['csp'], unobserved: ['tls', 'trust_page'] })
      const out = await run(getCompany, { domain: 'acme.test' })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as {
        gaps: Array<{ signal: string }>; strengths: Array<{ signal: string }>; notObservedCount: number
      }
      const mentioned = [...data.gaps, ...data.strengths].map((f) => f.signal)
      expect(mentioned).not.toContain('tls')
      expect(mentioned).not.toContain('trust_page')
      expect(data.notObservedCount).toBe(2)
      expect(out.summary).toContain('could not be observed')
    })

    it('tells the model when the evidence is too old to quote', async () => {
      await scanOf('aged-out.test', { gaps: ['csp'] }, new Date(Date.now() - 40 * DAY))
      const out = await run(getCompany, { domain: 'aged-out.test' })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { stale: boolean; quotable: boolean; gaps: Array<{ quotable: boolean }> }
      expect(data.stale).toBe(true)
      expect(data.quotable).toBe(false)
      expect(data.gaps.every((g) => !g.quotable)).toBe(true)
      expect(out.summary).toContain('MUST be re-verified')
    })

    it('claims nothing at all when the scan never reached the site', async () => {
      await scanOf('acme.test', { fetchOk: false })
      const out = await run(getCompany, { domain: 'acme.test' })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { reachedTheSite: boolean; findings: unknown[] }
      expect(data.reachedTheSite).toBe(false)
      expect(out.summary).toContain('Nothing was observed')
    })

    it('will not read a company belonging to another org', async () => {
      const out = await run(getCompany, { domain: 'rival-only.test' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_found')
    })

    /**
     * This tool used to lower-case and trim while the three write tools ran
     * `normaliseDomain`, so the same company was findable by one and missing
     * from the other. The model pastes what it was given — usually a URL —
     * and a company reported as "not in the CRM" is one it will then tell the
     * user about, in words, wrongly.
     */
    it.each([
      'ACME.test',
      '  acme.test  ',
      'www.acme.test',
      'https://acme.test',
      'https://www.acme.test/pricing?utm=x#top',
      'acme.test:443',
    ])('finds the company from %s, like every other tool does', async (given) => {
      const out = await run(getCompany, { domain: given })
      expect(out.ok, `${given} was not resolved`).toBe(true)
    })

    it('says so plainly when the input reduces to no host at all', async () => {
      const out = await run(getCompany, { domain: 'https://' })
      expect(out.ok).toBe(false)
    })
  })

  describe('score_company', () => {
    it('returns the stored score without re-scanning when the evidence is current', async () => {
      const recorded = await scanOf('beta.test', { gaps: ['csp', 'hsts'] })
      const out = await run(scoreCompanyTool, { domain: 'beta.test' })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { rescanned: boolean; score: number }
      expect(data.rescanned).toBe(false)
      expect(data.score).toBe(recorded.result.score)
    })

    it('says not_found rather than inventing a company', async () => {
      const out = await run(scoreCompanyTool, { domain: 'nobody-here.test' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_found')
    })
  })

  describe('queue_touch', () => {
    it('writes a draft that names its company and has no recipient', async () => {
      const out = await run(queueTouch, {
        domain: 'acme.test', channel: 'email',
        subject: 'Your login page has no CSP', body: 'We looked at your public pages…',
      })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { touchId: string; status: string }
      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, data.touchId))
      expect(row!.companyId).not.toBeNull()
      expect(row!.contactId).toBeNull()
      expect(row!.recipient).toBeNull()
      // NOT the column default 'queued', which is what a Phase 4 sender scans
      // for. This row must never be picked up by one.
      expect(row!.status).toBe('awaiting_approval')
      expect(row!.direction).toBe('out')
    })

    /**
     * §2.1 and §12: cold voice and SMS must not be reachable through any code
     * path. The risk classifier refuses them above this, and the enum refuses
     * them here — below the gate, where the rule holds even if canUseTool
     * never ran at all.
     */
    it.each(['sms', 'voice', 'whatsapp', 'call'])(
      'cannot be asked to draft a %s message, even below the approval gate',
      async (channel) => {
        expect(() =>
          z.object(queueTouch.shape).parse({
            domain: 'acme.test', channel, subject: 's', body: 'b',
          }),
        ).toThrow()
      },
    )

    it('refuses a company that is not in the CRM', async () => {
      const out = await run(queueTouch, {
        domain: 'stranger.test', channel: 'email', subject: 's', body: 'b',
      })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_found')
    })
  })

  describe('every tool', () => {
    it('writes an audit row when it succeeds', async () => {
      audited.length = 0
      await run(getIcp, {})
      await run(searchCompanies, { limit: 1 })
      await run(getCompany, { domain: 'acme.test' })
      expect(audited.map((a) => a.action)).toEqual([
        'agent.get_icp', 'agent.search_companies', 'agent.get_company',
      ])
    })

    it('takes orgId from the context, so no argument can reach another org', () => {
      for (const t of AGENCY_TOOLS) {
        const keys = Object.keys(t.shape)
        expect(keys, t.name).not.toContain('orgId')
        expect(keys, t.name).not.toContain('org_id')
      }
    })
  })
})
