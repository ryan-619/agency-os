/**
 * Businesses as a customer finds them, what they need, and what the agency
 * sells (0022, 2026-10-08).
 *
 *  - LISTINGS: a business found on Google Maps is added with what its listing
 *    says — phone, address, rating, reviews, category, the website it names —
 *    dated by when it was read. One with no website of its own keeps a
 *    `.nosite.invalid` placeholder domain (`noSiteDomain`), which can never
 *    resolve.
 *  - SITE AUDITS: what Google's PageSpeed measured, a failure stored with its
 *    reason and no score.
 *  - SERVICES: the agency's catalogue, each service naming the needs it
 *    answers.
 *  - OPPORTUNITIES: one business's facts gathered for `needsOf`, and the
 *    whole CRM ranked by what it needs — read in three queries, never one
 *    per company.
 *
 * Every write here is internal state; nothing reaches anybody.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  NEED_KEYS, SUGGESTED_SERVICES, needsOf, normalisePhone, servicesFor, staleAfterDaysOf,
  type NeedKey, type NeedsReading, type OpportunityFacts,
} from '@agency/core'
import * as schema from './schema.js'
import { activeIcpProfile, latestScanWithFindings, type AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { isUniqueViolation } from './pg-errors.js'

type CompanyRow = typeof schema.companies.$inferSelect
export type ServiceRow = typeof schema.services.$inferSelect
export type SiteAuditRow = typeof schema.siteAudits.$inferSelect

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

/** One business as its listing describes it, with the domain the caller decided on. */
export interface BusinessToAdd {
  /** A scannable domain of its own, or a `noSiteDomain` placeholder. */
  readonly domain: string
  readonly name: string
  readonly placeId: string
  readonly address: string | null
  /** As the listing gives it; stored only when `normalisePhone` reads it as E.164. */
  readonly phone: string | null
  readonly website: string | null
  readonly rating: number | null
  readonly reviews: number | null
  readonly category: string | null
  readonly mapsUrl: string | null
  readonly timeZone?: string | null
  readonly country?: string | null
  readonly city?: string | null
}

export interface AddBusinessesResult {
  readonly added: readonly { readonly placeId: string; readonly domain: string; readonly name: string }[]
  /** Already in the CRM — by place, or by domain — with its listing facts refreshed. */
  readonly refreshed: readonly { readonly placeId: string; readonly domain: string; readonly name: string | null }[]
}

const clip = (text: string | null | undefined, max: number): string | null => {
  const t = text?.replace(/\s+/g, ' ').trim()
  return t ? [...t].slice(0, max).join('') : null
}

function listingColumns(b: BusinessToAdd, checkedAt: Date) {
  return {
    phone: b.phone ? normalisePhone(b.phone) : null,
    address: clip(b.address, 300),
    googlePlaceId: b.placeId,
    googleMapsUrl: b.mapsUrl && b.mapsUrl.startsWith('https://') && b.mapsUrl.length <= 500 ? b.mapsUrl : null,
    googleRating: b.rating !== null && b.rating >= 0 && b.rating <= 5 ? b.rating.toFixed(1) : null,
    googleReviewCount: b.reviews !== null && Number.isInteger(b.reviews) && b.reviews >= 0 ? b.reviews : null,
    googleCategory: clip(b.category, 80),
    listingWebsite: clip(b.website, 500),
    listingCheckedAt: checkedAt,
  }
}

/**
 * Add businesses found on a map, or refresh the listing of one already here.
 *
 * A place already in the CRM (by place id), or a company already here by
 * domain, has its listing facts REPLACED by this newer reading — a listing is
 * a third party's current record, dated by `listing_checked_at` — and is
 * reported as refreshed; nothing else about it changes. A new one is added
 * with source `google_maps`. Audited by counts.
 */
