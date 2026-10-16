/**
 * A business's own audit page (2026-10-08): what we noticed about its
 * presence online, dated; how it stands beside its nearest competitors; what
 * Google measured of its site; and what the agency does about each — the
 * page its link opens.
 *
 * Every fact is one somebody recorded: the Google listing (dated by
 * `listing_checked_at`, current within `LISTING_STALE_DAYS`), the latest scan
 * and PageSpeed audit inside the profile's deadline (`staleAfterDaysOf`). An
 * unknown is "not checked", never a "no" (`packages/core/src/peers.ts`).
 * Competitors are compared from what the CRM already holds — businesses of
 * the same Google category, near by coordinates or in the same city — and
 * never named on the page.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import {
  LISTING_STALE_DAYS, comparisonHeadline, comparisonRows, isNoSiteDomain, isNotApplicable, isStale, nearestPeers, needsOf,
  staleAfterDaysOf, classifyWebsite, type ComparisonRow, type Need, type Peer, type PeerFacts,
} from '@agency/core'
import * as schema from './schema.js'
import { activeIcpProfile, type AgencyDb } from './repository.js'
import { servicesList, type ServiceRow } from './opportunities.js'

type CompanyRow = typeof schema.companies.$inferSelect
type FindingLite = { readonly signalKey: string; readonly observed: boolean; readonly gap: boolean | null; readonly detail: string | null }
type ScanLite = { readonly id: string; readonly companyId: string; readonly ranAt: Date; readonly ok: boolean; readonly findings: readonly FindingLite[] }
type AuditRow = typeof schema.siteAudits.$inferSelect

/** How many companies of the same category are read as candidates. */
export const REPORT_PEER_CANDIDATES = 200

export interface PresenceReport {
  readonly company: CompanyRow
  readonly generatedAt: Date
  readonly needs: readonly Need[]
  readonly notAssessed: readonly string[]
  /** The catalogue's services that answer the needs, most first; empty when there is no catalogue. */
  readonly services: readonly { readonly service: ServiceRow; readonly answers: readonly string[] }[]
  readonly subject: PeerFacts
  readonly peers: readonly Peer[]
  readonly headline: string | null
  readonly rows: readonly ComparisonRow[]
  /** The latest PageSpeed audit when it succeeded and is current; null otherwise. */
  readonly audit: AuditRow | null
}

/** A yes or no from one presence finding, or null when it was not read, is not applicable, or is stale. */
function presenceFact(findings: readonly FindingLite[], key: string, present: (f: FindingLite) => boolean): boolean | null {
  const f = findings.find((x) => x.signalKey === key)
  if (!f || !f.observed || isNotApplicable({ observed: f.observed, gap: f.gap, detail: f.detail })) return null
  return present(f)
}

/**
 * One business as the comparison reads it. Exported for its test: the
 * readings below are the scanner's own words (`presence.ts`), and the test
 * pins them.
 */
export function peerFactsOf(company: CompanyRow, scan: ScanLite | null, audit: AuditRow | null, staleAfterDays: number, now: Date): PeerFacts {
  const scanCurrent = scan !== null && scan.ok && !isStale(scan.ranAt, staleAfterDays, now)
  const findings = scanCurrent ? scan!.findings : []
  let ownWebsite: boolean | null
  if (!isNoSiteDomain(company.domain)) ownWebsite = true
  else if (company.listingCheckedAt === null) ownWebsite = null
  else ownWebsite = company.listingWebsite !== null && classifyWebsite(company.listingWebsite).kind === 'own'
  const auditCurrent = audit !== null && audit.ok && audit.strategy === 'mobile' && !isStale(audit.ranAt, staleAfterDays, now)
  return {
    id: company.id,
    category: company.googleCategory,
    city: company.city,
    lat: company.latitude,
    lng: company.longitude,
    listingCheckedAt: company.listingCheckedAt,
    rating: company.googleRating === null ? null : Number(company.googleRating),
    reviews: company.googleReviewCount,
    ownWebsite,
    // A viewport tag present is the page saying it fits a phone; its absence a gap.
    mobileFriendly: presenceFact(findings, 'mobile_viewport', (f) => f.gap === false),
    whatsapp: presenceFact(findings, 'whatsapp_chat', (f) => f.gap === false),
    // Never a gap (plenty take no bookings online): the scanner says "no online booking…" when it found none.
    onlineBooking: presenceFact(findings, 'booking_or_store', (f) => !(f.detail ?? '').startsWith('no online booking')),
    speedScore: auditCurrent ? audit!.performance : null,
  }
}

