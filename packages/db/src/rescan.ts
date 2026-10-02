/**
 * The daily bounded rescan the Vercel cron runs (§2.2, §8.3).
 *
 * `findings.stale` is a cache written only when somebody scans, and nothing
 * scanned on a schedule — so a pipeline nobody re-verified by hand aged out
 * silently. This is `npm run scan -- --stale` on a timer, with the three
 * things a timer needs that a person at a terminal does not:
 *
 *   * a CAP. `RESCAN_BATCH_SIZE` scans per org per run, one at a time: the
 *     web pool is `DATABASE_POOL_MAX=1` on Vercel and `recordScan` is a
 *     transaction, so two in flight would queue on one connection at best;
 *   * a FLOOR. A company scanned in the last twenty hours is never picked, so
 *     a delivery that arrives after another has FINISHED does nothing twice;
 *   * a CLAIM, for the delivery that arrives while another is still running.
 *     The floor cannot see a scan that has not been recorded yet: two
 *     overlapping deliveries both read the queue before either commits, and
 *     every company was scanned twice — double the requests to a prospect's
 *     site, two scan rows minutes apart. `claimRescan` settles it per org, in
 *     a transaction under an advisory lock, before anything is selected (see
 *     below). The digest does the same for the same reason (`digestOnce`);
 *     "no lock is needed" was true only of the sequential case;
 *   * a DEADLINE, derived from the timeouts the scan is actually handed —
 *     see `rescanWorstCaseMs` and the dispatch rule in `runRescan`.
 *
 * The scan function is INJECTED. `packages/db` has no `@agency/scanner`
 * dependency and gains none, and the tests drive the orchestration with
 * hand-built profiles instead of the network. The route passes `scanDomain`.
 *
 * It is not a scan button: nobody clicks it, and a person still scans one
 * company with `npm run scan -- <domain>`. `recordScan` stays the only writer
 * of findings; the scanner's frozen path list is untouched.
 */
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import {
  isStale, staleAfterDaysOf,
  type IcpDefinition, type SiteProfile,
} from '@agency/core'
import * as schema from './schema.js'
import { appendAudit } from './approvals.js'
import {
  companyList, markStaleFindings, recordScan,
  type AgencyDb, type CompanyListRow,
} from './repository.js'

/** A company scanned more recently than this is never picked. */
export const RESCAN_MIN_AGE_HOURS = 20

/**
 * The per-hop timeouts the cron hands the scanner — shorter than the CLI's
 * defaults (12 s / 8 s), because a function has a ceiling and a terminal
 * does not. The route passes exactly these, and `rescanWorstCaseMs` is
 * computed from exactly these, so the two cannot disagree.
 */
export const RESCAN_SCAN_TIMEOUTS = { homeTimeoutMs: 8_000, pathTimeoutMs: 6_000 } as const

/**
 * `packages/scanner/src/fetch.ts`, restated because this package may not
 * import it. `get()` allows `timeoutMs × (MAX_REDIRECTS + 1)` for ONE URL —
 * the per-hop timeout is a socket-inactivity timeout and a redirect chain may
 * spend it eleven times — and `fetchTls` waits 8 s for a handshake.
 * `test/rescan.test.ts` reads fetch.ts and fails if either number moves.
 */
export const RESCAN_SCANNER_HOPS = 11
export const RESCAN_TLS_TIMEOUT_MS = 8_000

/**
 * Held back from the function's ceiling for everything after the last scan
 * returns: its `recordScan` (up to the pool's 10 s connect timeout), the
 * audit row, the JSON answer, and a cold start the handler never sees.
 */
export const RESCAN_MARGIN_MS = 60_000

/**
 * The longest one scan can take, given the timeouts it was handed:
 *
 *   worstCaseScanMs = homeTimeoutMs × 11 + pathTimeoutMs × 11 + 8 000
 *
 * `capture()` awaits the homepage, THEN the public paths (concurrently, so
 * one path's worst case bounds them all), THEN the TLS probe. With the cron's
 * 8 s / 6 s that is 162 s — more than half a 300 s ceiling, for one company.
 * A rule of "stop dispatching after 240 s" would start a scan at 239 s that
 * may run to 400 s, and the platform would kill the function mid-run with the
 * audit row and the answer unwritten.
 */