export async function addBusinesses(
  db: AgencyDb,
  args: { readonly orgId: string; readonly businesses: readonly BusinessToAdd[]; readonly checkedAt: Date; readonly actor: string },
): Promise<AddBusinessesResult> {
  const added: { placeId: string; domain: string; name: string }[] = []
  const refreshed: { placeId: string; domain: string; name: string | null }[] = []
  for (const b of args.businesses) {
    const domain = b.domain.trim().toLowerCase()
    const listing = listingColumns(b, args.checkedAt)
    const [existing] = await db
      .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(
        and(
          eq(schema.companies.orgId, args.orgId),
          sql`(${schema.companies.googlePlaceId} = ${b.placeId} OR ${schema.companies.domain} = ${domain})`,
        ),
      )
      .orderBy(sql`(${schema.companies.googlePlaceId} = ${b.placeId}) DESC`)
      .limit(1)
    if (existing) {
      try {
        await db.update(schema.companies).set(listing).where(eq(schema.companies.id, existing.id))
      } catch (err) {
        // The place is already filed under ANOTHER company here: leave both as they are.
        if (!isUniqueViolation(err)) throw err
      }
      refreshed.push({ placeId: b.placeId, domain: existing.domain, name: existing.name })
      continue
    }
    const rows = await db
      .insert(schema.companies)
      .values({
        orgId: args.orgId,
        domain,
        name: clip(b.name, 200),
        source: 'google_maps',
        timeZone: b.timeZone ?? null,
        country: b.country ?? null,
        city: clip(b.city, 80),
        ...listing,
      })
      .onConflictDoNothing()
      .returning({ domain: schema.companies.domain })
    if (rows[0]) added.push({ placeId: b.placeId, domain: rows[0].domain, name: b.name })
    else refreshed.push({ placeId: b.placeId, domain, name: b.name })
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'company.listings_added',
    subjectType: 'org',
    subjectId: null,
    detail: { added: added.length, refreshed: refreshed.length },
  }).catch(() => {})
  return { added, refreshed }
}

// ---------------------------------------------------------------------------
// Site audits
// ---------------------------------------------------------------------------

export interface SiteAuditResult {
  readonly ok: boolean
  readonly error: string | null
  readonly performance: number | null
  readonly accessibility: number | null
  readonly bestPractices: number | null
  readonly seo: number | null
  readonly lcpMs: number | null
  readonly cls: number | null
  readonly tbtMs: number | null
  readonly fcpMs: number | null
  readonly fieldCategory: 'FAST' | 'AVERAGE' | 'SLOW' | null
}

const score = (n: number | null): number | null => (n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(100, Math.round(n))))
const measure = (n: number | null): number | null => (n === null || !Number.isFinite(n) || n < 0 ? null : Math.round(n))

/** Store one audit. A failure keeps its reason and no score (`site_audits_failure_has_no_scores`). */
export async function recordSiteAudit(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly strategy: 'mobile' | 'desktop'
    readonly url: string
    readonly result: SiteAuditResult
    readonly ranAt: Date
  },
): Promise<SiteAuditRow> {
  const r = args.result
  const [row] = await db
    .insert(schema.siteAudits)
    .values({
      orgId: args.orgId,
      companyId: args.companyId,
      strategy: args.strategy,
      url: args.url.slice(0, 500),
      ranAt: args.ranAt,
      ok: r.ok,
      error: r.ok ? null : clip(r.error, 300) ?? 'the audit failed',
      ...(r.ok
        ? {
            performance: score(r.performance),
            accessibility: score(r.accessibility),
            bestPractices: score(r.bestPractices),
            seo: score(r.seo),
            lcpMs: measure(r.lcpMs),
            cls: r.cls !== null && Number.isFinite(r.cls) && r.cls >= 0 ? r.cls.toFixed(3) : null,
            tbtMs: measure(r.tbtMs),
            fcpMs: measure(r.fcpMs),
            fieldCategory: r.fieldCategory,
          }
        : {}),
    })
    .returning()
  return row!
}

export async function latestSiteAudit(db: AgencyDb, orgId: string, companyId: string): Promise<SiteAuditRow | null> {
  const [row] = await db
    .select()
    .from(schema.siteAudits)
    .where(and(eq(schema.siteAudits.orgId, orgId), eq(schema.siteAudits.companyId, companyId)))
    .orderBy(desc(schema.siteAudits.ranAt))
    .limit(1)
  return row ?? null
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const SERVICE_PRICE_UNITS = ['one_off', 'monthly', 'yearly', 'hourly', 'daily'] as const

/** What a person or the agent may set on a service. */
export const serviceInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).nullable().optional(),
    needs: z.array(z.enum(NEED_KEYS)).max(20).optional(),
    priceFrom: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    priceTo: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    priceUnit: z.enum(SERVICE_PRICE_UNITS).optional(),
    active: z.boolean().optional(),
  })
  .strict()

