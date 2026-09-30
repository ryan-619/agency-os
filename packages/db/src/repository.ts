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
import {
  DEFAULT_STALE_AFTER_DAYS, isStale, scoreCompany,
  type IcpDefinition, type ScoreResult, type SiteProfile,
} from '@agency/core'
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
  /**
   * The ICP row this scan is judged against — the id AND the definition it
   * holds, together.
   *
   * Taking an id and a pre-computed `ScoreResult` separately let the two
   * disagree: nothing stopped a caller from scoring against one profile and
   * stamping another's id, and the row would then read as a judgement the named
   * profile never made. The score is computed HERE, from this definition, so
   * the number, the weights on the findings and the `icp_profile_id` cannot
   * come from different places.
   */
  readonly icpProfile: {
    readonly id: string
    readonly definition: IcpDefinition
  }
  /** The full capture, stored on scans.raw so a finding can be traced back. */
  readonly raw: unknown
  readonly profile: SiteProfile
}

export interface RecordScanOutput {
  readonly scanId: string
  readonly scoreId: string
  /** What was written, so the caller need not re-derive it. */
  readonly result: ScoreResult
  /** Every row, informational ones included. */
  readonly findingsWritten: number
  /** Of the SCORED signals — the ones the score was computed over. */
  readonly observedCount: number
  readonly unobservedCount: number
  /** Rows written `scored = false`: observed context, never part of the score. */
  readonly informationalCount: number
}

/**
 * Write one scan, its findings and its score, atomically.
 *
 * The §2.2 rules applied here, each backed by a database constraint that would
 * reject the row anyway:
 *   * a scan that never reached the site is stored with ok = false and NO
 *     findings — nothing was observed, so nothing is claimed;
 *   * an unobserved signal is stored with gap = NULL and weight 0;
 *   * a gap's weight is the ICP's weight for that signal, so a finding cannot
 *     claim a weight the profile does not give it;
 *   * a signal the ICP does not name — an informational one — is stored
 *     `scored = false` at weight 0 (`findings_informational_carries_no_weight`),
 *     so it is recorded as observed and can never be read as a gap that counts;
 *   * the score names the scan it was computed from, so no reader can pair one
 *     scan's number with another scan's evidence.
 */
export async function recordScan(db: AgencyDb, input: RecordScanInput): Promise<RecordScanOutput> {
  const { orgId, companyId, icpProfile, raw, profile } = input
  const icp = icpProfile.definition
  const result = scoreCompany(profile, icp)

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

    // A gap's weight is the ICP's weight for that signal, read from the
    // definition rather than from `result.gaps`. The gap list is empty for a
    // DISQUALIFIED company — scoring returns before it is built — so reading
    // weights from it wrote 0 against every real gap a disqualified company
    // has, and the detail page then ranked them all equally at zero.

    const findingRows = Object.entries(profile.observations).map(([signalKey, o]) => {
      // Scored means "the ICP names it", decided HERE from the definition the
      // score was computed with — not from a list of informational keys, so
      // promoting a signal is an ICP edit and nothing else. An own-property
      // test, because `signals` is a plain object and `'constructor' in {}`
      // is true.
      const scored = Object.prototype.hasOwnProperty.call(icp.signals, signalKey)
      return {
        orgId,
        scanId: scan.id,
        companyId,
        signalKey,
        observed: o.observed,
        // NULL whenever unobserved: unknown, not "no gap".
        gap: o.observed ? Boolean(o.gap) : null,
        weight: scored && o.observed && o.gap ? (icp.signals[signalKey]?.weight ?? 0) : 0,
        scored,
        detail: o.detail || null,
        evidence: (o.evidence ?? {}) as Record<string, unknown>,
        stale: false,
      }
    })

    if (findingRows.length) await tx.insert(schema.findings).values(findingRows)

    const [score] = await tx
      .insert(schema.scores)
      .values({
        orgId,
        companyId,
        scanId: scan.id,
        icpProfileId: icpProfile.id,
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
      result,
      findingsWritten: findingRows.length,
      observedCount: findingRows.filter((f) => f.scored && f.observed).length,
      unobservedCount: findingRows.filter((f) => f.scored && !f.observed).length,
      informationalCount: findingRows.filter((f) => !f.scored).length,
    }
  })
}

/**
 * The most recent scan for a company, with its findings AND the score computed
 * from it.
 *
 * The three are returned together on purpose. Fetching "the latest score" and
 * "the latest scan" as separate queries let a page render one scan's number
 * above another scan's evidence — a claim nobody computed. Since 0006 a score
 * names its scan, so the honest read is one lookup.
 */
export async function latestScanWithFindings(db: AgencyDb, orgId: string, companyId: string) {
  const scans = await db
    .select()
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId)))
    .orderBy(desc(schema.scans.ranAt))
    .limit(1)

  const scan = scans[0]
  if (!scan) return null

  const [findings, scoreRows] = await Promise.all([
    db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.scanId, scan.id))
      .orderBy(desc(schema.findings.weight), schema.findings.signalKey),
    db
      .select()
      .from(schema.scores)
      .where(eq(schema.scores.scanId, scan.id))
      .orderBy(desc(schema.scores.computedAt))
      .limit(1),
  ])

  return { scan, findings, score: scoreRows[0] ?? null }
}

