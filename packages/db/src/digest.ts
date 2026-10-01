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
 *     race both deliveries win. (PGlite runs one transaction at a time, so
 *     the suite shows the sequential half and pins the lock by its source;
 *     only real Postgres can show the overlap.)
 *   * **A campaign that paused itself is announced once.** The worker pauses
 *     a campaign whose addresses bounce (`campaign.auto_paused`) and has no
 *     Slack path of its own; the digest is the web-side reader of those rows,
 *     inside the same once-per-day guard, and reads strictly after the
 *     high-water mark the previous run recorded — the stored `(created_at,
 *     id)` of the last pause it read — so two runs never announce one pause,
 *     and a pause stamped between two clocks is still read by one of them.
 *
 * The audit row carries counts only — and the pause mark, which is another
 * audit row's id and instant — no domain list and no ids of people, because
 * /audit shows it to every member and Slack already had the rest.
 */
import { and, desc, eq, gt, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm'
import { DEFAULT_STALE_AFTER_DAYS, isStale, rottingState } from '@agency/core'
import * as schema from './schema.js'
import { appendAudit } from './approvals.js'
import { complianceRefusalsByCode } from './compliance.js'
import type { HeartbeatReportedStatus } from './heartbeat-read.js'
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
 * At most this many `campaign_paused` notices per run. Each is one Slack
 * post at its three-second timeout inside the digest's transaction, and the
 * route budgets an org's run for them before starting it — so the cap is
 * what keeps that budget a number. The rows past it are counted in the
 * `cron.digest` row (`campaignPauses`), not dropped silently.
 */
export const DIGEST_MAX_PAUSE_NOTICES = 3

/**
 * The `digest` notification's fields, less `kind`, `orgId` and `worker`
 * (`apps/web/src/lib/slack-message.ts` owns the event; the worker's status
 * is the web's to read). Counts, refusal codes, a dollar figure and
 * company domains — no field can hold a name, an address or a body. The
 * one domain that is not a company's, a free-mail lead's `<address>.inbound`
 * row, may appear in `topRotting`; `slackMessage` never says it.
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

/** One bounce auto-pause, as the `campaign_paused` notice carries it: an id and two numbers. */
export interface DigestCampaignPause {
  readonly campaignId: string
  readonly bouncePct: number
  readonly threshold: number
}

/**
 * Where a run stopped reading `campaign.auto_paused` rows — the high-water
 * mark the next run reads strictly after. Kept in the `cron.digest` row as
 * `campaignPauses.readThrough`.
 *
 * `at` is the row's `created_at` as the DATABASE stored it, to the
 * microsecond, in UTC ISO text — never a JavaScript `Date`, which holds
 * milliseconds and would put the mark up to 999µs before the row it names
 * (the /audit cursor's trap: `listAudit` in audit.ts). `id` breaks the tie
 * between rows one transaction stamped with the same `now()`. A run that has
 * never read a pause, and had no mark to carry, records the instant it read
 * up to with `id: null`.
 */
export interface DigestPauseMark {
  readonly at: string
  readonly id: string | null
}

/**
 * How far back the previous run's `cron.digest` row is looked for. Wider
 * than a day on purpose: Vercel fires a cron anywhere inside its minute, so
 * on about half of days the previous run is a little more than 24 hours
 * old, and a failed day makes it two. A previous run older than this is not
 * looked for, and the run reads the 24-hour lookback instead.
 */
export const DIGEST_MARK_LOOKBACK_DAYS = 7

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

/** `created_at` to the microsecond, in UTC, as ISO text — read in SQL, so no `Date` ever holds it. */
const createdAtText = sql<string>`to_char(${schema.auditLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/**
 * The campaigns that paused themselves since the previous digest, oldest
 * first — at most `DIGEST_MAX_PAUSE_NOTICES` of them, how many there were in
 * all, and the mark this run read through (record it in `digestRecord`).
 *
 * Both ends of the window are on ONE clock. The upper end is the route's
 * `now`. The lower end is the previous run's mark: the stored `(created_at,
 * id)` of the last pause it read, compared in SQL, read strictly after. It
 * used to be the previous `cron.digest` row's own `created_at` — Postgres
 * `now()` at that transaction's start, a different clock from the `now` the
 * previous run had read up to — so a pause stamped between the route taking
 * `now` and the digest's BEGIN was read by neither run, and with the web's
 * clock ahead of the database's, one stamped the other way round was read by
 * both. Anything this run's upper end leaves out is after its mark, so the
 * next run reads it: whatever the two clocks say, a pause is read once.
 *
 * With no mark — no previous run in `DIGEST_MARK_LOOKBACK_DAYS`, or one from
 * before the mark was recorded — the window is the 24-hour lookback, started
 * no earlier than that previous row when there is one, as before: a manual
 * run twenty-one hours after the scheduled one would otherwise read three
 * hours of pauses the scheduled one already announced. A run that reads
 * nothing carries the previous mark forward rather than moving it to its own
 * `now`, so a pause the database stamped before this run read, and committed
 * after, is still after the mark.
 *
 * Call it BEFORE `digestRecord`, inside `digestOnce`, where the newest
 * `cron.digest` row is the previous run's. The rows past the cap are read —
 * counted in `found` and passed by the mark, so the digest says how many
 * more there were — and never announced one by one. Ids and the two numbers
 * the pause was made on — never who bounced (the writer stores nothing else).
 */
export async function digestCampaignPauses(
  db: AgencyDb,
  orgId: string,
  opts: { readonly now: Date },
): Promise<{
  readonly pauses: readonly DigestCampaignPause[]
  readonly found: number
  readonly readThrough: DigestPauseMark
}> {
  const t = schema.auditLog
  const lookback = new Date(opts.now.getTime() - DIGEST_LOOKBACK_HOURS * HOUR_MS)
  const [previous] = await db
    .select({ id: t.id, detail: t.detail })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.action, 'cron.digest'),
        gte(t.createdAt, new Date(opts.now.getTime() - DIGEST_MARK_LOOKBACK_DAYS * 24 * HOUR_MS)),
      ),
    )
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(1)
  const mark = previous ? pauseMarkIn(previous.detail) : null

  let after: SQL | undefined
  if (mark?.id) {
    // The marked row's STORED created_at, by id, as /audit's cursor reads it;
    // the text is exact too, and stands in only if the row is gone.
    after = sql`(${t.createdAt}, ${t.id}) > (
      COALESCE(
        (SELECT m.created_at FROM audit_log m WHERE m.id = ${mark.id}::uuid AND m.org_id = ${orgId}::uuid),
        ${mark.at}::timestamptz
      ),
      ${mark.id}::uuid
    )`
  } else if (mark) {
    after = sql`${t.createdAt} > ${mark.at}::timestamptz`
  } else if (previous) {
    // A previous run that recorded no mark: after its own row, strictly, and inside the lookback.
    after = and(
      gte(t.createdAt, lookback),
      sql`${t.createdAt} > (SELECT p.created_at FROM audit_log p WHERE p.id = ${previous.id}::uuid AND p.org_id = ${orgId}::uuid)`,
    )
  } else {
    after = gte(t.createdAt, lookback)
  }

  const rows = await db
    .select({ id: t.id, at: createdAtText, campaignId: t.subjectId, detail: t.detail })
    .from(t)
    .where(and(eq(t.orgId, orgId), eq(t.action, 'campaign.auto_paused'), after, lte(t.createdAt, opts.now)))
    .orderBy(t.createdAt, t.id)
  const pauses: DigestCampaignPause[] = []
  for (const r of rows) {
    const bouncePct = numberIn(r.detail, 'bouncePct')
    const threshold = numberIn(r.detail, 'threshold')
    // A row that does not say which campaign, or on what numbers, is not one a notice can be honest about.
    if (r.campaignId === null || bouncePct === null || threshold === null) continue
    pauses.push({ campaignId: r.campaignId, bouncePct, threshold })
  }
  // Past every row read, the skipped ones included: a row that cannot be announced today cannot be tomorrow.
  const last = rows.at(-1)
  const readThrough: DigestPauseMark = last
    ? { at: last.at, id: last.id }
    : mark ?? { at: opts.now.toISOString(), id: null }
  return { pauses: pauses.slice(0, DIGEST_MAX_PAUSE_NOTICES), found: pauses.length, readThrough }
}

/** The mark a `cron.digest` row recorded, or null for a row from before there was one, or one that does not parse. */
function pauseMarkIn(detail: unknown): DigestPauseMark | null {
  if (typeof detail !== 'object' || detail === null) return null
  const pauses = (detail as Record<string, unknown>)['campaignPauses']
  if (typeof pauses !== 'object' || pauses === null) return null
  const mark = (pauses as Record<string, unknown>)['readThrough']
  if (typeof mark !== 'object' || mark === null) return null
  const { at, id } = mark as Record<string, unknown>
  if (typeof at !== 'string' || !ISO_INSTANT.test(at)) return null
  if (id === null) return { at, id: null }
  return typeof id === 'string' && UUID.test(id) ? { at, id } : null
}

function numberIn(detail: unknown, key: string): number | null {
  if (typeof detail !== 'object' || detail === null || !(key in detail)) return null
  const v = (detail as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
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

/**
 * The worker's status as the digest reported it — `heartbeatReportedStatus`:
 * `HeartbeatReport['status']`, or `retired` for a closed session nobody is
 * alerted about.
 */
export type DigestWorker = HeartbeatReportedStatus

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
  /**
   * The bounce auto-pauses this run read (`digestCampaignPauses`): how many
   * there were, how many Slack took a notice for, and the mark the run read
   * through, which the next run reads strictly after. `found > posted` is a
   * pause that got no notice of its own — past the cap (the digest says how
   * many), a failed post, or no Slack.
   */
  readonly campaignPauses?: {
    readonly found: number
    readonly posted: number
    readonly readThrough: DigestPauseMark
  }
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
      ...(record.campaignPauses
        ? {
            campaignPauses: {
              found: record.campaignPauses.found,
              posted: record.campaignPauses.posted,
              readThrough: { at: record.campaignPauses.readThrough.at, id: record.campaignPauses.readThrough.id },
            },
          }
        : {}),
    },
  })
}