export function rescanWorstCaseMs(t: { readonly homeTimeoutMs: number; readonly pathTimeoutMs: number }): number {
  return t.homeTimeoutMs * RESCAN_SCANNER_HOPS + t.pathTimeoutMs * RESCAN_SCANNER_HOPS + RESCAN_TLS_TIMEOUT_MS
}

/**
 * A booking from a free-mail address creates a company named after the
 * PERSON — `jane-doe-gmail-com.inbound` — for a human to fix (booking.ts).
 * It names no website. Scanning it would resolve somebody's email address as
 * a DNS name, every run, at whatever resolver the platform uses: personal
 * data leaving the building in exchange for an "unreachable" row about a
 * company that does not exist.
 */
function isPersonPlaceholder(domain: string): boolean {
  return domain.endsWith('.inbound')
}

export interface RescanQueueOptions {
  readonly staleDays: number
  readonly now: Date
  readonly minAgeHours: number
}

/**
 * Every company due for a rescan, in the order a run takes them: never
 * scanned first, then the oldest scan first. Uncapped.
 *
 * Due means never scanned, or its newest scan has aged past the ICP's
 * threshold — judged by `isStale` against the scan's `ran_at` (§2.2), never
 * by `findings.stale`, the cache this job exists to keep honest — AND that
 * scan is older than the floor.
 */
export function rescanQueue(rows: readonly CompanyListRow[], opts: RescanQueueOptions): CompanyListRow[] {
  if (!Number.isFinite(opts.minAgeHours) || opts.minAgeHours < 0) {
    throw new Error(`minAgeHours must be a non-negative number, got ${String(opts.minAgeHours)}`)
  }
  const floorMs = opts.minAgeHours * 3_600_000
  const now = opts.now.getTime()
  const due = rows.filter((r) => {
    if (isPersonPlaceholder(r.domain)) return false
    if (r.lastScanAt === null) return true
    if (!(now - r.lastScanAt.getTime() > floorMs)) return false
    return isStale(r.lastScanAt, opts.staleDays, opts.now)
  })
  // Stable, so never-scanned companies keep companyList's domain order.
  return due.sort((a, b) => {
    if (a.lastScanAt === null || b.lastScanAt === null) {
      return (a.lastScanAt === null ? 0 : 1) - (b.lastScanAt === null ? 0 : 1)
    }
    return a.lastScanAt.getTime() - b.lastScanAt.getTime()
  })
}

/** What one run would scan if nothing were refused: the head of the queue. */
export function selectRescanTargets(
  rows: readonly CompanyListRow[],
  opts: RescanQueueOptions & { readonly batch: number },
): CompanyListRow[] {
  if (!Number.isInteger(opts.batch) || opts.batch < 1) {
    throw new Error(`batch must be a positive integer, got ${String(opts.batch)}`)
  }
  return rescanQueue(rows, opts).slice(0, opts.batch)
}

/**
 * Claim one org's run for this delivery, before anything is selected — or
 * learn that another delivery holds it.
 *
 * One short transaction: take `pg_advisory_xact_lock` on the org, look for a
 * live `scan.cron_started` row, and only if there is none write one. A second
 * delivery arriving together blocks on the lock, then reads the committed
 * claim and skips the org. The lock is transaction-scoped because a session
 * lock does not survive the pooled URL, and it takes the TWO-key form, in a
 * different key space from the worker's lifetime lock — `digestOnce`'s
 * reasoning, verbatim.
 *
 * A claim holds for as long as the run it guards can last, and no longer:
 * `until` is the claim's moment plus the run's own budget plus
 * `RESCAN_MARGIN_MS` — the route hands `runRescan` what is left of the
 * function's ceiling less that margin, so `until` is the ceiling at the
 * latest. Stored on the row rather than assumed by the reader, so a delivery
 * with less time left cannot read a longer run's claim as expired. A run
 * that dies holds nothing past its ceiling, and a manual `curl` later in the
 * day claims afresh (the floor still decides what it picks). A claim whose
 * `until` cannot be read holds nothing: it is not evidence of a run.
 */
