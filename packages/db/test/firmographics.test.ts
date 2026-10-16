/**
 * Markets and size, against a real migrated database (0021): what a company is
 * recorded as, a scan scored against it, profiles derived and switched, and
 * the one research switch an owner may turn on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { parseIcpDefinition, type SiteProfile } from '@agency/core'
import seed from '../seed/icp-security-gap-saas.json' with { type: 'json' }
import {
  activateIcpProfile, activeIcpProfile, companiesUpdate, connectorReadsAllowed, connectorReadsSet,
  connectorReadsState, createConnector, createIcpProfile, readConnector, recordScan, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

/** A reachable SaaS with a login and two observed gaps: 25 of 33 observed weight, so 76 — tier A. */
const PROFILE: SiteProfile = {
  domain: 'acme.in',
  company: 'Acme',
  fetchOk: true,
  hasLoginSurface: true,
  isSecurityVendor: false,
  mentionsSecurityHiring: false,
  outdatedLibs: [],
  observations: {
    // A claimed gap carries its evidence, or the database refuses the row (§2.2).
    csp: { observed: true, gap: true, detail: 'header absent on homepage response', evidence: { header: 'content-security-policy', value: null } },
    hsts: { observed: true, gap: true, detail: 'header absent on homepage response', evidence: { header: 'strict-transport-security', value: null } },
    tls: { observed: true, gap: false, detail: 'TLS 1.3' },
  },
}

