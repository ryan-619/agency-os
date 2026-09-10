/**
 * Typed queries for the qualification data core (PROMPT.md §4).
 *
 * Everything here is driver-agnostic, so the same code runs against the
 * production Postgres and against the embedded engine the tests use.
 *
 * The write path is deliberately narrow: `recordScan` is the ONLY way a
 * finding enters the database, and it is the place the §2.2 rules are applied
 * in code — on top of the constraints that enforce them in the schema.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { ScoreResult, SiteProfile } from '@agency/core'
import * as schema from './schema.js'

export { parseCompanySeeds } from './csv.js'

export type AgencyDb = PgDatabase<PgQueryResultHKT, typeof schema>

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export interface CompanySeedRow {
  readonly domain: string
  readonly name?: string
}

export interface ImportResult {
  readonly inserted: number
  readonly alreadyPresent: number
  readonly domains: readonly string[]
}

/**
 * Import companies, de-duplicating on domain AT WRITE TIME (§8.2) — not at
 * read time, where a duplicate has already had a scan spent on it and can
 * already have been emailed twice.
 */
export async function importCompanies(
  db: AgencyDb,
  orgId: string,
  rows: readonly CompanySeedRow[],
  source: 'apollo' | 'manual' | 'import' | 'agent' = 'import',
): Promise<ImportResult> {
  const seen = new Set<string>()
  const unique: CompanySeedRow[] = []
  for (const row of rows) {
    const domain = row.domain.trim().toLowerCase()
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    unique.push({ domain, name: row.name })
  }
  if (!unique.length) return { inserted: 0, alreadyPresent: 0, domains: [] }

  const inserted = await db
    .insert(schema.companies)
    .values(unique.map((c) => ({ orgId, domain: c.domain, name: c.name ?? null, source })))
    .onConflictDoNothing({ target: [schema.companies.orgId, schema.companies.domain] })
    .returning({ domain: schema.companies.domain })

  return {
    inserted: inserted.length,
    alreadyPresent: unique.length - inserted.length,
    domains: inserted.map((r) => r.domain),
  }
}

export async function listCompanies(db: AgencyDb, orgId: string, limit = 200) {
  return db
    .select({
      id: schema.companies.id,
      domain: schema.companies.domain,
      name: schema.companies.name,
      source: schema.companies.source,
      firstSeenAt: schema.companies.firstSeenAt,
    })
    .from(schema.companies)
    .where(eq(schema.companies.orgId, orgId))
    .orderBy(schema.companies.domain)
    .limit(limit)
}

export async function findCompanyByDomain(db: AgencyDb, orgId: string, domain: string) {
  const rows = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.domain, domain.toLowerCase())))
    .limit(1)
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Scans, findings, scores
// ---------------------------------------------------------------------------

export interface RecordScanInput {
  readonly orgId: string
  readonly companyId: string
  readonly icpProfileId: string
  /** The full capture, stored on scans.raw so a finding can be traced back. */
  readonly raw: unknown
  readonly profile: SiteProfile
  readonly result: ScoreResult
}

export interface RecordScanOutput {
  readonly scanId: string
  readonly scoreId: string
  readonly findingsWritten: number
  readonly observedCount: number
  readonly unobservedCount: number
}

/**
 * Write one scan, its findings and its score, atomically.
 *
 * The §2.2 rules applied here, each backed by a database constraint that would
 * reject the row anyway:
 *   * a scan that never reached the site is stored with ok = false and NO
 *     findings — nothing was observed, so nothing is claimed;
 *   * an unobserved signal is stored with gap = NULL and weight 0;
 *   * a signal's weight is read from the ICP, so a finding cannot claim a
 *     weight the profile does not give it.
 */
