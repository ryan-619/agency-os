/**
 * The daily digest the cron builds (§2.3, §2.4): what needs a person this
 * morning, as counts, ids and domains — never a name, an address or a body.
 *
 * `GET /api/cron/digest` asks here for the facts, posts them to Slack, and
 * records that it did. Everything with a rule in it lives in this file and
 * is tested against a real Postgres; the route is the gate, the loop over
 * orgs and the two posts.
 *
 * Three things this has to get right, each of which looks fine and is not:
 *
 *   * **Every number is somebody else's rule, restated nowhere.** Unhandled
 *     replies are the inbox's count, due and overdue tasks are `tasksCounts`,
 *     refusals are the compliance page's "when was it refused", rotting is
 *     core's `rottingState` over the same `updated_at` the board reads, and
 *     staleness is `isStale` over the latest scan's `ran_at` — never
 *     `findings.stale`, which is a cache (§2.2). A digest that computed its
 *     own "rotting" would tell the channel about deals the board does not
 *     mark, and nobody could say which one was right.
 *   * **An opt-out that was not recorded is three audit actions, not one.**
 *     `contact.opt_out_not_recorded` (a reply), `unsubscribe.not_recorded`
 *     (the link) and `contact.erasure_failed` (an erasure that could not
 *     suppress first) are each §2.1's Phase 4 obligation failing loudly; the
 *     digest counts all three, because counting one is how the other two go
 *     unread.
 *   * **Idempotent across duplicate deliveries.** Vercel may deliver one
 *     cron event more than once. A `cron.digest` audit row in the last
 *     twenty hours means this org's digest has run, and `digestOnce` takes a
 *     transaction-scoped advisory lock BEFORE looking for it, so two
 *     deliveries arriving together serialise: the second waits, then finds
 *     the first one's row and does nothing. A check without the lock is a
 *     race both deliveries win.
 *
 * The audit row carries counts only — no domain list, no ids of people —
 * because /audit shows it to every member and Slack already had the rest.
 */
import { and, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { DEFAULT_STALE_AFTER_DAYS, isStale, rottingState } from '@agency/core'
import * as schema from './schema.js'
import { appendAudit } from './approvals.js'
import { complianceRefusalsByCode } from './compliance.js'
import { inboxUnhandledCount } from './inbox.js'
import { tasksCounts } from './tasks.js'
import type { AgencyDb } from './repository.js'

/** An org with a `cron.digest` row younger than this is skipped. */
export const DIGEST_WINDOW_HOURS = 20

/** Refusals, unrecorded opt-outs and model spend are counted over this. */
export const DIGEST_LOOKBACK_HOURS = 24

/** How many rotting domains the message names. */
export const DIGEST_TOP_ROTTING = 5

/**
 * The audit actions that mean somebody asked to be left alone and no
 * suppression row was written. Each writer's own comment names the digest
 * as a reader; this is that reader.
 */
export const DIGEST_OPT_OUT_FAILURES = Object.freeze([
  'contact.opt_out_not_recorded',
  'unsubscribe.not_recorded',
  'contact.erasure_failed',
] as const)

const HOUR_MS = 3_600_000

/**
 * The `digest` notification's fields, less `kind`, `orgId` and `worker`
 * (`apps/web/src/lib/slack-message.ts` owns the event; the worker's status
 * is the web's to read). Nothing here can hold a person: counts, refusal
 * codes, a dollar figure and company domains.
 */
export interface DigestFacts {
  /** Tool calls parked on a person (unexpired) plus drafts awaiting approval — the /approvals page's two lists. */
  readonly pendingApprovals: number
  readonly unhandledReplies: number
  readonly rottingDeals: number
  /** Companies whose latest scan has aged past the ICP's threshold. */
  readonly staleCompanies: number
  readonly neverScanned: number
  /** Open tasks due in the next 24 hours (`tasksCounts`' `dueToday`). */
  readonly dueTasks: number
  readonly overdueTasks: number
  readonly refusals24h: readonly { readonly code: string; readonly n: number }[]
  readonly optOutsNotRecorded24h: number
  /** Summed by Postgres and rounded to cents there: `cost_usd` is a string. */
  readonly spend24hUsd: string
  /** Company domains, most rotten first, at most `DIGEST_TOP_ROTTING`. */
  readonly topRotting: readonly string[]
}

export interface DigestOptions {
  readonly now: Date
  /** The ICP's `freshness.stale_after_days`. */
  readonly staleDays?: number
}

/**
 * A booking from a free-mail address files the PERSON as a company named
 * `<address>.inbound` (booking.ts). It has no website: the rescan never
 * picks it, so counting it as "never scanned" would put a number in the
 * digest that no job can ever bring to zero. It is still a deal and can
 * still rot — `slackMessage` says "a personal address" in its place.
 */
function isPersonPlaceholder(domain: string): boolean {
  return domain.endsWith('.inbound')
}

/**
 * Everything the digest says about one org, at `now`.
 *
 * Every read is scoped to the org; the heartbeat is not, and is not read
 * here. The 24-hour windows start at `now - 24h`, inclusive, as the
 * refusal count's does (`complianceRefusalsByCode`), and the two counted
 * here also end at `now`, so a fixed clock gives a fixed answer.
 */
export async function digestFacts(db: AgencyDb, orgId: string, opts: DigestOptions): Promise<DigestFacts> {
  const now = opts.now
  const staleDays = opts.staleDays ?? DEFAULT_STALE_AFTER_DAYS
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    throw new Error(`staleDays must be a positive number, got ${String(staleDays)}`)
  }
  const since = new Date(now.getTime() - DIGEST_LOOKBACK_HOURS * HOUR_MS)

  const [approvals, drafts, unhandledReplies, rotting, evidence, tasks, refusals, optOuts, spend] =
    await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.orgId, orgId),
            eq(schema.approvals.status, 'pending'),
            // A lapsed row nobody swept yet cannot be decided; it is not work.
            gt(schema.approvals.expiresAt, now),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.touches)
        .where(
          and(
            eq(schema.touches.orgId, orgId),
            eq(schema.touches.direction, 'out'),
            eq(schema.touches.status, 'awaiting_approval'),
          ),
        ),
      inboxUnhandledCount(db, orgId),
      rottingDomains(db, orgId, now),
      evidenceCounts(db, orgId, staleDays, now),
      tasksCounts(db, orgId, now),
      complianceRefusalsByCode(db, orgId, since, 0),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.orgId, orgId),
            inArray(schema.auditLog.action, [...DIGEST_OPT_OUT_FAILURES]),
            gte(schema.auditLog.createdAt, since),
            lte(schema.auditLog.createdAt, now),
          ),
        ),
      db
        .select({
          usd: sql<string>`round(coalesce(sum(${schema.chatMessages.costUsd}), 0), 2)::text`,
        })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.orgId, orgId),
            gte(schema.chatMessages.createdAt, since),
            lte(schema.chatMessages.createdAt, now),
          ),
        ),
    ])

  return {
    pendingApprovals: Number(approvals[0]?.n ?? 0) + Number(drafts[0]?.n ?? 0),
    unhandledReplies,
    rottingDeals: rotting.count,
    staleCompanies: evidence.stale,
    neverScanned: evidence.neverScanned,
    dueTasks: tasks.dueToday,
    overdueTasks: tasks.overdue,
    refusals24h: refusals.byCode.map((r) => ({ code: r.code, n: r.n })),
    optOutsNotRecorded24h: Number(optOuts[0]?.n ?? 0),
    spend24hUsd: spend[0]?.usd ?? '0.00',
    topRotting: rotting.top,
  }
}

