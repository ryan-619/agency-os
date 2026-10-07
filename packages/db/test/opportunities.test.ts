/**
 * Businesses as a customer finds them, what they need, and what the agency
 * sells (0022), against a real migrated database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { noSiteDomain, parseIcpDefinition, type SiteProfile } from '@agency/core'
import seed from '../seed/icp-security-gap-saas.json' with { type: 'json' }
import {
  CALL_TASK_NOTE, addBusinesses, companyOpportunity, opportunitiesAcross, recordScan, recordSiteAudit, schema,
  serviceCreate, serviceDelete, serviceUpdate, servicesAddSuggested, servicesList, tasksCreate, type AgencyDb,
  type BusinessToAdd,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')

describe('listings, audits, services and opportunities', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let icp: { id: string; definition: ReturnType<typeof parseIcpDefinition> }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    const [row] = await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true }).returning({ id: schema.icpProfiles.id })
    icp = { id: row!.id, definition: parseIcpDefinition(seed) }
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const business = (over: Partial<BusinessToAdd> = {}): BusinessToAdd => ({
    domain: noSiteDomain('Kumar Dental', 'ChIJkumar'),
    name: 'Kumar Dental',
    placeId: 'ChIJkumar',
    address: '12 CMH Road, Indiranagar, Bengaluru',
    phone: '+91 80 4123 4567',
    website: null,
    rating: 4.6,
    reviews: 12,
    category: 'dentist',
    mapsUrl: 'https://maps.google.com/?cid=1',
    timeZone: 'Asia/Kolkata',
    country: 'IN',
    city: 'Bengaluru',
    ...over,
  })
  const company = async (domain: string) =>
    (await db.select().from(schema.companies).where(eq(schema.companies.domain, domain)))[0]!

  describe('listings', () => {
    it('adds a business with its listing facts, dated, its phone as E.164, from Google Maps', async () => {
      const b = business()
      const r = await addBusinesses(db, { orgId, businesses: [b], checkedAt: NOW, actor: 'agent' })
      expect(r).toEqual({ added: [{ placeId: 'ChIJkumar', domain: b.domain, name: 'Kumar Dental' }], refreshed: [] })
      expect(await company(b.domain)).toMatchObject({
        source: 'google_maps', phone: '+918041234567', googleRating: '4.6', googleReviewCount: 12, googleCategory: 'dentist',
        listingCheckedAt: NOW, timeZone: 'Asia/Kolkata', city: 'Bengaluru',
      })
    })

    it('refreshes a place already here — by place id or by domain — rather than adding it twice', async () => {
      await addBusinesses(db, { orgId, businesses: [business()], checkedAt: NOW, actor: 'agent' })
      const later = new Date(NOW.getTime() + 86_400_000)
      const again = await addBusinesses(db, { orgId, businesses: [business({ rating: 4.8, reviews: 15 })], checkedAt: later, actor: 'agent' })
      expect(again.added).toEqual([])
      expect(again.refreshed).toHaveLength(1)
      const rows = await db.select().from(schema.companies).where(eq(schema.companies.orgId, orgId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ googleRating: '4.8', googleReviewCount: 15, listingCheckedAt: later })

      await db.insert(schema.companies).values({ orgId, domain: 'sharmaoptics.in', name: 'Sharma Optics' })
      const byDomain = await addBusinesses(db, {
        orgId, businesses: [business({ domain: 'sharmaoptics.in', name: 'Sharma Optics', placeId: 'ChIJsharma', website: 'https://sharmaoptics.in' })],
        checkedAt: NOW, actor: 'agent',
      })
      expect(byDomain.refreshed).toEqual([{ placeId: 'ChIJsharma', domain: 'sharmaoptics.in', name: 'Sharma Optics' }])
      expect((await company('sharmaoptics.in')).googlePlaceId).toBe('ChIJsharma')
    })

    it('stores no phone it cannot read as E.164, and holds a listing fact to its date in the database', async () => {
      const b = business({ phone: '080 4123 4567' })
      await addBusinesses(db, { orgId, businesses: [b], checkedAt: NOW, actor: 'agent' })
      expect((await company(b.domain)).phone).toBeNull()
      await expect(
        db.insert(schema.companies).values({ orgId, domain: 'x.in', googleRating: '4.0' }),
      ).rejects.toThrow()
      await expect(db.insert(schema.companies).values({ orgId, domain: 'y.in', phone: '08041234567' })).rejects.toThrow()
    })
  })

  describe('site audits', () => {
    it('stores a failure with its reason and no score — never a slow site', async () => {
      await addBusinesses(db, { orgId, businesses: [business({ domain: 'kumardental.in' })], checkedAt: NOW, actor: 'agent' })
      const c = await company('kumardental.in')
      const failed = await recordSiteAudit(db, {
        orgId, companyId: c.id, strategy: 'mobile', url: 'https://kumardental.in/', ranAt: NOW,
        result: { ok: false, error: 'the page did not load for Lighthouse', performance: 12, accessibility: null, bestPractices: null, seo: null, lcpMs: null, cls: null, tbtMs: null, fcpMs: null, fieldCategory: null },
      })
      expect(failed).toMatchObject({ ok: false, performance: null, error: 'the page did not load for Lighthouse' })
      await expect(
        db.insert(schema.siteAudits).values({ orgId, companyId: c.id, strategy: 'mobile', url: 'https://kumardental.in/', ok: false, error: 'x', performance: 10 }),
      ).rejects.toThrow()
    })
  })

  describe('the services catalogue', () => {
    it('creates, renames, prices, refuses a taken name or an upside-down range, and deletes', async () => {
      const r = await serviceCreate(db, {
        orgId, createdBy: userId, actor: userId,
        input: { name: 'New website', needs: ['no_website', 'website_is_a_profile'], priceFrom: 15000, priceTo: 40000, currency: 'inr' },
      })
      expect(r).toMatchObject({ ok: true, service: { name: 'New website', currency: 'INR', priceUnit: 'one_off' } })
      if (!r.ok) return
      expect(await serviceCreate(db, { orgId, createdBy: userId, actor: userId, input: { name: ' new WEBSITE ' } })).toMatchObject({
        ok: false, reason: 'name_taken',
      })
      expect(await serviceCreate(db, { orgId, createdBy: userId, actor: userId, input: { name: 'SEO', needs: ['made_up'] } })).toMatchObject({
        ok: false, reason: 'invalid',
      })
      expect(await serviceUpdate(db, { orgId, id: r.service.id, actor: userId, input: { priceTo: 100 } })).toMatchObject({
        ok: false, message: 'The top of the price range is below its bottom.',
      })
      expect(await serviceUpdate(db, { orgId, id: r.service.id, actor: userId, input: { name: 'Website build', priceUnit: 'monthly' } }))
        .toMatchObject({ ok: true, service: { name: 'Website build', priceUnit: 'monthly' } })
      expect(await serviceDelete(db, { orgId, id: r.service.id, actor: userId })).toEqual({ ok: true })
      expect(await servicesList(db, orgId)).toEqual([])
    })

    it('adds the suggested catalogue once, with no prices', async () => {
      expect((await servicesAddSuggested(db, { orgId, createdBy: userId, actor: userId })).added).toBe(10)
      expect((await servicesAddSuggested(db, { orgId, createdBy: userId, actor: userId })).added).toBe(0)
      const list = await servicesList(db, orgId)
      expect(list.every((s) => s.priceFrom === null && s.priceTo === null)).toBe(true)
    })
  })

  describe('opportunities', () => {
    const profile = (domain: string): SiteProfile => ({
      domain, company: 'Sharma Optics', fetchOk: true, hasLoginSurface: false, isSecurityVendor: false,
      mentionsSecurityHiring: false, outdatedLibs: [],
      observations: {
        mobile_viewport: { observed: true, gap: true, detail: 'no viewport tag: phones show the desktop layout, zoomed out', evidence: { viewport: 'absent' } },
        whatsapp_chat: { observed: true, gap: true, detail: 'no WhatsApp chat link on the homepage', evidence: { whatsappLinks: 0 } },
        page_title: { observed: true, gap: false, detail: '"Sharma Optics"', evidence: { title: 'Sharma Optics' } },
      },
    })

    it('reads a business’s needs from its listing and its latest scan, and matches the catalogue', async () => {
      await addBusinesses(db, { orgId, businesses: [business()], checkedAt: NOW, actor: 'agent' })
      await db.insert(schema.companies).values({ orgId, domain: 'sharmaoptics.in', name: 'Sharma Optics' })
      const sharma = await company('sharmaoptics.in')
      await recordScan(db, { orgId, companyId: sharma.id, icpProfile: icp, raw: {}, profile: profile('sharmaoptics.in') })

      const one = await companyOpportunity(db, { orgId, company: sharma, now: new Date() })
      expect(one.reading.needs.map((n) => n.key)).toEqual(['not_mobile_friendly', 'no_whatsapp'])
      // No catalogue yet: the suggestions, labelled as such.
      expect(one.services[0]).toMatchObject({ suggested: true })

      await serviceCreate(db, { orgId, createdBy: userId, actor: userId, input: { name: 'WhatsApp setup', needs: ['no_whatsapp'] } })
      const all = await opportunitiesAcross(db, { orgId, now: new Date() })
      // Two needs each: a tie, broken by domain.
      expect(all.results.map((o) => o.company.name)).toEqual(['Kumar Dental', 'Sharma Optics'])
      expect(all.results[1]!.services).toEqual([{ name: 'WhatsApp setup', answers: ['no_whatsapp'], suggested: false, id: expect.any(String) }])
      expect(all.results[0]!.reading.needs.map((n) => n.key)).toEqual(['no_website', 'few_reviews'])

      const whatsapp = await opportunitiesAcross(db, { orgId, now: new Date(), need: 'no_whatsapp' })
      expect(whatsapp.results.map((o) => o.company.name)).toEqual(['Sharma Optics'])
    })
  })

  describe('call and visit tasks', () => {
    it('makes a call task only for a company with a phone not on the suppression list, saying what to check first', async () => {
      await addBusinesses(db, { orgId, businesses: [business()], checkedAt: NOW, actor: 'agent' })
      const kumar = await company(business().domain)
      const call = await tasksCreate(db, { orgId, kind: 'call', title: 'Call Kumar Dental about a website', companyId: kumar.id, createdBy: userId, actor: userId })
      expect(call).toMatchObject({ ok: true, task: { kind: 'call' } })
      if (call.ok) expect(call.task.detail).toContain(CALL_TASK_NOTE)

      await db.insert(schema.suppressions).values({ orgId, kind: 'phone', value: '+918041234567', reason: 'asked not to be called', source: 'manual' })
      expect(await tasksCreate(db, { orgId, kind: 'call', title: 'Call again', companyId: kumar.id, createdBy: userId, actor: userId }))
        .toMatchObject({ ok: false, reason: 'suppressed' })

      await db.insert(schema.companies).values({ orgId, domain: 'nophone.in' })
      const nophone = await company('nophone.in')
      expect(await tasksCreate(db, { orgId, kind: 'call', title: 'Call', companyId: nophone.id, createdBy: userId, actor: userId }))
        .toMatchObject({ ok: false, reason: 'invalid', message: expect.stringMatching(/no phone number on record/) })
      expect(await tasksCreate(db, { orgId, kind: 'visit', title: 'Visit Kumar Dental', companyId: kumar.id, createdBy: userId, actor: userId }))
        .toMatchObject({ ok: true, task: { kind: 'visit' } })
    })
  })
})
