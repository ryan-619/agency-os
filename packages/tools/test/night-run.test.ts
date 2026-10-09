/**
 * The night shift's run (0025), with Google and the scanner faked and the
 * database real: saved searches run longest-ago first and within the daily
 * Places cap that chat shares, open businesses filed as add_businesses files
 * them, the new sites scanned and measured, and a morning list written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { parseIcpDefinition, type Observation, type SiteProfile } from '@agency/core'
import { appendAudit, nightReportLatest, nightSearchAdd, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import seed from '../../db/seed/icp-security-gap-saas.json' with { type: 'json' }
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import { runNightShift, type OpsScan, type PageSpeedClient, type PlaceListing, type PlacesClient } from '../src/index.js'

const NOW = new Date('2026-10-08T21:00:00.000Z')
const icp = parseIcpDefinition(seed)

const listing = (over: Partial<PlaceListing>): PlaceListing => ({
  placeId: 'p', name: 'A business', address: 'Indiranagar, Bengaluru', phone: '+91 80 4123 4567', website: null, rating: 4.2,
  reviews: 40, category: 'dentist', mapsUrl: 'https://maps.google.com/?cid=1', status: 'operational', location: { lat: 12.97, lng: 77.64 },
  ...over,
})

function reached(domain: string): SiteProfile {
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: key === 'csp', detail: key === 'csp' ? 'absent' : 'present', evidence: { header: key } }
  }
  return {
    domain, company: domain, title: domain, fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations,
  }
}

describe('the night shift’s run', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  const searched: string[] = []
  const scanned: string[] = []
  const measured: string[] = []

  const places = (pages: Record<string, readonly PlaceListing[]>, dailyLimit = 30): PlacesClient => ({
    dailyLimit,
    async search({ query }) {
      searched.push(query)
      if (query.includes('broken')) throw new Error('PERMISSION_DENIED')
      return { places: pages[query] ?? [], nextPageToken: null }
    },
  })
  const scan: OpsScan = async (domain) => {
    scanned.push(domain)
    return { raw: { fake: true }, profile: reached(domain) }
  }
  const pagespeed: PageSpeedClient = {
    async run({ url }: { url: string }) {
      measured.push(url)
      return { ok: true, performance: 31, accessibility: 90, bestPractices: 80, seo: 70, lcpMs: 6100, cls: 0.1, tbtMs: 900, fcpMs: 2500, fieldCategory: null }
    },
  } as unknown as PageSpeedClient

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    searched.length = 0
    scanned.length = 0
    measured.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const save = (query: string, city: string | null = 'Bengaluru') => nightSearchAdd(db, { orgId, query, region: 'IN', city, createdBy: ownerId, actor: ownerId })
  const run = (p: PlacesClient) => runNightShift({ db, orgId, localDate: '2026-10-09', now: () => NOW, places: p, pagespeed, scan })

  it('files the open businesses, scans and measures the new sites, and writes the morning list', async () => {
    await save('dentists in Indiranagar, Bengaluru')
    const r = await run(places({
      'dentists in Indiranagar, Bengaluru': [
        listing({ placeId: 'p1', name: 'Smile Dental', website: 'https://smiledental.in' }),
        listing({ placeId: 'p2', name: 'Kumar Dental', website: 'https://www.facebook.com/kumardental', reviews: 120 }),
        listing({ placeId: 'p3', name: 'Closed Dental', status: 'closed_permanently' }),
      ],
    }))
    expect(r).toMatchObject({ searches: 1, failedSearches: 0, found: 2, added: 2, scanned: 1, audited: 1, why: null })
    expect(scanned).toEqual(['smiledental.in'])
    expect(measured).toEqual(['https://smiledental.in/'])
    const rows = await db.select().from(schema.companies).where(eq(schema.companies.orgId, orgId))
    expect(rows.map((c) => c.name).sort()).toEqual(['Kumar Dental', 'Smile Dental'])
    expect(rows.every((c) => c.source === 'google_maps' && c.city === 'Bengaluru' && c.timeZone === 'Asia/Kolkata')).toBe(true)
    const report = await nightReportLatest(db, orgId)
    expect(report).toMatchObject({ date: '2026-10-09', searches: 1, added: 2, scanned: 1, audited: 1 })
    // Smile Dental's site was scanned and measured — slow on a phone, a security gap — so more is known that
    // it needs than Kumar Dental's one need (a Facebook page for a website): more needs, higher on the list.
    expect(report!.top.map((c) => c.name)).toEqual(['Smile Dental', 'Kumar Dental'])
    const kumar = report!.top[1]!
    expect(report!.needs.get(kumar.id)).toContain('website_is_a_profile')
    const [searchedRow] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'night.searched'))
    expect(searchedRow).toMatchObject({ actor: 'night_shift' })
    expect(searchedRow!.detail).toMatchObject({ returned: 3, added: 2 })
  })

  it('stays inside the daily Places cap chat shares, and a search Google refuses costs only that search', async () => {
    await save('broken search')
    await save('bakeries in Pune', 'Pune')
    await save('plumbers in Pune', 'Pune')
    // Chat has already made 29 of today's 30 searches.
    for (let i = 0; i < 29; i++) {
      await appendAudit(db, { orgId, actor: 'agent', action: 'agent.find_businesses', subjectType: 'org', subjectId: orgId, detail: { returned: 0 } })
    }
    const capped = await run(places({}, 30))
    expect(capped).toMatchObject({ searches: 1 })
    expect(searched).toEqual(['broken search'])

    searched.length = 0
    const r = await run(places({ 'bakeries in Pune': [listing({ placeId: 'b1', name: 'Sri Krishna Bakery', category: 'bakery' })] }, 100))
    expect(searched).toEqual(['bakeries in Pune', 'plumbers in Pune', 'broken search'])
    expect(r).toMatchObject({ failedSearches: 1, added: 1, scanned: 0 })
  })

  it('says why when there is nothing to search', async () => {
    expect(await run(places({}))).toMatchObject({ searches: 0, why: 'no_searches' })
    expect(await nightReportLatest(db, orgId)).toMatchObject({ searches: 0, added: 0 })
  })
})