/**
 * Open deals past their stage's threshold, by core's rule over the column
 * the board reads (`updated_at`, else `created_at`). Most rotten first:
 * furthest past the threshold, then the longest untouched, then by domain so
 * the order is total.
 */
async function rottingDomains(
  db: AgencyDb,
  orgId: string,
  now: Date,
): Promise<{ readonly count: number; readonly top: readonly string[] }> {
  const rows = await db
    .select({
      stage: schema.deals.stage,
      createdAt: schema.deals.createdAt,
      updatedAt: schema.deals.updatedAt,
      domain: schema.companies.domain,
    })
    .from(schema.deals)
    .innerJoin(
      schema.companies,
      and(eq(schema.companies.id, schema.deals.companyId), eq(schema.companies.orgId, orgId)),
    )
    .where(and(eq(schema.deals.orgId, orgId), isNull(schema.deals.closedAt)))

  const rotten: { readonly domain: string; readonly over: number; readonly days: number }[] = []
  for (const r of rows) {
    const rot = rottingState(r.stage, r.updatedAt ?? r.createdAt, now)
    if (rot?.rotten) rotten.push({ domain: r.domain, over: rot.days - rot.threshold, days: rot.days })
  }
  rotten.sort((a, b) => b.over - a.over || b.days - a.days || a.domain.localeCompare(b.domain))
  return { count: rotten.length, top: rotten.slice(0, DIGEST_TOP_ROTTING).map((r) => r.domain) }
}

/**
 * Companies by their LATEST scan: none (never scanned) or one aged past the
 * threshold (stale) — the rescan cron's own notion of due, less its
 * twenty-hour floor. A latest scan that could not reach the site is judged
 * by its age like any other, because that is when the rescan retries it.
 */
async function evidenceCounts(
  db: AgencyDb,
  orgId: string,
  staleDays: number,
  now: Date,
): Promise<{ readonly stale: number; readonly neverScanned: number }> {
  const [companies, latest] = await Promise.all([
    db
      .select({ id: schema.companies.id, domain: schema.companies.domain })
      .from(schema.companies)
      .where(eq(schema.companies.orgId, orgId)),
    db
      .selectDistinctOn([schema.scans.companyId], { companyId: schema.scans.companyId, ranAt: schema.scans.ranAt })
      .from(schema.scans)
      .where(eq(schema.scans.orgId, orgId))
      .orderBy(schema.scans.companyId, desc(schema.scans.ranAt)),
  ])
  const lastScan = new Map(latest.map((s) => [s.companyId, s.ranAt]))
  let stale = 0
  let neverScanned = 0
  for (const c of companies) {
    if (isPersonPlaceholder(c.domain)) continue
    const ranAt = lastScan.get(c.id)
    if (ranAt === undefined) neverScanned += 1
    else if (isStale(ranAt, staleDays, now)) stale += 1
  }
  return { stale, neverScanned }
}