export async function claimRescan(
  db: AgencyDb,
  input: {
    readonly orgId: string
    readonly now: Date
    /** What the run about to start may spend — the same number handed to `runRescan`. */
    readonly budgetMs: number
    readonly actor?: string
    readonly schedule?: string | null
  },
): Promise<{ readonly claimed: true } | { readonly claimed: false; readonly heldUntil: Date }> {
  const now = input.now.getTime()
  const until = new Date(now + Math.max(0, input.budgetMs) + RESCAN_MARGIN_MS)
  // Any claim still live was written minutes ago; the floor bounds the read.
  const lookback = new Date(now - RESCAN_MIN_AGE_HOURS * 3_600_000)
  return db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cron.rescan'), hashtext(${input.orgId}))`)
    const claims = await t
      .select({ detail: schema.auditLog.detail })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.orgId, input.orgId),
          eq(schema.auditLog.action, 'scan.cron_started'),
          gte(schema.auditLog.createdAt, lookback),
        ),
      )
    for (const c of claims) {
      const held = claimUntil(c.detail)
      if (held !== null && held.getTime() > now) return { claimed: false as const, heldUntil: held }
    }
    await appendAudit(t, {
      orgId: input.orgId,
      actor: input.actor ?? 'system',
      action: 'scan.cron_started',
      detail: {
        until: until.toISOString(),
        // A header, so bounded: it is recorded, never trusted.
        schedule: input.schedule ? input.schedule.slice(0, 64) : null,
      },
    })
    return { claimed: true as const }
  })
}

/** A claim row's `until`, or null when it holds none that can be read. */
function claimUntil(detail: unknown): Date | null {
  if (typeof detail !== 'object' || detail === null || !('until' in detail)) return null
  const raw = (detail as { until: unknown }).until
  if (typeof raw !== 'string') return null
  const at = new Date(raw)
  return Number.isFinite(at.getTime()) ? at : null
}

/** The route passes `scanDomain`; a test passes a hand-built profile. */
export type RescanScan = (domain: string, company: string | undefined) => Promise<{ raw: unknown; profile: SiteProfile }>

/** Every org, oldest first, so a run visits them in the same order each day. */
export async function listOrgIds(db: AgencyDb): Promise<string[]> {
  const rows = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .orderBy(asc(schema.orgs.createdAt), asc(schema.orgs.id))
  return rows.map((r) => r.id)
}

export interface RescanDeps {
  readonly orgId: string
  readonly icp: { readonly id: string; readonly definition: IcpDefinition }
  readonly scan: RescanScan
  /**
   * Milliseconds from the start of this call by which every scan it
   * dispatches must be able to FINISH — not a point after which it stops
   * starting them. The route passes what is left of the function's ceiling
   * less `RESCAN_MARGIN_MS`.
   */
  readonly budgetMs: number
  /** `rescanWorstCaseMs` of the timeouts `scan` uses. */
  readonly scanWorstCaseMs: number
  /** Scans attempted per run. A refused host costs no request and no slot. */
  readonly batch: number
  readonly minAgeHours?: number
  /** Measures elapsed time and decides what is due. The route passes the wall clock. */
  readonly now: () => Date
  /** True for a refusal to scan the host at all (the route: `UnscannableHostError`). */
  readonly unscannable?: (err: unknown) => boolean
  readonly actor?: string
  /** Vercel's `x-vercel-cron-schedule` header, recorded so a run can be told from a manual one. */
  readonly schedule?: string | null
}

export interface RescanResult {
  /** Taken off the queue this run: scanned + unreachable + skipped. */
  readonly picked: number
  /** The site answered and the scan was recorded. */
  readonly scanned: number
  /**
   * The site could not be observed: recorded as an honest `ok: false` scan,
   * or the attempt threw — or outlived its worst case and was abandoned —
   * before anything could be recorded.
   */
  readonly unreachable: number
  /** The host was refused before any request; nothing was written. */
  readonly skipped: number
  /** Due and not attempted this run. Tomorrow's run starts with them. */
  readonly remaining: number
  readonly elapsedMs: number
  /** Why the run stopped taking companies: the queue ran dry, the batch was spent, or the budget was. */
  readonly stoppedBy: 'done' | 'batch' | 'budget'
}

/** A scan that outlived the longest its own timeouts allow. */
class ScanAbandoned extends Error {
  constructor(ms: number) {
    super(`scan outlived its ${ms} ms worst case`)
    this.name = 'ScanAbandoned'
  }
}