export type ServiceInput = z.infer<typeof serviceInput>

export type ServiceWrite =
  | { readonly ok: true; readonly service: ServiceRow }
  | { readonly ok: false; readonly reason: 'invalid' | 'name_taken' | 'not_found'; readonly message: string }

function priceProblem(from: number | null | undefined, to: number | null | undefined): string | null {
  return from !== null && from !== undefined && to !== null && to !== undefined && to < from
    ? 'The top of the price range is below its bottom.'
    : null
}

export async function servicesList(db: AgencyDb, orgId: string, opts: { readonly activeOnly?: boolean } = {}): Promise<ServiceRow[]> {
  return db
    .select()
    .from(schema.services)
    .where(and(eq(schema.services.orgId, orgId), opts.activeOnly ? eq(schema.services.active, true) : sql`true`))
    .orderBy(schema.services.name)
}

export async function serviceCreate(
  db: AgencyDb,
  args: { readonly orgId: string; readonly input: unknown; readonly createdBy: string | null; readonly actor: string },
): Promise<ServiceWrite> {
  const parsed = serviceInput.safeParse(args.input)
  if (!parsed.success) return { ok: false, reason: 'invalid', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'service'}: ${i.message}`).join('; ') }
  const v = parsed.data
  const price = priceProblem(v.priceFrom, v.priceTo)
  if (price) return { ok: false, reason: 'invalid', message: price }
  try {
    const [service] = await db
      .insert(schema.services)
      .values({
        orgId: args.orgId,
        name: v.name,
        description: v.description || null,
        needs: [...new Set(v.needs ?? [])],
        priceFrom: v.priceFrom ?? null,
        priceTo: v.priceTo ?? null,
        currency: (v.currency ?? 'INR').toUpperCase(),
        priceUnit: v.priceUnit ?? 'one_off',
        active: v.active ?? true,
        createdBy: args.createdBy,
      })
      .returning()
    await appendAudit(db, {
      orgId: args.orgId, actor: args.actor, action: 'service.created', subjectType: 'service', subjectId: service!.id,
      detail: { needs: service!.needs.length, priced: service!.priceFrom !== null || service!.priceTo !== null },
    }).catch(() => {})
    return { ok: true, service: service! }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'name_taken', message: `There is already a service called "${v.name}".` }
    throw err
  }
}

export async function serviceUpdate(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly input: unknown; readonly actor: string },
): Promise<ServiceWrite> {
  const parsed = serviceInput.partial().strict().safeParse(args.input)
  if (!parsed.success) return { ok: false, reason: 'invalid', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'service'}: ${i.message}`).join('; ') }
  const v = parsed.data
  const [current] = await db
    .select()
    .from(schema.services)
    .where(and(eq(schema.services.orgId, args.orgId), eq(schema.services.id, args.id)))
    .limit(1)
  if (!current) return { ok: false, reason: 'not_found', message: 'No such service.' }
  const from = v.priceFrom !== undefined ? v.priceFrom : current.priceFrom
  const to = v.priceTo !== undefined ? v.priceTo : current.priceTo
  const price = priceProblem(from, to)
  if (price) return { ok: false, reason: 'invalid', message: price }
  const set = {
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.description !== undefined ? { description: v.description || null } : {}),
    ...(v.needs !== undefined ? { needs: [...new Set(v.needs)] } : {}),
    ...(v.priceFrom !== undefined ? { priceFrom: v.priceFrom } : {}),
    ...(v.priceTo !== undefined ? { priceTo: v.priceTo } : {}),
    ...(v.currency !== undefined ? { currency: v.currency.toUpperCase() } : {}),
    ...(v.priceUnit !== undefined ? { priceUnit: v.priceUnit } : {}),
    ...(v.active !== undefined ? { active: v.active } : {}),
  }
  if (Object.keys(set).length === 0) return { ok: true, service: current }
  try {
    const [service] = await db
      .update(schema.services)
      .set(set)
      .where(and(eq(schema.services.orgId, args.orgId), eq(schema.services.id, args.id)))
      .returning()
    await appendAudit(db, {
      orgId: args.orgId, actor: args.actor, action: 'service.updated', subjectType: 'service', subjectId: args.id,
      detail: { fields: Object.keys(set).sort() },
    }).catch(() => {})
    return { ok: true, service: service! }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'name_taken', message: `There is already a service called "${v.name}".` }
    throw err
  }
}