/**
 * The most recent score for a company. History is kept, never overwritten (§4).
 *
 * Use `latestScanWithFindings` when the score is going to be shown NEXT TO
 * findings: this returns the newest score row, which is not necessarily the one
 * belonging to the newest scan.
 */
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
 * Every company with its latest scan and THAT SCAN'S score.
 *
 * Not "the latest score": pairing two independent lookups puts one scan's
 * number in the same row as another scan's timestamp, and the operator reads a
 * qualification that was never computed from the evidence the row claims. Since
 * 0006 a score names its scan, so the pairing is a join rather than a guess.
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

  // Scans BEFORE scores, and not in parallel. These are three statements, not
  // one snapshot, so a scan committing between them is visible to the later
  // query and not the earlier one. In this order every scan read here already
  // had its score committed — recordScan writes the pair in one transaction —
  // so the score lookup below cannot come up empty for a scan that is present.
  // The other order leaves a window where a freshly scanned company renders
  // with a scan time and no score at all.
  const scanRows = await db
    .select({
      id: schema.scans.id,
      companyId: schema.scans.companyId,
      ranAt: schema.scans.ranAt,
      ok: schema.scans.ok,
    })
    .from(schema.scans)
    .where(eq(schema.scans.orgId, orgId))
    .orderBy(desc(schema.scans.ranAt))

  const scoreRows = await db
    .select({
      companyId: schema.scores.companyId,
      scanId: schema.scores.scanId,
      score: schema.scores.score,
      tier: schema.scores.tier,
      qualified: schema.scores.qualified,
      disqualifiedReason: schema.scores.disqualifiedReason,
      computedAt: schema.scores.computedAt,
    })
    .from(schema.scores)
    .where(eq(schema.scores.orgId, orgId))
    .orderBy(desc(schema.scores.computedAt))

  // Ordered newest-first, so the first entry seen per company is the latest.
  const latestScan = new Map<string, (typeof scanRows)[number]>()
  for (const r of scanRows) if (!latestScan.has(r.companyId)) latestScan.set(r.companyId, r)
  // Keyed by SCAN, not by company: the row shown is the judgement of the scan
  // whose timestamp is shown beside it, or nothing at all.
  const scoreForScan = new Map<string, (typeof scoreRows)[number]>()
  for (const r of scoreRows) if (!scoreForScan.has(r.scanId)) scoreForScan.set(r.scanId, r)

  return companies.map((c) => {
    const scan = latestScan.get(c.id)
    const s = scan ? scoreForScan.get(scan.id) : undefined
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
 * from the MOST RECENT SUCCESSFUL scan.
 *
 * Two conditions here are easy to get wrong, and both end as a claim about a
 * company that is not true.
 *
 * Filtering only by company returns every scan's findings at once, so after a
 * re-scan a draft could quote a gap the newest scan says is now closed — the
 * company fixed their CSP last week and the email still tells them they have
 * none. The old row stays as history; it is simply not quotable.
 *
 * And freshness is computed from the scan's `ran_at`, NOT read from
 * `findings.stale`. That column is a cache, written by `markStaleFindings`,
 * which only runs when someone runs a scan. Trusting it lets an observation
 * that aged past the threshold this morning go out in an email this afternoon,
 * which is exactly what §2.2's "must be re-verified" forbids. The column is
 * still narrowed on first, because it is indexed and every row it excludes is
 * one this does not have to age-check.
 */
export async function quotableFindings(
  db: AgencyDb,
  orgId: string,
  companyId: string,
  staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS,
  now: Date = new Date(),
) {
  const latest = await db
    .select({ id: schema.scans.id, ranAt: schema.scans.ranAt })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId), eq(schema.scans.ok, true)))
    .orderBy(desc(schema.scans.ranAt))
    .limit(1)

  const scan = latest[0]
  if (!scan) return []
  // The whole scan is one moment, so one check settles every finding on it.
  if (isStale(scan.ranAt, staleAfterDays, now)) return []

  return db
    .select()
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.orgId, orgId),
        eq(schema.findings.scanId, scan.id),
        eq(schema.findings.observed, true),
        eq(schema.findings.gap, true),
        eq(schema.findings.stale, false),
        // An informational signal is context, never a talking point: it is
        // not in the score, so an email must not lead with it.
        eq(schema.findings.scored, true),
      ),
    )
    .orderBy(desc(schema.findings.weight))
}

/**
 * The informational (unscored) findings on a company's LATEST scan, with that
 * scan — or null when the latest scan never reached the site or there is none.
 *
 * The same "latest" `latestScanWithFindings` means, so the company page's
 * informational section always describes the scan whose score and gaps sit
 * above it; an older successful scan's context under a newer failed scan
 * would be one scan's evidence beside another's verdict. Freshness is the
 * caller's to judge, from `scan.ranAt`, as everywhere else.
 */
export async function latestInformationalFindings(db: AgencyDb, orgId: string, companyId: string) {
  const scans = await db
    .select({ id: schema.scans.id, ranAt: schema.scans.ranAt, ok: schema.scans.ok })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId)))
    .orderBy(desc(schema.scans.ranAt))
    .limit(1)
  const scan = scans[0]
  if (!scan || !scan.ok) return null

  const findings = await db
    .select()
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.orgId, orgId),
        eq(schema.findings.scanId, scan.id),
        eq(schema.findings.scored, false),
      ),
    )
    .orderBy(schema.findings.signalKey)
  return { scan, findings }
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