/**
 * Wait for `work` at most `ms`. The timeouts bound every hop but not a body
 * that drips one byte inside each inactivity window, so the worst case the
 * dispatch rule relies on is ENFORCED here rather than assumed. The abandoned
 * request cannot be cancelled — the scanner takes no signal — but it never
 * reaches `recordScan`, which only ever sees the winner of this race.
 */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScanAbandoned(ms)), ms)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

/**
 * One org's run: sweep, select, scan one at a time, record, audit.
 *
 * The dispatch rule, stated once:
 *
 *   dispatch the next company only if  elapsed + scanWorstCaseMs ≤ budgetMs
 *
 * so a scan that starts is one that can finish, however slow the site, and
 * the audit row below is always written inside the function's ceiling.
 *
 * Per company: a refused host is `skipped`; any other throw is `unreachable`
 * and the loop continues; a site that did not answer is recorded through
 * `recordScan` as an `ok: false` scan with no findings — nothing observed,
 * nothing claimed. A scan abandoned at its worst case ends the run: its
 * sockets are still open and cannot be closed, and starting another beside
 * it would be the overlap this function exists to prevent.
 *
 * One `scan.cron_run` audit row per org per run, counts only — no domain,
 * no error text. Hobby keeps runtime logs for an hour; this is the ledger.
 */
export async function runRescan(db: AgencyDb, deps: RescanDeps): Promise<RescanResult> {
  if (!Number.isInteger(deps.batch) || deps.batch < 1) {
    throw new Error(`batch must be a positive integer, got ${String(deps.batch)}`)
  }
  if (!Number.isFinite(deps.scanWorstCaseMs) || deps.scanWorstCaseMs <= 0) {
    throw new Error(`scanWorstCaseMs must be a positive number, got ${String(deps.scanWorstCaseMs)}`)
  }
  const started = deps.now()
  const elapsed = (): number => deps.now().getTime() - started.getTime()
  const icp = deps.icp.definition
  // Never the raw value: `markStaleFindings` and `isStale` both throw on one
  // that is not a positive number, and a bad profile must not stop the cron.
  const staleDays = staleAfterDaysOf(icp)

  // The sweep first, as the CLI does, so the cache is current for every
  // reader — even though the selection below does not trust it.
  await markStaleFindings(db, deps.orgId, staleDays)

  const queue = rescanQueue(await companyList(db, deps.orgId), {
    staleDays,
    now: started,
    minAgeHours: deps.minAgeHours ?? RESCAN_MIN_AGE_HOURS,
  })

  let scanned = 0
  let unreachable = 0
  let skipped = 0
  let stoppedBy: RescanResult['stoppedBy'] = 'done'

  for (const target of queue) {
    if (scanned + unreachable >= deps.batch) { stoppedBy = 'batch'; break }
    if (elapsed() + deps.scanWorstCaseMs > deps.budgetMs) { stoppedBy = 'budget'; break }

    let outcome: Awaited<ReturnType<RescanScan>>
    try {
      outcome = await within(
        Promise.resolve().then(() => deps.scan(target.domain, target.name ?? undefined)),
        deps.scanWorstCaseMs,
      )
    } catch (err) {
      if (deps.unscannable?.(err)) { skipped++; continue }
      unreachable++
      if (err instanceof ScanAbandoned) { stoppedBy = 'budget'; break }
      continue
    }

    try {
      await recordScan(db, {
        orgId: deps.orgId,
        companyId: target.companyId,
        icpProfile: deps.icp,
        raw: outcome.raw,
        profile: outcome.profile,
      })
      if (outcome.profile.fetchOk) scanned++
      else unreachable++
    } catch {
      unreachable++
    }
  }

  const picked = scanned + unreachable + skipped
  const result: RescanResult = {
    picked,
    scanned,
    unreachable,
    skipped,
    remaining: queue.length - picked,
    elapsedMs: elapsed(),
    stoppedBy,
  }

  await appendAudit(db, {
    orgId: deps.orgId,
    actor: deps.actor ?? 'system',
    action: 'scan.cron_run',
    detail: {
      ...result,
      // A header, so bounded: it is recorded, never trusted.
      schedule: deps.schedule ? deps.schedule.slice(0, 64) : null,
    },
  })

  return result
}
