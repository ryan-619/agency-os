/**
 * Scan history and the signal-by-signal diff between the two most recent
 * successful scans, as data for the company page and the agent (§2.2).
 *
 * Two rules, each one a way the obvious query goes wrong:
 *
 * **A score is read through the scan it was computed from.** `scores.scan_id`
 * exists (0006) because "the latest score" and "the latest scan" used to be
 * independent lookups, and a page could show one scan's number above another
 * scan's evidence. History is the same trap repeated N times, so every row
 * here is a scan with the score whose `scan_id` names it — never the score
 * whose `computed_at` happens to sit near the scan's `ran_at`.
 *
 * **A scan that never reached the site has no score to report.** `recordScan`
 * writes a score row for it anyway — 0, disqualified as `unreachable (…)` —
 * and a history that passed that 0 through would put a timeout on a chart
 * beside real measurements. Nothing was observed, so the reader reports
 * `ok: false` with `score: null`, and a consumer cannot render the 0 because
 * it never receives it. `scan.error` carries the reason.
 *
 * `scans.raw` is never selected: it is the whole capture (headers, bodies up
 * to 1.5 MB, TLS) and nothing here needs it.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { diffFindings, diffInputOf, type FindingDiff } from '@agency/core'
import * as schema from './schema.js'
import type { Finding } from './schema.js'
import type { AgencyDb } from './repository.js'

export interface ScanHistoryRow {
  readonly scan: { id: string; ranAt: Date; ok: boolean; error: string | null }
  /** NULL for a scan that did not reach the site, whatever row `scores` holds for it. */
  readonly score: {
    score: number
    tier: string | null
    qualified: boolean
    disqualifiedReason: string | null
    icpProfileId: string
    computedAt: Date
  } | null
}

/** A scan without its capture — what the diff needs to say which two scans it compared. */
export interface EvidenceScan {
  readonly id: string
  readonly companyId: string
  readonly ranAt: Date
  readonly ok: boolean
  readonly error: string | null
}

export interface EvidenceScanWithFindings {
  readonly scan: EvidenceScan
  /** Weight descending, then signal key — the order the company page reads. */
  readonly findings: Finding[]
}

const SCAN_HISTORY_MAX = 100

/** A limit a caller cannot turn into "every scan ever" or into NaN. */
function historyLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20
  return Math.min(Math.max(Math.trunc(limit), 1), SCAN_HISTORY_MAX)
}

/**
 * Every scan of a company, newest first, each with THE score computed from it.
 *
 * The score is a LATERAL subquery keyed on `scores.scan_id`, newest
 * `computed_at` first, so a scan that was ever scored twice is still one row
 * with one score — a plain join would repeat the scan, and `LIMIT` would then
 * count scores rather than scans.
 */
export async function scanHistory(
  db: AgencyDb,
  orgId: string,
  companyId: string,
  limit = 20,
): Promise<ScanHistoryRow[]> {
  const scored = db
    .select({
      score: schema.scores.score,
      tier: schema.scores.tier,
      qualified: schema.scores.qualified,
      disqualifiedReason: schema.scores.disqualifiedReason,
      icpProfileId: schema.scores.icpProfileId,
      computedAt: schema.scores.computedAt,
    })
    .from(schema.scores)
    .where(and(eq(schema.scores.orgId, orgId), eq(schema.scores.scanId, schema.scans.id)))
    .orderBy(desc(schema.scores.computedAt))
    .limit(1)
    .as('scan_score')

  const rows = await db
    .select({
      id: schema.scans.id,
      ranAt: schema.scans.ranAt,
      ok: schema.scans.ok,
      error: schema.scans.error,
      score: scored.score,
      tier: scored.tier,
      qualified: scored.qualified,
      disqualifiedReason: scored.disqualifiedReason,
      icpProfileId: scored.icpProfileId,
      computedAt: scored.computedAt,
    })
    .from(schema.scans)
    .leftJoinLateral(scored, sql`true`)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId)))
    // `id` only so two scans stamped in the same instant come back in a
    // stable order; it carries no meaning.
    .orderBy(desc(schema.scans.ranAt), desc(schema.scans.id))
    .limit(historyLimit(limit))

  return rows.map((r) => ({
    scan: { id: r.id, ranAt: r.ranAt, ok: r.ok, error: r.error },
    score:
      r.ok && r.score !== null && r.qualified !== null && r.icpProfileId !== null && r.computedAt !== null
        ? {
            score: r.score,
            tier: r.tier,
            qualified: r.qualified,
            disqualifiedReason: r.disqualifiedReason,
            icpProfileId: r.icpProfileId,
            computedAt: r.computedAt,
          }
        : null,
  }))
}

/** Every finding on one scan, in this org — `[]` for a scan that is not the org's. */
export async function findingsForScan(db: AgencyDb, orgId: string, scanId: string): Promise<Finding[]> {
  return db
    .select()
    .from(schema.findings)
    .where(and(eq(schema.findings.orgId, orgId), eq(schema.findings.scanId, scanId)))
    .orderBy(desc(schema.findings.weight), schema.findings.signalKey)
}

/**
 * The two most recent scans that REACHED the site, with their findings — or
 * null when there are fewer than two.
 *
 * A failed scan in between is skipped rather than compared against: it has no
 * findings (`recordScan` writes none, and a trigger refuses `observed` on it),
 * so diffing against it would read every signal as unobserved — true, and
 * useless, and it would hide what actually changed between the two
 * observations either side of it. The history above still shows it.
 */
export async function latestTwoOkScans(
  db: AgencyDb,
  orgId: string,
  companyId: string,
): Promise<{ newer: EvidenceScanWithFindings; older: EvidenceScanWithFindings } | null> {
  const scans = await db
    .select({
      id: schema.scans.id,
      companyId: schema.scans.companyId,
      ranAt: schema.scans.ranAt,
      ok: schema.scans.ok,
      error: schema.scans.error,
    })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId), eq(schema.scans.ok, true)))
    .orderBy(desc(schema.scans.ranAt), desc(schema.scans.id))
    .limit(2)

  const [newer, older] = scans
  if (!newer || !older) return null

  const [newerFindings, olderFindings] = await Promise.all([
    findingsForScan(db, orgId, newer.id),
    findingsForScan(db, orgId, older.id),
  ])
  return {
    newer: { scan: newer, findings: newerFindings },
    older: { scan: older, findings: olderFindings },
  }
}

/**
 * `latestTwoOkScans` run through `diffFindings`: the two scans compared, and
 * the diff. Null when there are fewer than two successful scans — there is
 * nothing to compare, and that is not the same as "nothing changed".
 *
 * Freshness is the caller's to judge from `newer.ranAt`, as everywhere else;
 * a diff may be shown when stale, but never quoted outbound.
 */
export async function latestEvidenceChanges(
  db: AgencyDb,
  orgId: string,
  companyId: string,
): Promise<{ newer: EvidenceScan; older: EvidenceScan; diff: FindingDiff } | null> {
  const pair = await latestTwoOkScans(db, orgId, companyId)
  if (!pair) return null
  return {
    newer: pair.newer.scan,
    older: pair.older.scan,
    diff: diffFindings(pair.older.findings.map(diffInputOf), pair.newer.findings.map(diffInputOf)),
  }
}
