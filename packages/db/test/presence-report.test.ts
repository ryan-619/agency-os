/**
 * A business's own audit page (2026-10-08): how each comparison fact is read
 * from what was recorded — the scanner's own words, pinned — and the page's
 * whole reading against a real migrated database: its nearest competitors of
 * the same category, never a stale listing or another kind of business, and
 * the services that answer what it needs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { noSiteDomain } from '@agency/core'
import seed from '../seed/icp-security-gap-saas.json' with { type: 'json' }
import { peerFactsOf, presenceReport, schema, serviceCreate, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const DAY = 86_400_000
type Company = typeof schema.companies.$inferSelect
type Audit = typeof schema.siteAudits.$inferSelect

const company = (over: Partial<Company> = {}): Company =>
  ({
    id: 'c1', orgId: 'o', domain: noSiteDomain('Kumar Dental', 'p1'), name: 'Kumar Dental', googleCategory: 'dentist',
    city: 'Bengaluru', latitude: null, longitude: null, listingCheckedAt: new Date(NOW.getTime() - DAY), listingWebsite: null,
    googleRating: '4.1', googleReviewCount: 12, ...over,
  }) as Company
const finding = (signalKey: string, observed: boolean, gap: boolean | null, detail: string | null = null) => ({ signalKey, observed, gap, detail })
const scan = (findings: ReturnType<typeof finding>[], over: { ok?: boolean; ranAt?: Date } = {}) =>
  ({ id: 's1', companyId: 'c1', ranAt: over.ranAt ?? new Date(NOW.getTime() - DAY), ok: over.ok ?? true, findings })
const audit = (over: Partial<Audit> = {}): Audit =>
  ({ id: 'a1', companyId: 'c1', strategy: 'mobile', ok: true, performance: 41, ranAt: new Date(NOW.getTime() - DAY), ...over }) as Audit

describe('the audit page', () => {
  describe('one business, as the comparison reads it', () => {
    it('reads a website of its own from the domain, or from a listing that names one — never from no listing', () => {
      expect(peerFactsOf(company({ domain: 'kumardental.in' }), null, null, 14, NOW).ownWebsite).toBe(true)
      expect(peerFactsOf(company(), null, null, 14, NOW).ownWebsite).toBe(false)
      expect(peerFactsOf(company({ listingWebsite: 'https://www.facebook.com/kumardental' }), null, null, 14, NOW).ownWebsite).toBe(false)
      expect(peerFactsOf(company({ listingWebsite: 'https://kumardental.in' }), null, null, 14, NOW).ownWebsite).toBe(true)
      expect(peerFactsOf(company({ listingCheckedAt: null }), null, null, 14, NOW).ownWebsite).toBeNull()
    })

    it('reads the presence signals in the scanner’s own words, and nothing from a stale or failed scan', () => {
      const s = scan([
        finding('mobile_viewport', true, false, 'viewport tag present'),
        finding('whatsapp_chat', true, true, 'no WhatsApp link found on the homepage'),
        finding('booking_or_store', true, false, 'no online booking, ordering or store found on the homepage'),
      ])
      expect(peerFactsOf(company(), s, null, 14, NOW)).toMatchObject({ mobileFriendly: true, whatsapp: false, onlineBooking: false })
      const booking = scan([finding('booking_or_store', true, false, 'online booking found: practo.com')])
      expect(peerFactsOf(company(), booking, null, 14, NOW).onlineBooking).toBe(true)
      // Not observed is not known; and a scan past its deadline, or one that failed, says nothing.
      const unread = scan([finding('mobile_viewport', false, null, 'the page was cut off before its end')])
      expect(peerFactsOf(company(), unread, null, 14, NOW).mobileFriendly).toBeNull()
      expect(peerFactsOf(company(), { ...s, ranAt: new Date(NOW.getTime() - 20 * DAY) }, null, 14, NOW)).toMatchObject({
        mobileFriendly: null, whatsapp: null, onlineBooking: null,
      })
      expect(peerFactsOf(company(), { ...s, ok: false, findings: [] }, null, 14, NOW).mobileFriendly).toBeNull()
    })

    it('takes a speed score only from a current, successful mobile audit', () => {
      expect(peerFactsOf(company(), null, audit(), 14, NOW).speedScore).toBe(41)
      expect(peerFactsOf(company(), null, audit({ strategy: 'desktop' }), 14, NOW).speedScore).toBeNull()
      expect(peerFactsOf(company(), null, audit({ ok: false, performance: null }), 14, NOW).speedScore).toBeNull()
      expect(peerFactsOf(company(), null, audit({ ranAt: new Date(NOW.getTime() - 30 * DAY) }), 14, NOW).speedScore).toBeNull()
    })
  })

  describe('the whole page', () => {
    let test: TestDb
    let db: AgencyDb
    let orgId: string
    let subjectId: string

    beforeEach(async () => {
      test = await migratedDb()
      db = drizzle(test.pg, { schema }) as unknown as AgencyDb
      const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
      orgId = org!.id
      const ownerId = (await db.insert(schema.users).values({ orgId, email: 'o@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
      await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true })
      const listed = new Date(NOW.getTime() - DAY)
      const at = (lat: number, lng: number) => ({ latitude: lat, longitude: lng, listingCheckedAt: listed })
      const rows = await db
        .insert(schema.companies)
        .values([
          { orgId, domain: noSiteDomain('Kumar Dental', 'p0'), name: 'Kumar Dental', googleCategory: 'dentist', googleRating: '3.9', googleReviewCount: 8, city: 'Bengaluru', ...at(12.9784, 77.6408) },
          // Two dentists within a kilometre or two, with sites of their own.
          { orgId, domain: 'smiledental.in', name: 'Smile Dental', googleCategory: 'dentist', googleRating: '4.7', googleReviewCount: 310, ...at(12.9790, 77.6440) },
          { orgId, domain: 'brightteeth.in', name: 'Bright Teeth', googleCategory: 'dentist', googleRating: '4.4', googleReviewCount: 95, ...at(12.9700, 77.6500) },
          // Too far, another kind of business, and a listing read too long ago.
          { orgId, domain: 'mysore-dental.in', name: 'Mysore Dental', googleCategory: 'dentist', googleRating: '4.9', googleReviewCount: 40, ...at(12.2958, 76.6394) },
          { orgId, domain: 'cornerbakery.in', name: 'Corner Bakery', googleCategory: 'bakery', googleRating: '4.8', googleReviewCount: 200, ...at(12.9785, 77.6409) },
          { orgId, domain: 'olddental.in', name: 'Old Dental', googleCategory: 'dentist', googleRating: '5.0', googleReviewCount: 3, latitude: 12.9786, longitude: 77.6410, listingCheckedAt: new Date(NOW.getTime() - 120 * DAY) },
        ])
        .returning({ id: schema.companies.id, name: schema.companies.name })
      subjectId = rows.find((r) => r.name === 'Kumar Dental')!.id
      await serviceCreate(db, { orgId, input: { name: 'New website', needs: ['no_website'], priceFrom: 15_000 }, actor: ownerId, createdBy: ownerId })
      await serviceCreate(db, { orgId, input: { name: 'App development', needs: [], priceFrom: 200_000 }, actor: ownerId, createdBy: ownerId })
    }, 30_000)

    afterEach(async () => {
      await test?.close()
    })

    it('compares it with its nearest current competitors of its kind, never named, and offers what answers its needs', async () => {
      const report = await presenceReport(db, { orgId, companyId: subjectId, now: NOW })
      expect(report).not.toBeNull()
      expect(report!.peers.map((p) => p.km !== null && p.km < 2)).toEqual([true, true])
      expect(report!.headline).toBe('You are #3 of 3 similar businesses near you by Google rating; 2 of the 2 others have a website of their own.')
      expect(report!.rows[0]).toEqual({ label: 'Google rating', subject: '★3.9 (8 reviews)', peers: ['★4.7 (310 reviews)', '★4.4 (95 reviews)'] })
      expect(report!.rows.find((r) => r.label === 'Website of its own')).toEqual({ label: 'Website of its own', subject: 'no', peers: ['yes', 'yes'] })
      // Nothing scanned: an unknown is "not checked", never a "no".
      expect(report!.rows.find((r) => r.label === 'WhatsApp button')!.peers).toEqual(['not checked', 'not checked'])
      expect(JSON.stringify(report!.rows)).not.toMatch(/Smile|Bright|Mysore|Bakery|Old Dental/)
      expect(report!.needs.map((n) => n.key)).toContain('no_website')
      expect(report!.services.map((s) => s.service.name)).toEqual(['New website'])
    })

    it('is nothing for a company of another org, or none at all', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      expect(await presenceReport(db, { orgId: other!.id, companyId: subjectId, now: NOW })).toBeNull()
      expect(await presenceReport(db, { orgId, companyId: '00000000-0000-4000-8000-000000000009', now: NOW })).toBeNull()
    })
  })
})
