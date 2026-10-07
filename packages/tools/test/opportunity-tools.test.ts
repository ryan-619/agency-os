/**
 * Finding businesses and what they need, through the tools the agent calls
 * (2026-10-08): find_businesses, add_businesses, audit_website,
 * get_opportunities, list_services and create_task's call kind — with fake
 * Google clients that record and never reach Google.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { isNoSiteDomain } from '@agency/core'
import { appendAudit, serviceCreate, type AgencyDb, type SiteAuditResult } from '@agency/db'
import * as schema from '@agency/db/schema'
import seed from '../../db/seed/icp-security-gap-saas.json' with { type: 'json' }
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  addBusinessesTool, createTask, findBusinesses, forgetListings, forgetRunningAudits, getOpportunities, listServices,
  makeAuditWebsite, type AgencyToolSpec, type PageSpeedClient, type PlaceListing, type PlacesClient, type ToolContext,
  type ToolOutcome,
} from '../src/index.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')

const listing = (over: Partial<PlaceListing> = {}): PlaceListing => ({
  placeId: 'ChIJkumar', name: 'Kumar Dental Clinic', address: '12 CMH Road, Indiranagar, Bengaluru', phone: '+91 80 4123 4567',
  website: null, rating: 4.6, reviews: 12, category: 'dentist', mapsUrl: 'https://maps.google.com/?cid=1', status: 'operational',
  ...over,
})

const MEASURED: SiteAuditResult = {
  ok: true, error: null, performance: 34, accessibility: 91, bestPractices: 80, seo: 70, lcpMs: 5800, cls: 0.05,
  tbtMs: 600, fcpMs: 2400, fieldCategory: null,
}

describe('the opportunity tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []
  const searches: string[] = []

  const places = (found: readonly PlaceListing[], dailyLimit = 30): PlacesClient => ({
    dailyLimit,
    async search(args) {
      searches.push(args.query)
      return { places: found, nextPageToken: null }
    },
  })

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    searches.length = 0
    forgetListings()
    forgetRunningAudits()
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'priya@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: ownerId, orgId, role: 'owner' },
    turnId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }

  describe('find_businesses', () => {
    it('says how to switch Maps search on, when the worker holds no key', async () => {
      const r = await run(findBusinesses, { query: 'dentists in Indiranagar' })
      expect(r).toMatchObject({ ok: false, code: 'unreachable', message: expect.stringMatching(/run-worker\.sh --google/) })
    })

    it('reads each listing — website or not — and marks what is already here', async () => {
      await db.insert(schema.companies).values({ orgId, domain: 'smiledental.in', name: 'Smile Dental' })
      const found = [
        listing(),
        listing({ placeId: 'ChIJsmile', name: 'Smile Dental', website: 'https://www.smiledental.in/' }),
        listing({ placeId: 'ChIJfb', name: 'Raj Dental', website: 'https://facebook.com/rajdental', phone: null }),
        listing({ placeId: 'ChIJgone', name: 'Old Clinic', status: 'closed_permanently' }),
      ]
      const summary = summaryOf(await run(findBusinesses, { query: 'dentists in Indiranagar' }, { places: places(found) }))
      expect(summary).toMatch(/^Google Maps, "dentists in Indiranagar": 4 businesses, 3 without a website of their own\. 29 of today's 30 searches left\./)
      expect(summary).toMatch(/1\. Kumar Dental Clinic — dentist — 12 CMH Road, Indiranagar, Bengaluru — no website — ★4\.6 \(12 reviews\) — phone listed · place ChIJkumar/)
      expect(summary).toMatch(/Smile Dental — .* — website smiledental\.in — .* — already in the CRM as smiledental\.in/)
      expect(summary).toMatch(/Raj Dental — .* — website is a Facebook page \(facebook\.com\) — .* — no phone listed/)
      expect(summary).toMatch(/Old Clinic — .*PERMANENTLY CLOSED — skip/)
      expect(summary).toMatch(/Nothing was added/)
      expect(audited).toEqual([{ action: 'agent.find_businesses', detail: { returned: 4, withoutWebsite: 3, more: false } }])
    })

    it('stops at the daily cap, before asking Google', async () => {
      await appendAudit(db, { orgId, actor: 'agent', action: 'agent.find_businesses', subjectType: 'chat_session', subjectId: null, detail: {} })
      await appendAudit(db, { orgId, actor: 'agent', action: 'agent.find_businesses', subjectType: 'chat_session', subjectId: null, detail: {} })
      const r = await run(findBusinesses, { query: 'gyms in Pune' }, { places: places([listing()], 2), now: () => new Date() })
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Today's 2 Google Maps searches are used up/) })
      expect(searches).toEqual([])
    })
  })

  describe('add_businesses', () => {
    it('files a found business with no website under a placeholder, and one with a site by its domain', async () => {
      await run(findBusinesses, { query: 'dentists' }, {
        places: places([listing(), listing({ placeId: 'ChIJsmile', name: 'Smile Dental', website: 'https://www.smiledental.in/' })]),
      })
      const summary = summaryOf(
        await run(addBusinessesTool, { placeIds: ['ChIJkumar', 'ChIJsmile', 'ChIJunknown'], timeZone: 'Asia/Kolkata', country: 'India', city: 'Bengaluru' }),
      )
      expect(summary).toMatch(/Added 2 businesses from Google Maps\./)
      expect(summary).toMatch(/Kumar Dental Clinic — no website of its own \(filed as kumar-dental-clinic-[0-9a-z]{6}\.nosite\.invalid\)/)
      expect(summary).toMatch(/Smile Dental — smiledental\.in/)
      expect(summary).toMatch(/Not from a recent search, so not added: ChIJunknown/)
      expect(summary).toMatch(/scan_company and audit_website for the 1 with a website/)
      const rows = await db.select().from(schema.companies).where(eq(schema.companies.orgId, orgId))
      const kumar = rows.find((r) => r.name === 'Kumar Dental Clinic')!
      expect(isNoSiteDomain(kumar.domain)).toBe(true)
      expect(kumar).toMatchObject({ source: 'google_maps', phone: '+918041234567', timeZone: 'Asia/Kolkata', city: 'Bengaluru' })
    })

    it('adds nothing from place ids no recent search returned', async () => {
      const r = await run(addBusinessesTool, { placeIds: ['ChIJnever'] })
      expect(r).toMatchObject({ ok: false, code: 'not_found' })
    })
  })

  describe('audit_website', () => {
    const pagespeed = (result: SiteAuditResult | 'throw' | 'slow'): PageSpeedClient => ({
      async run() {
        if (result === 'throw') throw new Error('PageSpeed’s shared quota is used up')
        if (result === 'slow') return new Promise<SiteAuditResult>((resolve) => setTimeout(() => resolve(MEASURED), 400))
        return result
      },
    })

    beforeEach(async () => {
      await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental' })
    })

    it('records what PageSpeed measured, and says it', async () => {
      const summary = summaryOf(await run(makeAuditWebsite(), { domain: 'kumardental.in' }, { pagespeed: pagespeed(MEASURED) }))
      expect(summary).toMatch(/performance 34\/100 · SEO 70\/100 · accessibility 91\/100/)
      expect(summary).toMatch(/main content shown after 5\.8 s/)
      const [row] = await db.select().from(schema.siteAudits)
      expect(row).toMatchObject({ ok: true, performance: 34, strategy: 'mobile', url: 'https://kumardental.in/' })
    })

    it('records a page Google could not load as a failed audit, and says it is not a slow site', async () => {
      const failed: SiteAuditResult = { ...MEASURED, ok: false, error: 'Lighthouse could not load the page (NO_FCP)', performance: null, seo: null, accessibility: null, bestPractices: null, lcpMs: null, cls: null, tbtMs: null, fcpMs: null }
      const summary = summaryOf(await run(makeAuditWebsite(), { domain: 'kumardental.in' }, { pagespeed: pagespeed(failed) }))
      expect(summary).toMatch(/recorded as a failed audit — not a slow site/)
      const [row] = await db.select().from(schema.siteAudits)
      expect(row).toMatchObject({ ok: false, performance: null })
    })

    it('records nothing when the service fails, and says a run still going records itself', async () => {
      expect(await run(makeAuditWebsite(), { domain: 'kumardental.in' }, { pagespeed: pagespeed('throw') })).toMatchObject({
        ok: false, code: 'unreachable',
      })
      expect(await db.select().from(schema.siteAudits)).toEqual([])
      const slow = summaryOf(await run(makeAuditWebsite({ deadlineMs: 50 }), { domain: 'kumardental.in' }, { pagespeed: pagespeed('slow') }))
      expect(slow).toMatch(/still measuring kumardental\.in/)
      await new Promise((r) => setTimeout(r, 600))
      expect(await db.select().from(schema.siteAudits)).toHaveLength(1)
    })

    it('refuses a business with no website of its own', async () => {
      await run(findBusinesses, { query: 'dentists' }, { places: places([listing()]) })
      await run(addBusinessesTool, { placeIds: ['ChIJkumar'] })
      const [kumar] = (await db.select().from(schema.companies)).filter((c) => isNoSiteDomain(c.domain))
      expect(await run(makeAuditWebsite(), { domain: kumar!.domain }, { pagespeed: pagespeed(MEASURED) })).toMatchObject({
        ok: false, message: expect.stringMatching(/has no website of its own to measure/),
      })
    })
  })

  describe('get_opportunities and list_services', () => {
    it('reads one business’s needs with dated evidence and the services that answer them', async () => {
      await run(findBusinesses, { query: 'dentists' }, { places: places([listing()]) })
      await run(addBusinessesTool, { placeIds: ['ChIJkumar'] })
      const [kumar] = await db.select().from(schema.companies)
      await serviceCreate(db, {
        orgId, createdBy: ownerId, actor: ownerId,
        input: { name: 'New website', needs: ['no_website'], priceFrom: 15000, priceTo: 40000, currency: 'INR' },
      })
      const summary = summaryOf(await run(getOpportunities, { domain: kumar!.domain }))
      expect(summary).toMatch(/Kumar Dental Clinic \(no website of its own\) — website: no website\./)
      expect(summary).toMatch(/Google listing \(read 2026-10-08\): dentist · ★4\.6 from 12 reviews · phone on record/)
      expect(summary).toMatch(/• No website\n\s+Google Maps lists no website for them \(read 2026-10-08\)\./)
      expect(summary).toMatch(/• New website — answers no website — INR 15,000–40,000 one-off/)
    })

    it('ranks the CRM, and filters by a need', async () => {
      await run(findBusinesses, { query: 'dentists' }, { places: places([listing(), listing({ placeId: 'ChIJb', name: 'B Clinic', reviews: 300 })]) })
      await run(addBusinessesTool, { placeIds: ['ChIJkumar', 'ChIJb'] })
      const all = summaryOf(await run(getOpportunities, {}))
      expect(all).toMatch(/^2 of the 2 companies read show a need; the most first:/)
      // The service answering BOTH needs fits best.
      expect(all).toMatch(/1\. Kumar Dental Clinic \(no website of its own\) — needs: no website, few google reviews — fits: Google Business Profile and reviews \(suggested\)/)
      const few = summaryOf(await run(getOpportunities, { need: 'few_reviews' }))
      expect(few).toMatch(/^1 of the 2 companies read show a need \(few google reviews\)/)
    })

    it('lists the catalogue, and says how to start one when there is none', async () => {
      expect(summaryOf(await run(listServices, {}))).toMatch(/no services catalogue yet/)
      await serviceCreate(db, { orgId, createdBy: ownerId, actor: ownerId, input: { name: 'SEO', needs: ['weak_search_basics'], priceFrom: 8000, priceUnit: 'monthly' } })
      expect(summaryOf(await run(listServices, {}))).toMatch(/• SEO — from INR 8,000 a month — answers weak search basics/)
    })
  })

  describe('create_task as a call', () => {
    it('makes a call task for a business with a phone, saying the system places no call', async () => {
      await run(findBusinesses, { query: 'dentists' }, { places: places([listing()]) })
      await run(addBusinessesTool, { placeIds: ['ChIJkumar'] })
      const [kumar] = await db.select().from(schema.companies)
      const summary = summaryOf(await run(createTask, { domain: kumar!.domain, title: 'Call Kumar Dental about a website', kind: 'call' }))
      expect(summary).toMatch(/^Created a call task .* the system places no call: a teammate calls from their own phone/)
      const [task] = await db.select().from(schema.tasks)
      expect(task).toMatchObject({ kind: 'call' })
      expect(task!.detail).toMatch(/Do Not Disturb registry \(TRAI\)/)
    })
  })
})
