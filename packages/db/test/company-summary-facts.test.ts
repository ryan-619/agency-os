/**
 * The facts the company page's "At a glance" card reads (2026-10-16),
 * against a real migrated database.
 *
 * The rule worth a database for: the latest scan is read ONCE, so the
 * posture and the needs are about the same row — and the needs are exactly
 * the needs card's (`companyOpportunity`) for the same rows. Then the edges:
 * a failed latest scan over an older good one, a placeholder whose listing
 * now names a site of its own, a profile that does not parse, another org's
 * rows, and a read that writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, count, eq } from 'drizzle-orm'
import { DEFAULT_STALE_AFTER_DAYS, companySummary, noSiteDomain, parseIcpDefinition, type SiteProfile } from '@agency/core'
import seed from '../seed/icp-security-gap-saas.json' with { type: 'json' }
import {
  companyOpportunity, companySummaryFacts, recordScan, recordSiteAudit, schema, serviceCreate, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const DAY = 86_400_000

describe('companySummaryFacts', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let icpId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    icpId = (await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true }).returning({ id: schema.icpProfiles.id }))[0]!.id
    companyId = (
      await db
        .insert(schema.companies)
        .values({ orgId, domain: 'sharmaoptics.in', name: 'Sharma Optics', industry: 'retail', city: 'Pune', country: 'IN', headcount: 12, headcountSource: 'their about page' })
        .returning({ id: schema.companies.id })
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const profile: SiteProfile = {
    domain: 'sharmaoptics.in', company: 'Sharma Optics', fetchOk: true, hasLoginSurface: true, isSecurityVendor: false,
    mentionsSecurityHiring: false, outdatedLibs: [],
    observations: {
      csp: { observed: true, gap: true, detail: 'no Content-Security-Policy header', evidence: { header: 'absent' } },
      hsts: { observed: true, gap: false, detail: 'max-age=31536000', evidence: { header: 'max-age=31536000' } },
      // Informational: observed, recorded, not in the ICP — never a gap.
      cross_origin_policies: { observed: true, gap: true, detail: 'no cross-origin isolation headers', evidence: { coop: 'absent' } },
      // Website presence: a need, never a gap.
      mobile_viewport: { observed: true, gap: true, detail: 'no viewport tag: phones show the desktop layout, zoomed out', evidence: { viewport: 'absent' } },
    },
  }
  const icp = () => ({ id: icpId, definition: parseIcpDefinition(seed) })
  const company = async () => (await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)))[0]!

  it('reads the latest scan once: the posture and the needs are about the same row, and the needs are the needs card’s', async () => {
    await recordScan(db, { orgId, companyId, icpProfile: icp(), raw: {}, profile })
    const now = new Date()
    await recordSiteAudit(db, {
      orgId, companyId, strategy: 'mobile', url: 'https://sharmaoptics.in/', ranAt: now,
      result: { ok: true, error: null, performance: 31, accessibility: 90, bestPractices: 90, seo: 95, lcpMs: 6200, cls: 0.01, tbtMs: 300, fcpMs: 2100, fieldCategory: null },
    })
    await db.insert(schema.companyResearch).values({ orgId, companyId, claim: 'They opened a second store in 2025.', sourceUrl: 'https://example.com/news' })

    const facts = await companySummaryFacts(db, { orgId, companyId, now })
    expect(facts).not.toBeNull()
    const [latest] = await db.select({ id: schema.scans.id, ranAt: schema.scans.ranAt }).from(schema.scans).where(eq(schema.scans.companyId, companyId))
    expect(facts!.scan?.id).toBe(latest!.id)
    // Every need the scan shows is dated by THAT scan.
    for (const n of facts!.needs.needs.filter((x) => x.source === 'scan')) expect(n.asOf).toEqual(latest!.ranAt)
    expect(facts!.needs).toEqual((await companyOpportunity(db, { orgId, company: await company(), now })).reading)
    expect(facts!.needs.needs.map((n) => n.key)).toEqual(['not_mobile_friendly', 'slow_site', 'security_gaps'])
    expect(facts!.score).toMatchObject({ qualified: expect.any(Boolean) })
    expect(facts!.staleAfterDays).toBe(14)
    expect(facts!.researchCount).toBe(1)
    expect(facts!.recorded).toEqual({ industry: 'retail', city: 'Pune', country: 'IN', stage: null, headcount: 12, headcountSource: 'their about page' })
    // No catalogue yet: the suggestions, labelled.
    expect(facts!.services.length).toBeGreaterThan(0)
    expect(facts!.services.every((s) => s.suggested)).toBe(true)

    const card = companySummary(facts!, now)
    expect(card.evidence).toBe('current')
    expect(card.scanId).toBe(latest!.id)
    expect(card.lines.filter((l) => l.kind === 'gaps').map((l) => l.text)).toEqual([
      `Gap observed ${latest!.ranAt.toISOString().slice(0, 10)}: ${seed.signals.csp.why}`,
    ])
    expect(card.lines.find((l) => l.kind === 'in_place')?.text).toMatch(/: hsts$/)
  })

  it('carries `scored`, so an informational row is never a gap', async () => {
    await recordScan(db, { orgId, companyId, icpProfile: icp(), raw: {}, profile })
    const now = new Date()
    const facts = (await companySummaryFacts(db, { orgId, companyId, now }))!
    expect(facts.scan!.findings.find((f) => f.signalKey === 'cross_origin_policies')).toMatchObject({ scored: false, weight: 0, gap: true })
    expect(facts.scan!.findings.find((f) => f.signalKey === 'csp')).toMatchObject({ scored: true, gap: true })
    const text = companySummary(facts, now).lines.map((l) => l.text).join('\n')
    expect(text).not.toContain('cross_origin')
    expect(text).not.toContain('cross-origin')
    expect(text).not.toContain('mobile_viewport')
  })

  it('a failed latest scan over an older good one reads as unreachable: no gaps, and the dated site_down need', async () => {
    const NOW = new Date('2026-10-16T09:00:00.000Z')
    const older = (await db.insert(schema.scans).values({ orgId, companyId, ranAt: new Date(NOW.getTime() - 3 * DAY), ok: true }).returning({ id: schema.scans.id }))[0]!.id
    await db.insert(schema.findings).values({
      orgId, scanId: older, companyId, signalKey: 'csp', observed: true, gap: true, weight: 15, detail: 'absent', evidence: { header: 'absent' },
    })
    const failedAt = new Date(NOW.getTime() - DAY)
    const failed = (await db.insert(schema.scans).values({ orgId, companyId, ranAt: failedAt, ok: false, error: 'timeout' }).returning({ id: schema.scans.id }))[0]!.id

    const facts = (await companySummaryFacts(db, { orgId, companyId, now: NOW }))!
    expect(facts.scan).toMatchObject({ id: failed, ok: false, findings: [] })
    const card = companySummary(facts, NOW)
    expect(card.evidence).toBe('unreachable')
    expect(card.lines.filter((l) => l.kind === 'gaps')).toEqual([])
    expect(facts.needs.needs.map((n) => n.key)).toEqual(['site_down'])
    expect(card.lines.filter((l) => l.kind === 'needs').map((l) => l.text)).toEqual(['Need: Site did not load (scan, 2026-10-15)'])
  })

  // `addBusinesses` refreshes a listing found again by place id and keeps
  // the domain, so a business filed when its listing named no website keeps
  // the placeholder after the owner adds one to Google.
  it('a placeholder whose listing now names a site of its own is never called website-less', async () => {
    const NOW = new Date('2026-10-16T09:00:00.000Z')
    const domain = noSiteDomain('Sharma Optics Camp', 'place:ChIJsharma')
    const placeholder = (
      await db
        .insert(schema.companies)
        .values({
          orgId, domain, name: 'Sharma Optics Camp', source: 'google_maps', googlePlaceId: 'ChIJsharma',
          listingCheckedAt: new Date(NOW.getTime() - 2 * DAY), listingWebsite: 'https://sharmaopticscamp.in/',
          googleRating: '4.5', googleReviewCount: 80, googleCategory: 'optician',
        })
        .returning({ id: schema.companies.id })
    )[0]!.id

    const facts = (await companySummaryFacts(db, { orgId, companyId: placeholder, now: NOW }))!
    expect(facts.needs.website).toMatchObject({ kind: 'own', host: 'sharmaopticscamp.in' })
    const card = companySummary(facts, NOW)
    expect(card.evidence).toBe('no_site')
    expect(card.headline).toMatch(/^Filed without a website, but its Google listing names one \(sharmaopticscamp\.in\);/)
    const text = [card.headline, ...card.lines.map((l) => l.text)].join('\n')
    expect(text).not.toMatch(/no website of its own|lists no website/i)
    // Nor is the placeholder printed.
    expect(text).not.toContain('nosite.invalid')
  })

  it('reads the open deal’s health as get_pipeline does, and no deal as none', async () => {
    const now = new Date()
    expect((await companySummaryFacts(db, { orgId, companyId, now }))!.deal).toBeNull()

    await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted' })
    await db.insert(schema.touches).values({
      orgId, companyId, channel: 'email', direction: 'in', status: 'replied', body: 'tell me more', recipient: 'owner@sharmaoptics.in',
    })
    const facts = (await companySummaryFacts(db, { orgId, companyId, now }))!
    expect(facts.deal?.stage).toBe('contacted')
    expect(facts.deal?.health?.level).toBe('act')
    expect(facts.deal?.health?.reasons).toContain('a reply is waiting unanswered')
    expect(companySummary(facts, now).lines.find((l) => l.kind === 'deal')?.text).toMatch(/^Deal: contacted — needs a person: a reply is waiting unanswered/)
  })

  it('answers null for another org’s company, and reads none of another org’s rows', async () => {
    const other = (await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id }))[0]!.id
    const otherUser = (await db.insert(schema.users).values({ orgId: other, email: 'o@other.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    const theirs = (await db.insert(schema.companies).values({ orgId: other, domain: 'theirs.in' }).returning({ id: schema.companies.id }))[0]!.id
    await db.insert(schema.icpProfiles).values({ orgId: other, name: 'Theirs', definition: { ...seed, freshness: { stale_after_days: 3 } }, active: true })
    await serviceCreate(db, { orgId: other, createdBy: otherUser, actor: otherUser, input: { name: 'Their security work', needs: ['security_gaps'] } })
    await recordScan(db, { orgId, companyId, icpProfile: icp(), raw: {}, profile })

    const now = new Date()
    expect(await companySummaryFacts(db, { orgId, companyId: theirs, now })).toBeNull()
    expect(await companySummaryFacts(db, { orgId: other, companyId, now })).toBeNull()
    const facts = (await companySummaryFacts(db, { orgId, companyId, now }))!
    // Our profile's threshold and signals, and no catalogue of theirs.
    expect(facts.staleAfterDays).toBe(14)
    expect(Object.keys(facts.signals)).toContain('csp')
    expect(facts.services.map((s) => s.name)).not.toContain('Their security work')
    expect(facts.services.every((s) => s.suggested)).toBe(true)
  })

  it('reads a profile that does not parse as no profile: no signals, the default threshold', async () => {
    // A weight of 0 is refused by parseIcpDefinition; the 30 days beside it must not be used.
    await db
      .update(schema.icpProfiles)
      .set({ definition: { ...seed, signals: { csp: { weight: 0, why: 'x' } }, freshness: { stale_after_days: 30 } } })
      .where(and(eq(schema.icpProfiles.orgId, orgId), eq(schema.icpProfiles.id, icpId)))
    const facts = (await companySummaryFacts(db, { orgId, companyId, now: new Date() }))!
    expect(facts.signals).toEqual({})
    expect(facts.staleAfterDays).toBe(DEFAULT_STALE_AFTER_DAYS)
  })

  it('writes nothing: no audit row for reading it', async () => {
    await recordScan(db, { orgId, companyId, icpProfile: icp(), raw: {}, profile })
    await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted' })
    const audits = async () => (await db.select({ n: count() }).from(schema.auditLog))[0]!.n
    const before = await audits()
    await companySummaryFacts(db, { orgId, companyId, now: new Date() })
    expect(await audits()).toBe(before)
  })
})