export async function recordScan(db: AgencyDb, input: RecordScanInput): Promise<RecordScanOutput> {
  const { orgId, companyId, icpProfileId, raw, profile, result } = input

  return db.transaction(async (tx) => {
    const [scan] = await tx
      .insert(schema.scans)
      .values({
        orgId,
        companyId,
        ok: profile.fetchOk,
        error: profile.fetchOk ? null : profile.fetchError || 'no response',
        raw: raw as Record<string, unknown>,
      })
      .returning({ id: schema.scans.id })

    if (!scan) throw new Error('failed to insert scan')

    // A gap's weight comes from the scored gap list, which came from the ICP.
    const weightOf = new Map(result.gaps.map((g) => [g.key, g.weight]))

    const findingRows = Object.entries(profile.observations).map(([signalKey, o]) => ({
      orgId,
      scanId: scan.id,
      companyId,
      signalKey,
      observed: o.observed,
      // NULL whenever unobserved: unknown, not "no gap".
      gap: o.observed ? Boolean(o.gap) : null,
      weight: o.observed && o.gap ? (weightOf.get(signalKey) ?? 0) : 0,
      detail: o.detail || null,
      evidence: (o.evidence ?? {}) as Record<string, unknown>,
      stale: false,
    }))

    if (findingRows.length) await tx.insert(schema.findings).values(findingRows)

    const [score] = await tx
      .insert(schema.scores)
      .values({
        orgId,
        companyId,
        icpProfileId,
        score: result.score,
        tier: result.tier || null,
        qualified: result.qualified,
        disqualifiedReason: result.disqualified || null,
      })
      .returning({ id: schema.scores.id })

    if (!score) throw new Error('failed to insert score')

    return {
      scanId: scan.id,
      scoreId: score.id,
      findingsWritten: findingRows.length,
      observedCount: findingRows.filter((f) => f.observed).length,
      unobservedCount: findingRows.filter((f) => !f.observed).length,
    }
  })
}

/** The most recent scan for a company, with its findings. */
export async function latestScanWithFindings(db: AgencyDb, orgId: string, companyId: string) {
  const scans = await db
    .select()
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId)))
    .orderBy(desc(schema.scans.ranAt))
    .limit(1)

  const scan = scans[0]
  if (!scan) return null

  const findings = await db
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.scanId, scan.id))
    .orderBy(desc(schema.findings.weight), schema.findings.signalKey)

  return { scan, findings }
}

/** The most recent score for a company. History is kept, never overwritten (§4). */
export async function latestScore(db: AgencyDb, orgId: string, companyId: string) {
  const rows = await db
    .select()
    .from(schema.scores)
    .where(and(eq(schema.scores.orgId, orgId), eq(schema.scores.companyId, companyId)))
    .orderBy(desc(schema.scores.computedAt))
    .limit(1)
  return rows[0] ?? null
}

export interface CompanyListRow {
  readonly companyId: string
  readonly domain: string
  readonly name: string | null
  readonly score: number | null
  readonly tier: string | null
  readonly qualified: boolean
  readonly disqualifiedReason: string | null
  readonly lastScanAt: Date | null
  readonly lastScanOk: boolean | null
}

/**
 * Every company with its latest score and latest scan.
 *
 * Three indexed queries folded together in memory rather than one DISTINCT ON
 * with a LATERAL join: the typed builder cannot express that, and `db.execute`
 * returns `unknown` under the driver-agnostic database type. At Phase 1
 * volumes — a few hundred companies — this is the boring, readable option. If
 * the list ever needs pagination it should become a view.
 */