async function latestScans(db: AgencyDb, orgId: string, ids: readonly string[]): Promise<Map<string, ScanLite>> {
  if (ids.length === 0) return new Map()
  const scans = await db
    .selectDistinctOn([schema.scans.companyId], { id: schema.scans.id, companyId: schema.scans.companyId, ranAt: schema.scans.ranAt, ok: schema.scans.ok })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), inArray(schema.scans.companyId, [...ids])))
    .orderBy(schema.scans.companyId, desc(schema.scans.ranAt))
  const scanIds = scans.map((s) => s.id)
  const findings = scanIds.length
    ? await db
        .select({
          scanId: schema.findings.scanId, signalKey: schema.findings.signalKey, observed: schema.findings.observed,
          gap: schema.findings.gap, detail: schema.findings.detail,
        })
        .from(schema.findings)
        .where(inArray(schema.findings.scanId, scanIds))
    : []
  const byScan = new Map<string, FindingLite[]>()
  for (const f of findings) {
    const list = byScan.get(f.scanId) ?? []
    list.push(f)
    byScan.set(f.scanId, list)
  }
  return new Map(scans.map((s) => [s.companyId, { ...s, findings: byScan.get(s.id) ?? [] }]))
}

async function latestAudits(db: AgencyDb, orgId: string, ids: readonly string[]): Promise<Map<string, AuditRow>> {
  if (ids.length === 0) return new Map()
  const audits = await db
    .selectDistinctOn([schema.siteAudits.companyId])
    .from(schema.siteAudits)
    .where(and(eq(schema.siteAudits.orgId, orgId), inArray(schema.siteAudits.companyId, [...ids])))
    .orderBy(schema.siteAudits.companyId, desc(schema.siteAudits.ranAt))
  return new Map(audits.map((a) => [a.companyId, a]))
}

/** The audit page for one company of this org, or null when there is no such company. */
export async function presenceReport(
  db: AgencyDb,
  args: { readonly orgId: string; readonly companyId: string; readonly now: Date },
): Promise<PresenceReport | null> {
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
    .limit(1)
  if (!company) return null

  // The nearest current listings of the category first — by coordinates when the business has them (a flat
  // approximation, which only orders the candidates: `nearestPeers` measures each one properly), then its city —
  // so a CRM with more than REPORT_PEER_CANDIDATES of them still hands the comparison its neighbours.
  const listingSince = new Date(args.now.getTime() - LISTING_STALE_DAYS * 86_400_000)
  const nearFirst =
    company.latitude !== null && company.longitude !== null
      ? sql`(${schema.companies.latitude} - ${company.latitude}) ^ 2 + (${schema.companies.longitude} - ${company.longitude}) ^ 2 ASC NULLS LAST`
      : sql`(lower(${schema.companies.city}) = lower(${company.city ?? ''})) DESC`
  const candidates = company.googleCategory
    ? await db
        .select()
        .from(schema.companies)
        .where(and(
          eq(schema.companies.orgId, args.orgId),
          eq(schema.companies.googleCategory, company.googleCategory),
          gte(schema.companies.listingCheckedAt, listingSince),
        ))
        .orderBy(nearFirst, schema.companies.id)
        .limit(REPORT_PEER_CANDIDATES)
    : []
  const ids = [...new Set([company.id, ...candidates.map((c) => c.id)])]
  const [scans, audits, icp, catalogue] = await Promise.all([
    latestScans(db, args.orgId, ids),
    latestAudits(db, args.orgId, ids),
    activeIcpProfile(db, args.orgId),
    servicesList(db, args.orgId, { activeOnly: true }),
  ])
  const staleAfterDays = staleAfterDaysOf(icp?.definition)

  const facts = (c: CompanyRow) => peerFactsOf(c, scans.get(c.id) ?? null, audits.get(c.id) ?? null, staleAfterDays, args.now)
  const subject = facts(company)
  const peers = nearestPeers(subject, candidates.filter((c) => c.id !== company.id).map(facts), args.now)

  const scan = scans.get(company.id) ?? null
  const audit = audits.get(company.id) ?? null
  const reading = needsOf(
    {
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
      scan: scan ? { ranAt: scan.ranAt, ok: scan.ok, findings: scan.findings.map((f) => ({ key: f.signalKey, observed: f.observed, gap: f.gap, detail: f.detail })) } : null,
      audit: audit
        ? {
            ranAt: audit.ranAt, ok: audit.ok, strategy: audit.strategy, error: audit.error, performance: audit.performance,
            seo: audit.seo, accessibility: audit.accessibility, lcpMs: audit.lcpMs,
          }
        : null,
      staleAfterDays,
    },
    args.now,
  )
  const keys = new Set(reading.needs.map((n) => n.key as string))
  const services = catalogue
    .map((service) => ({ service, answers: service.needs.filter((k) => keys.has(k)) }))
    .filter((s) => s.answers.length > 0)
    .sort((a, b) => b.answers.length - a.answers.length || a.service.name.localeCompare(b.service.name))
    .slice(0, 6)

  return {
    company,
    generatedAt: args.now,
    needs: reading.needs,
    notAssessed: reading.notAssessed,
    services,
    subject,
    peers,
    headline: comparisonHeadline(subject, peers, args.now),
    rows: peers.length > 0 ? comparisonRows(subject, peers, args.now) : [],
    audit: audit && audit.ok && !isStale(audit.ranAt, staleAfterDays, args.now) ? audit : null,
  }
}