/** Whether this org's digest has run since `since` — any `cron.digest` row, posted or not. */
export async function digestAlreadySent(db: AgencyDb, orgId: string, since: Date): Promise<boolean> {
  const rows = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.action, 'cron.digest'),
        gte(schema.auditLog.createdAt, since),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Run `fn` for this org at most once per window, under a lock.
 *
 * One transaction: take `pg_advisory_xact_lock`, look for a `cron.digest`
 * row since `since`, and only then run `fn` with the transaction — which
 * posts and writes the row before the lock is released at COMMIT. A second
 * delivery blocks on the lock and then sees the committed row. The lock is
 * transaction-scoped because a session lock does not survive the pooled
 * URL, and it uses the TWO-key form so it lives in a different key space
 * from the worker's lifetime lock (a single bigint): a hash collision with
 * that one would park this function until the platform killed it.
 *
 * `fn` runs inside the transaction, so every write it makes must use the
 * handle it is given — on Vercel the pool is one connection and this
 * transaction is holding it. A throw rolls everything back and the next
 * delivery runs afresh; a post that went out before a failed COMMIT is the
 * one case that can repeat, and it needs the database to fail between two
 * statements.
 */
export async function digestOnce<T>(
  db: AgencyDb,
  orgId: string,
  since: Date,
  fn: (tx: AgencyDb) => Promise<T>,
): Promise<{ readonly ran: true; readonly value: T } | { readonly ran: false }> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cron.digest'), hashtext(${orgId}))`)
    if (await digestAlreadySent(t, orgId, since)) return { ran: false as const }
    return { ran: true as const, value: await fn(t) }
  })
}

/** What `cron.digest` records: numbers and codes. No domain and no id of a person. */
export interface DigestCounts {
  readonly pendingApprovals: number
  readonly unhandledReplies: number
  readonly rottingDeals: number
  readonly staleCompanies: number
  readonly neverScanned: number
  readonly dueTasks: number
  readonly overdueTasks: number
  readonly refusals24h: number
  readonly refusalsByCode: Readonly<Record<string, number>>
  readonly optOutsNotRecorded24h: number
  readonly spend24hUsd: string
}

/** The facts with the domains taken out. */
export function digestCounts(facts: DigestFacts): DigestCounts {
  const refusalsByCode: Record<string, number> = {}
  let refusals = 0
  for (const r of facts.refusals24h) {
    refusalsByCode[r.code] = r.n
    refusals += r.n
  }
  return {
    pendingApprovals: facts.pendingApprovals,
    unhandledReplies: facts.unhandledReplies,
    rottingDeals: facts.rottingDeals,
    staleCompanies: facts.staleCompanies,
    neverScanned: facts.neverScanned,
    dueTasks: facts.dueTasks,
    overdueTasks: facts.overdueTasks,
    refusals24h: refusals,
    refusalsByCode,
    optOutsNotRecorded24h: facts.optOutsNotRecorded24h,
    spend24hUsd: facts.spend24hUsd,
  }
}

/** Why a digest that ran did not reach Slack. */
export type DigestNotPosted = 'no_slack' | 'slack_failed'

/** The worker's status as the digest reported it — `HeartbeatReport['status']`. */
export type DigestWorker = 'never' | 'live' | 'silent' | 'not_configured'

export type DigestRecord = {
  readonly orgId: string
  readonly counts: DigestCounts
  readonly worker?: DigestWorker
  /**
   * The separate worker-silent alert: not needed, posted, failed, or not
   * posted because there is no Slack. Its own `notification.*` row carries
   * the delivery; this says whether the run meant to send one.
   */
  readonly workerAlert?: 'not_needed' | 'posted' | 'failed' | 'no_slack'
} & ({ readonly posted: true } | { readonly posted: false; readonly why: DigestNotPosted })

/**
 * The run's record, and the row `digestAlreadySent` looks for. Written
 * whether or not anything was posted: with no Slack the run is still the
 * record, and a duplicate delivery must still find it.
 */
export async function digestRecord(db: AgencyDb, record: DigestRecord): Promise<void> {
  await appendAudit(db, {
    orgId: record.orgId,
    actor: 'system',
    action: 'cron.digest',
    detail: {
      posted: record.posted,
      ...(record.posted ? {} : { why: record.why }),
      counts: record.counts,
      ...(record.worker ? { worker: record.worker } : {}),
      ...(record.workerAlert ? { workerAlert: record.workerAlert } : {}),
    },
  })
}