export async function serviceDelete(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly actor: string },
): Promise<{ readonly ok: boolean }> {
  const deleted = await db
    .delete(schema.services)
    .where(and(eq(schema.services.orgId, args.orgId), eq(schema.services.id, args.id)))
    .returning({ id: schema.services.id })
  if (deleted.length === 0) return { ok: false }
  await appendAudit(db, {
    orgId: args.orgId, actor: args.actor, action: 'service.deleted', subjectType: 'service', subjectId: args.id, detail: {},
  }).catch(() => {})
  return { ok: true }
}

/** Add the suggested catalogue (`SUGGESTED_SERVICES`), skipping any name already here. No prices: those are the agency's. */
export async function servicesAddSuggested(
  db: AgencyDb,
  args: { readonly orgId: string; readonly createdBy: string | null; readonly actor: string },
): Promise<{ readonly added: number }> {
  const rows = await db
    .insert(schema.services)
    .values(
      SUGGESTED_SERVICES.map((s) => ({
        orgId: args.orgId, name: s.name, description: s.description, needs: [...s.needs], createdBy: args.createdBy,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.services.id })
  await appendAudit(db, {
    orgId: args.orgId, actor: args.actor, action: 'service.suggested_added', subjectType: 'org', subjectId: null,
    detail: { added: rows.length },
  }).catch(() => {})
  return { added: rows.length }
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

type ScanLike = { readonly ranAt: Date; readonly ok: boolean }
type FindingLike = { readonly signalKey: string; readonly observed: boolean; readonly gap: boolean | null; readonly detail: string | null }

function factsFrom(
  company: CompanyRow,
  scan: (ScanLike & { readonly findings: readonly FindingLike[] }) | null,
  audit: SiteAuditRow | null,
  staleAfterDays: number,
): OpportunityFacts {
  return {
    domain: company.domain,
    listing: company.listingCheckedAt
      ? {
          checkedAt: company.listingCheckedAt,
          website: company.listingWebsite,
          rating: company.googleRating === null ? null : Number(company.googleRating),
          reviews: company.googleReviewCount,
          category: company.googleCategory,
        }
      : null,
    scan: scan
      ? {
          ranAt: scan.ranAt,
          ok: scan.ok,
          findings: scan.findings.map((f) => ({ key: f.signalKey, observed: f.observed, gap: f.gap, detail: f.detail })),
        }
      : null,
    audit: audit
      ? {
          ranAt: audit.ranAt,
          ok: audit.ok,
          strategy: audit.strategy,
          error: audit.error,
          performance: audit.performance,
          seo: audit.seo,
          accessibility: audit.accessibility,
          lcpMs: audit.lcpMs,
        }
      : null,
    staleAfterDays,
  }
}

export interface CompanyOpportunity {
  readonly company: CompanyRow
  readonly reading: NeedsReading
  /** The catalogue's services that answer them, most first; the suggestions when the catalogue is empty. */
  readonly services: readonly { readonly name: string; readonly answers: readonly NeedKey[]; readonly suggested: boolean; readonly id: string | null }[]
}

function matched(reading: NeedsReading, catalogue: readonly ServiceRow[]): CompanyOpportunity['services'] {
  if (catalogue.length > 0) {
    return servicesFor(reading.needs, catalogue).map((m) => ({ name: m.service.name, answers: m.answers, suggested: false, id: m.service.id }))
  }
  return servicesFor(reading.needs, SUGGESTED_SERVICES).map((m) => ({ name: m.service.name, answers: m.answers, suggested: true, id: null }))
}

/** One company's needs and the services that answer them. */
export async function companyOpportunity(
  db: AgencyDb,
  args: { readonly orgId: string; readonly company: CompanyRow; readonly now: Date },
): Promise<CompanyOpportunity> {
  const [latest, audit, icp, catalogue] = await Promise.all([
    latestScanWithFindings(db, args.orgId, args.company.id),
    latestSiteAudit(db, args.orgId, args.company.id),
    activeIcpProfile(db, args.orgId),
    servicesList(db, args.orgId, { activeOnly: true }),
  ])
  const scan = latest ? { ranAt: latest.scan.ranAt, ok: latest.scan.ok, findings: latest.findings } : null
  const reading = needsOf(factsFrom(args.company, scan, audit, staleAfterDaysOf(icp?.definition)), args.now)
  return { company: args.company, reading, services: matched(reading, catalogue) }
}

/** How many companies the CRM-wide reading looks at, most recently added first. */
export const OPPORTUNITIES_READ = 500

/**
 * Every company's needs, the most needs first, in three queries: the
 * companies, each one's latest scan with its findings, each one's latest
 * audit. Optionally only those showing one need, or answered by one service.
 */
export async function opportunitiesAcross(
  db: AgencyDb,
  args: { readonly orgId: string; readonly now: Date; readonly need?: NeedKey | undefined; readonly serviceId?: string | undefined },
): Promise<{ readonly read: number; readonly results: readonly CompanyOpportunity[] }> {
  const companies = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.orgId, args.orgId))
    .orderBy(desc(schema.companies.createdAt))
    .limit(OPPORTUNITIES_READ)
  if (companies.length === 0) return { read: 0, results: [] }
  const ids = companies.map((c) => c.id)

  const latestScans = await db
    .selectDistinctOn([schema.scans.companyId], { id: schema.scans.id, companyId: schema.scans.companyId, ranAt: schema.scans.ranAt, ok: schema.scans.ok })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, args.orgId), inArray(schema.scans.companyId, ids)))
    .orderBy(schema.scans.companyId, desc(schema.scans.ranAt))
  const scanIds = latestScans.map((s) => s.id)
  const findings = scanIds.length
    ? await db
        .select({
          scanId: schema.findings.scanId, signalKey: schema.findings.signalKey, observed: schema.findings.observed,
          gap: schema.findings.gap, detail: schema.findings.detail,
        })
        .from(schema.findings)
        .where(inArray(schema.findings.scanId, scanIds))
    : []
  const audits = await db
    .selectDistinctOn([schema.siteAudits.companyId])
    .from(schema.siteAudits)
    .where(and(eq(schema.siteAudits.orgId, args.orgId), inArray(schema.siteAudits.companyId, ids)))
    .orderBy(schema.siteAudits.companyId, desc(schema.siteAudits.ranAt))

  const [icp, catalogue] = await Promise.all([activeIcpProfile(db, args.orgId), servicesList(db, args.orgId, { activeOnly: true })])
  const staleAfterDays = staleAfterDaysOf(icp?.definition)
  const findingsByScan = new Map<string, FindingLike[]>()
  for (const f of findings) {
    const list = findingsByScan.get(f.scanId) ?? []
    list.push(f)
    findingsByScan.set(f.scanId, list)
  }
  const scanByCompany = new Map(latestScans.map((s) => [s.companyId, { ...s, findings: findingsByScan.get(s.id) ?? [] }]))
  const auditByCompany = new Map(audits.map((a) => [a.companyId, a]))

  const results = companies
    .map((company): CompanyOpportunity => {
      const reading = needsOf(
        factsFrom(company, scanByCompany.get(company.id) ?? null, auditByCompany.get(company.id) ?? null, staleAfterDays),
        args.now,
      )
      return { company, reading, services: matched(reading, catalogue) }
    })
    .filter((o) => o.reading.needs.length > 0)
    .filter((o) => !args.need || o.reading.needs.some((n) => n.key === args.need))
    .filter((o) => !args.serviceId || o.services.some((s) => s.id === args.serviceId))
    .sort((a, b) => b.reading.needs.length - a.reading.needs.length || a.company.domain.localeCompare(b.company.domain))
  return { read: companies.length, results }
}