export async function companyList(db: AgencyDb, orgId: string): Promise<CompanyListRow[]> {
  const companies = await db
    .select({
      id: schema.companies.id,
      domain: schema.companies.domain,
      name: schema.companies.name,
    })
    .from(schema.companies)
    .where(eq(schema.companies.orgId, orgId))
    .orderBy(schema.companies.domain)

  const scoreRows = await db
    .select({
      companyId: schema.scores.companyId,
      score: schema.scores.score,
      tier: schema.scores.tier,
      qualified: schema.scores.qualified,
      disqualifiedReason: schema.scores.disqualifiedReason,
      computedAt: schema.scores.computedAt,
    })
    .from(schema.scores)
    .where(eq(schema.scores.orgId, orgId))
    .orderBy(desc(schema.scores.computedAt))

  const scanRows = await db
    .select({
      companyId: schema.scans.companyId,
      ranAt: schema.scans.ranAt,
      ok: schema.scans.ok,
    })
    .from(schema.scans)
    .where(eq(schema.scans.orgId, orgId))
    .orderBy(desc(schema.scans.ranAt))

  // Ordered newest-first, so the first entry seen per company is the latest.
  const latestScore = new Map<string, (typeof scoreRows)[number]>()
  for (const r of scoreRows) if (!latestScore.has(r.companyId)) latestScore.set(r.companyId, r)
  const latestScan = new Map<string, (typeof scanRows)[number]>()
  for (const r of scanRows) if (!latestScan.has(r.companyId)) latestScan.set(r.companyId, r)

  return companies.map((c) => {
    const s = latestScore.get(c.id)
    const scan = latestScan.get(c.id)
    return {
      companyId: c.id,
      domain: c.domain,
      name: c.name,
      score: s?.score ?? null,
      tier: s?.tier ?? null,
      qualified: s?.qualified ?? false,
      disqualifiedReason: s?.disqualifiedReason ?? null,
      lastScanAt: scan?.ranAt ?? null,
      lastScanOk: scan?.ok ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// Freshness (§2.2, §8.3)
// ---------------------------------------------------------------------------

/**
 * Mark findings older than `staleAfterDays` as stale.
 *
 * §2.2: "Findings older than 14 days are marked stale and must be re-verified
 * before appearing in any outbound draft." The threshold comes from the ICP's
 * `freshness.stale_after_days`, not from a constant here.
 *
 * Age is measured from the SCAN's ran_at, not the finding row's created_at:
 * the question is how old the observation is, not how old the record is.
 */
export async function markStaleFindings(
  db: AgencyDb,
  orgId: string,
  staleAfterDays: number,
): Promise<number> {
  if (!Number.isFinite(staleAfterDays) || staleAfterDays <= 0) {
    throw new Error(`staleAfterDays must be a positive number, got ${String(staleAfterDays)}`)
  }
  const updated = await db
    .update(schema.findings)
    .set({ stale: true })
    .where(
      and(
        eq(schema.findings.orgId, orgId),
        eq(schema.findings.stale, false),
        inArray(
          schema.findings.scanId,
          db
            .select({ id: schema.scans.id })
            .from(schema.scans)
            .where(
              and(
                eq(schema.scans.orgId, orgId),
                lt(schema.scans.ranAt, sql`now() - make_interval(days => ${staleAfterDays})`),
              ),
            ),
        ),
      ),
    )
    .returning({ id: schema.findings.id })
  return updated.length
}

/**
 * Findings safe to quote in an outbound draft: observed, a gap, fresh, and
 * from the MOST RECENT scan.
 *
 * The last condition is the one that is easy to miss. Filtering only by
 * company returns every scan's findings at once, so after a re-scan a draft
 * could quote a gap the newest scan says is now closed — the company fixed
 * their CSP last week, and the email still tells them they have none. The old
 * row stays in the table as history; it is simply not quotable.
 */
export async function quotableFindings(db: AgencyDb, orgId: string, companyId: string) {
  const latest = await db
    .select({ id: schema.scans.id })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId), eq(schema.scans.ok, true)))
    .orderBy(desc(schema.scans.ranAt))
    .limit(1)

  const scanId = latest[0]?.id
  if (!scanId) return []

  return db
    .select()
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.orgId, orgId),
        eq(schema.findings.scanId, scanId),
        eq(schema.findings.observed, true),
        eq(schema.findings.gap, true),
        eq(schema.findings.stale, false),
      ),
    )
    .orderBy(desc(schema.findings.weight))
}

/** The org's active ICP profile row. */
export async function activeIcpProfile(db: AgencyDb, orgId: string) {
  const rows = await db
    .select()
    .from(schema.icpProfiles)
    .where(and(eq(schema.icpProfiles.orgId, orgId), eq(schema.icpProfiles.active, true)))
    .limit(1)
  return rows[0] ?? null
}