describe('firmographics and profiles', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let usEuId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [icp] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: seed.label, definition: seed, active: true })
      .returning({ id: schema.icpProfiles.id })
    usEuId = icp!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  async function company(domain = 'acme.in') {
    const [row] = await db.insert(schema.companies).values({ orgId, domain }).returning()
    return row!
  }

  const audit = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))

  describe('what a company is recorded as', () => {
    it('records industry, city, stage and a headcount with its source, and names what changed', async () => {
      const c = await company()
      const r = await companiesUpdate(db, orgId, c.id, {
        country: 'India', industry: 'fintech — payments', city: 'Bengaluru', stage: 'series-a',
        headcount: 120, headcountSource: 'https://www.linkedin.com/company/acme', description: 'Payments APIs for SMBs.',
      })
      expect(r).toMatchObject({ ok: true })
      if (!r.ok) return
      expect(r.changed.sort()).toEqual(['city', 'country', 'description', 'headcount', 'headcountSource', 'industry', 'stage'])
      expect(r.company).toMatchObject({ industry: 'fintech — payments', city: 'Bengaluru', headcount: 120 })
    })

    it('refuses a source with no headcount, and clears the source with the headcount', async () => {
      const c = await company()
      const bare = await companiesUpdate(db, orgId, c.id, { headcountSource: 'linkedin' })
      expect(bare).toMatchObject({ ok: false, reason: 'invalid', message: expect.stringMatching(/needs the headcount/) })
      await companiesUpdate(db, orgId, c.id, { headcount: 40, headcountSource: 'linkedin' })
      const cleared = await companiesUpdate(db, orgId, c.id, { headcount: null })
      expect(cleared.ok && cleared.company).toMatchObject({ headcount: null, headcountSource: null })
    })

    it('refuses a stage it does not know and a headcount that is not a count, writing nothing', async () => {
      const c = await company()
      expect(await companiesUpdate(db, orgId, c.id, { stage: 'unicorn' as never })).toMatchObject({ ok: false })
      expect(await companiesUpdate(db, orgId, c.id, { headcount: 0 })).toMatchObject({ ok: false })
      expect(await companiesUpdate(db, orgId, c.id, { headcount: 1.5 })).toMatchObject({ ok: false })
    })

    it('is held by the database too: a source with no headcount, or no positive count, cannot be stored', async () => {
      const c = await company()
      await expect(db.update(schema.companies).set({ headcountSource: 'x' }).where(eq(schema.companies.id, c.id))).rejects.toThrow()
      await expect(db.update(schema.companies).set({ headcount: 0 }).where(eq(schema.companies.id, c.id))).rejects.toThrow()
    })
  })

  describe('a scan scored against the record', () => {
    it('disqualifies as enterprise_scale a company recorded over the profile’s maximum, and qualifies it without', async () => {
      const icp = { id: usEuId, definition: parseIcpDefinition(seed) }
      const small = await company('small.in')
      const big = await company('big.in')
      await companiesUpdate(db, orgId, big.id, { headcount: 2400, headcountSource: 'linkedin' })

      const ok = await recordScan(db, { orgId, companyId: small.id, icpProfile: icp, raw: {}, profile: PROFILE })
      expect(ok.result).toMatchObject({ qualified: true, disqualified: '' })
      const no = await recordScan(db, { orgId, companyId: big.id, icpProfile: icp, raw: {}, profile: PROFILE })
      expect(no.result.qualified).toBe(false)
      expect(no.result.disqualified).toMatch(/^Over ~400 staff.*headcount on record: 2,400/)
      const [score] = await db.select().from(schema.scores).where(eq(schema.scores.id, no.scoreId))
      expect(score?.disqualifiedReason).toMatch(/headcount on record/)
    })
  })

  describe('profiles', () => {
    it('derives a new profile from the active one, stores it inactive, and audits it', async () => {
      const r = await createIcpProfile(db, {
        orgId,
        actor: 'agent',
        changes: { label: 'Security-gap SaaS (India)', geos: ['India'], headcount: { min: 10, max: 500 } },
      })
      expect(r).toMatchObject({ ok: true, name: 'Security-gap SaaS (India)', basedOn: seed.label })
      const rows = await db.select().from(schema.icpProfiles).where(eq(schema.icpProfiles.orgId, orgId))
      expect(rows.map((p) => [p.name, p.active]).sort()).toEqual([
        ['Security-gap SaaS (India)', false],
        [seed.label, true],
      ])
      const [row] = await audit('icp.created')
      expect(row?.detail).toMatchObject({ name: 'Security-gap SaaS (India)', geos: ['IN'], headcountMin: 10, headcountMax: 500 })

      expect(await createIcpProfile(db, { orgId, actor: 'agent', changes: { label: 'Security-gap SaaS (India)' } })).toMatchObject({
        ok: false, reason: 'name_taken',
      })
      expect(await createIcpProfile(db, { orgId, actor: 'agent', basedOn: 'Nope', changes: { label: 'Other' } })).toMatchObject({
        ok: false, reason: 'no_base',
      })
      expect(await createIcpProfile(db, { orgId, actor: 'agent', changes: { label: 'Bad', geos: ['Atlantis'] } })).toMatchObject({
        ok: false, reason: 'invalid',
      })
    })

    it('switches the active profile in one step, and scans are then scored under it', async () => {
      await createIcpProfile(db, { orgId, actor: 'agent', changes: { label: 'Security-gap SaaS (India)', geos: ['IN'] } })
      const r = await activateIcpProfile(db, { orgId, actor: 'agent', name: 'security-gap saas (india)' })
      expect(r).toEqual({ ok: true, changed: true, name: 'Security-gap SaaS (India)', previous: seed.label })
      const active = await activeIcpProfile(db, orgId)
      expect(active?.name).toBe('Security-gap SaaS (India)')
      const [row] = await audit('icp.activated')
      expect(row?.detail).toEqual({ name: 'Security-gap SaaS (India)', previous: seed.label })

      expect(await activateIcpProfile(db, { orgId, actor: 'agent', name: 'Security-gap SaaS (India)' })).toMatchObject({
        ok: true, changed: false,
      })
      expect(await activateIcpProfile(db, { orgId, actor: 'agent', name: 'Nope' })).toMatchObject({ ok: false, reason: 'not_found' })
    })

    it('holds one active profile per org in the database itself', async () => {
      await expect(
        db.insert(schema.icpProfiles).values({ orgId, name: 'Second', definition: seed, active: true }),
      ).rejects.toThrow()
      // Another org has its own.
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      await db.insert(schema.icpProfiles).values({ orgId: other!.id, name: seed.label, definition: seed, active: true })
    })
  })

  describe('a research connector an owner lets run without a card', () => {
    async function connector(name: string, url: string) {
      return createConnector(db, { orgId, name, kind: 'http', config: { url, headers: {} }, secretRef: null })
    }

    it('may be switched only for a server the catalog marks read-only, and is off until it is', async () => {
      const tavily = await connector('tavily', 'https://mcp.tavily.com/mcp/')
      const zapier = await connector('zapier', 'https://mcp.zapier.com/api/v1/connect')
      expect(connectorReadsState(tavily)).toEqual({ eligible: true, on: false, preset: 'Tavily' })
      expect(connectorReadsState(zapier)).toMatchObject({ eligible: false, on: false })
      expect(connectorReadsAllowed(tavily).size).toBe(0)

      const on = await connectorReadsSet(db, orgId, tavily.id, true)
      expect(on).toMatchObject({ ok: true, before: false })
      const after = (await readConnector(db, orgId, tavily.id))!
      expect(connectorReadsState(after).on).toBe(true)
      expect([...connectorReadsAllowed(after)]).toEqual(['mcp__tavily__*'])
      // Nothing else about the row moved.
      expect(after.enabled).toBe(tavily.enabled)

      expect(await connectorReadsSet(db, orgId, zapier.id, true)).toEqual({ ok: false, reason: 'not_eligible' })
      expect(await connectorReadsSet(db, orgId, zapier.id, false)).toMatchObject({ ok: true })
      expect(await connectorReadsSet(db, orgId, '00000000-0000-4000-8000-000000000000', true)).toEqual({
        ok: false, reason: 'not_found',
      })
    })

    it('reads as off once the row points somewhere else, whatever it stored', async () => {
      const row = await connector('research', 'https://mcp.exa.ai/mcp')
      await connectorReadsSet(db, orgId, row.id, true)
      await db
        .update(schema.connectors)
        .set({ config: { url: 'https://mcp.example.com/mcp', headers: {}, readsWithoutCard: true } })
        .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, row.id)))
      const moved = (await readConnector(db, orgId, row.id))!
      expect(connectorReadsState(moved)).toMatchObject({ eligible: false, on: false })
      expect(connectorReadsAllowed(moved).size).toBe(0)
    })
  })
})
