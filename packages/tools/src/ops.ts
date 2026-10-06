/**
 * The ops tools: the worker, in chat, in place of a terminal (2026-10-06).
 *
 * The operator chose chat over a shell, and there is no shell by design —
 * §12, and `classifyRisk`'s FORBIDDEN_BUILTINS (packages/core/src/risk.ts)
 * refuse Bash and every filesystem tool. What a person would have opened a
 * terminal for is four tools here:
 * is the worker alive (`worker_status`), what has it complained about
 * (`recent_errors`), what is waiting to go out and why (`queue_status`), and
 * re-scan what has aged (`rescan_stale`). Each answers from the database,
 * and — where the worker runs the turn — from the worker's own view of
 * itself, `ToolContext.ops`. Without it, each says so and answers the rest.
 *
 * Three are reads (`low`). `rescan_stale` is a derived write (`low`, like
 * `scan_company`): it records scans of companies' own public pages through
 * the one writer of a scan and its score (`scanAndRecord`), and nothing else.
 *
 * What reaches the model's context — only `summary` does:
 *
 *  - `worker_status` never prints a host, a URL, an address or a secret. The
 *    heartbeat row's key is `hostname:pid`; it is never read out.
 *  - `recent_errors` prints each kind's message, level, count and instants,
 *    and its error class or code — never a value a log line carried. The
 *    worker keeps nothing else (apps/agent/src/ops/recent-log.ts), and the
 *    error is checked here again against the same allow-list, because a
 *    context built elsewhere is not to be trusted to have done it.
 *  - `queue_status` is counts. No recipient, subject or body is even read.
 *  - `rescan_stale` names a company's own domain, whether the scan reached
 *    the site, and the score computed from what it saw. A scan that did not
 *    reach the site is "unreachable", never a 0 (§2.2), and freshness is
 *    derived from the scan's `ran_at` by `isStale` — never `findings.stale`.
 *
 * Who may: the dashboard and /settings/deployment show the worker line, and
 * /approvals and the dashboard's counters show the queue, to every signed-in
 * member and ask no capability. `chat:use` is the one every member holds, so
 * the three reads ask it — failing closed only for a role `can()` does not
 * know. `rescan_stale` writes evidence about companies and asks
 * `companies:write`, what /companies/import asks.
 */
import { z } from 'zod'
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { can, staleAfterDaysOf, type ScoreResult } from '@agency/core'
import {
  APPLIED_MIGRATION_SQL, EXPECTED_MIGRATION, LINKEDIN_STEP_STUCK_MINUTES, RESCAN_MIN_AGE_HOURS, RESCAN_SCAN_TIMEOUTS,
  companyList, compareSchema, heartbeatReport, heartbeatReportedStatus, parseAppliedMigration,
  readLatestHeartbeat, rescanClaimHeldUntil, rescanQueue, rescanWorstCaseMs,
  type AgencyDb, type CompanyListRow, type HeartbeatReport, type SchemaAgreement,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { UnscannableHostError, isScannableHost, normaliseDomain, scanDomain } from '@agency/scanner'
import {
  TOOL_TEXT_BUDGET, TOOL_TIME_BUDGET_MS, bounded, fail, ok,
  type AgencyToolSpec, type OpsHealth, type OpsLogEntry, type OpsScan, type ToolOutcome,
} from './spec.js'
import { requireIcp, scanAndRecord } from './write.js'

/** Room for `bounded`'s own "… N more rows omitted" line. */
const BUDGET = TOOL_TEXT_BUDGET - 100
const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Words shared by the four
// ---------------------------------------------------------------------------

/** "2026-10-06 09:12 UTC": a moment a person can read, in the one zone the org has. */
function when(d: Date): string {
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unreadable time'
}

function day(d: Date): string {
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'an unreadable date'
}

/** Whole seconds from `at` to `now`, never negative: two machines' clocks, and skew is not the future. */
function secondsSince(at: Date, now: Date): number {
  const ms = now.getTime() - at.getTime()
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
}

/**
 * Whole units, floored — "2 minutes", "less than a minute". The dashboard's
 * `elapsed` (apps/web/src/lib/dashboard-view.ts), restated: this package
 * cannot import the web app, and the page and the tool should read alike.
 */
function elapsed(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const unit = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
  if (s < 60) return 'less than a minute'
  if (s < 3_600) return unit(Math.floor(s / 60), 'minute')
  if (s < 86_400) return unit(Math.floor(s / 3_600), 'hour')
  return unit(Math.floor(s / 86_400), 'day')
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Whitespace folded and cut by CODE POINTS, so a cut never leaves half a character. */
function clip(text: string | null | undefined, max: number): string {
  const chars = Array.from((text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** The class only: a driver error's message can carry the DSN, the address or the words (§2.3). */
function errorClass(err: unknown): string {
  return err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(err.name) ? err.name : 'UnknownError'
}

/** A timestamp a driver handed back as a Date or as Postgres text, or null. */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const at = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(at.getTime()) ? at : null
}

const own = <T>(map: Readonly<Record<string, T>>, key: string | null | undefined): T | undefined =>
  key !== null && key !== undefined && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

/** "email 2, sms 1" — a breakdown in a fixed channel order, then anything else by name. */
function byChannelWords(counts: ReadonlyMap<string, number>): string {
  const order = ['email', 'linkedin', 'sms', 'whatsapp', 'voice']
  const keys = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b)
  })
  return keys.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => `${k} ${counts.get(k)}`).join(', ')
}

// ---------------------------------------------------------------------------
// worker_status
// ---------------------------------------------------------------------------

/**
 * What the worker said it is doing, in the dashboard's words (`OUTREACH_WORDS`
 * and `MAIL_WORDS_BESIDE_SMS` in apps/web/src/lib/dashboard-view.ts, restated).
 * `outreach` is the MAILBOX; beside "texts through DoveSoft", the mail words
 * say email, so they cannot be read as covering texts too.
 */
const OUTREACH_WORDS: Readonly<Record<string, string>> = {
  'send-and-receive': 'sending and receiving',
  'send-only': 'sending, not reading replies',
  'receive-only': 'reading replies, not sending',
  disabled: 'outreach switched off',
}
const MAIL_WORDS_BESIDE_SMS: Readonly<Record<string, string>> = {
  'send-and-receive': 'sending and receiving email',
  'send-only': 'sending email, not reading replies',
  'receive-only': 'reading replies, not sending email',
  disabled: 'email outreach switched off',
}

/** This worker's mailbox, said of itself. */
const MAILBOX_WORDS: Readonly<Record<OpsHealth['outreach'], string>> = {
  'send-and-receive': 'sends email and reads replies',
  'send-only': 'sends email and reads no replies',
  'receive-only': 'reads replies and sends no email',
  disabled: 'off — it sends no email and reads no mailbox',
}

/** The row's own word for a fact it carries in `detail`, or null when it does not say. */
function detailFlag(detail: unknown, key: 'halted' | 'lockHeld'): boolean | null {
  if (typeof detail !== 'object' || detail === null || !(key in detail)) return null
  const value = (detail as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : null
}

/**
 * The newest heartbeat, worded the way the dashboard's worker line words it
 * (`workerLine`), for a reader who is not on a page: the instant is printed
 * in UTC rather than handed to the viewer's zone.
 */
function heartbeatLines(
  r: HeartbeatReport,
  detail: unknown,
  answering: boolean,
): string[] {
  const age = r.ageSeconds
  const lines: string[] = []
  switch (heartbeatReportedStatus(r)) {
    case 'live': {
      const doing = own(r.sms === 'on' ? MAIL_WORDS_BESIDE_SMS : OUTREACH_WORDS, r.outreach)
      // "SMS off" only where the mail words could be read as covering texts.
      const texts =
        r.sms === 'on'
          ? 'texts through DoveSoft'
          : r.sms === 'off' && r.outreach !== 'disabled' && r.outreach !== 'receive-only'
            ? 'SMS off'
            : null
      const chat = r.chat === 'enabled' ? 'chat on' : r.chat === 'disabled' ? 'chat off' : null
      const tail = [doing ?? null, texts, chat].filter((p): p is string => p !== null)
      lines.push(
        `Worker: live — last heard from ${age === null ? 'just now' : `${elapsed(age)} ago`}` +
          `${tail.length > 0 ? ` · ${tail.join(' · ')}` : ''}.`,
      )
      break
    }
    case 'silent':
      lines.push(
        `Worker: silent since ${r.lastSeenAt ? when(r.lastSeenAt) : 'an unknown time'}` +
          `${age === null ? '' : ` — ${elapsed(age)} without a heartbeat`}. ` +
          (answering
            ? 'But the worker answering you now is running, so its own heartbeat is not reaching the database ' +
              '(recent_errors says why, if it logged it); the dashboard and /api/health call it silent until one does.'
            : 'Approved messages wait and no mailbox is read until it is back; on Fly, check that the machine was ' +
              'not scaled to zero.'),
      )
      break
    case 'retired':
      lines.push(
        `Worker: retired — last seen ${r.lastSeenAt ? day(r.lastSeenAt) : 'over a week ago'}, more than a week ` +
          'ago, and no worker has written a heartbeat since, so nothing is sending or reading replies.',
      )
      break
    case 'never':
      lines.push(
        'No worker has ever written a heartbeat to this database — not even the one answering you now, so its ' +
          'heartbeat writes are not reaching the database (recent_errors says why, if it logged it).',
      )
      break
    case 'not_configured':
      lines.push(
        'No worker has ever written a heartbeat to this database, so no worker has sent an email or a text, or ' +
          'read a mailbox, against it.',
      )
      break
  }
  if (r.lastSeenAt !== null) {
    if (detailFlag(detail, 'halted') === true) {
      lines.push(
        'At that heartbeat it reported its runtime HALTED: a tool ran that the approval gate never authorised, ' +
          'and a halted runtime refuses every chat turn until the worker is restarted.',
      )
    }
    if (detailFlag(detail, 'lockHeld') === false) {
      lines.push(
        'At that heartbeat it reported its single-worker lock LOST: another worker could start beside it until ' +
          'it is restarted.',
      )
    }
  }
  return lines
}

/** The migration state, as /api/health computes it, in a sentence. */
function schemaLine(state: SchemaAgreement, applied: string | null): string {
  switch (state) {
    case 'ok':
      return `Schema: the database is at migration ${EXPECTED_MIGRATION}, which is what this code expects.`
    case 'behind':
      return (
        `Schema: the database is at migration ${applied ?? '—'} and this code expects ${EXPECTED_MIGRATION}. ` +
        'Features that need the newer tables fail when they are used: migrate first, then deploy (DEPLOYING.md, ' +
        '"migrate FIRST").'
      )
    case 'ahead':
      return (
        `Schema: the database is at migration ${applied ?? '—'}, ahead of the ${EXPECTED_MIGRATION} this code ` +
        'expects — usually a rollout in progress, and only a problem if this worker is meant to be the current one.'
      )
    case 'unknown':
      return 'Schema: the migration ledger could not be read, so nothing is known about the database’s schema.'
  }
}

/** The worker answering this turn, in its own words. */
function ownViewLines(h: OpsHealth, now: Date): string[] {
  return [
    `The worker answering you booted ${when(h.bootedAt)} (${elapsed(secondsSince(h.bootedAt, now))} ago), ` +
      `${h.version ? `version ${clip(h.version, 40)}` : 'version not recorded (started without npm)'}.`,
    h.halted
      ? 'Runtime: HALTED — a tool ran that the approval gate never authorised, and it refuses every chat turn ' +
        'until it is restarted.'
      : 'Runtime: not halted. It halts — and then refuses every chat turn until it is restarted — if a tool ever ' +
        'runs without the approval gate’s grant.',
    h.lockHeld === true
      ? 'Single-worker lock: held.'
      : h.lockHeld === false
        ? 'Single-worker lock: LOST — another worker could start beside this one until it is restarted.'
        : 'Single-worker lock: not taken yet.',
    `Mailbox: ${MAILBOX_WORDS[h.outreach]}. SMS: ${
      h.sms === 'on'
        ? 'on — approved texts go through DoveSoft'
        : 'off — an approved SMS waits, with no reason on it, until DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID are ' +
          'set where the worker runs'
    }. Chat: ${h.chat === 'enabled' ? 'on' : 'off'}.`,
    h.heartbeatWrittenAt
      ? `Its own heartbeat last reached the database ${elapsed(secondsSince(h.heartbeatWrittenAt, now))} ago.`
      : 'None of its own heartbeats has reached the database since it booted (recent_errors says why, if it logged it).',
  ]
}

async function schemaState(db: AgencyDb): Promise<{ state: SchemaAgreement; applied: string | null }> {
  try {
    // The statement /api/health runs, from the module it runs it from.
    const res: unknown = await db.execute(sql.raw(APPLIED_MIGRATION_SQL))
    // node-postgres and PGlite both answer `{ rows }`.
    const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] } | null)?.rows ?? [])
    const applied = parseAppliedMigration(rows)
    return { state: compareSchema(applied), applied }
  } catch {
    // A missing ledger is an answer, not a fault: nothing is known.
    return { state: 'unknown', applied: null }
  }
}

const workerStatusShape = {}

export const workerStatus: AgencyToolSpec<typeof workerStatusShape> = {
  name: 'worker_status',
  description:
    'Read whether the worker is alive and what it is doing: its newest heartbeat (live, silent, never seen or ' +
    'retired, and whether it sends email, texts and takes chat), the database’s migration against what this code ' +
    'expects, and — from the worker answering you — whether its runtime is halted, whether it holds the ' +
    'single-worker lock and whether its own heartbeat is landing. Use it first when something has not gone out or ' +
    'a reply has not arrived. A read; it prints no host, address or secret.',
  shape: workerStatusShape,
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'chat:use')) {
      return fail('not_permitted', 'The person you are helping cannot read the worker’s status.')
    }
    const now = ctx.now()
    const health = ctx.ops?.health() ?? null

    let row: Awaited<ReturnType<typeof readLatestHeartbeat>> = null
    let heartbeatError: string | null = null
    try {
      row = await readLatestHeartbeat(ctx.db)
    } catch (err) {
      heartbeatError = errorClass(err)
    }
    const { state, applied } = await schemaState(ctx.db)

    // A worker is meant to be running when one is answering: this call runs
    // inside it. Without its own view, configuration is not visible here, and
    // the report's words below claim nothing about it.
    const report = heartbeatReport(row, health !== null, now)
    const status = heartbeatReportedStatus(report)

    await ctx.audit('agent.worker_status', {
      status: heartbeatError ? 'unreadable' : status,
      schema: state,
      ownView: health !== null,
    })

    const lines = [
      ...(heartbeatError
        ? [
            `Worker: the heartbeat could not be read (${heartbeatError}) — most likely the migration that adds it ` +
              'is not applied; the schema line says.',
          ]
        : heartbeatLines(report, row?.detail, health !== null)),
      schemaLine(state, applied),
      ...(health
        ? ownViewLines(health, now)
        : [
            'The worker’s own view — its halt, its lock, what it carries — is not available in this context; the ' +
              'heartbeat above is the last thing a worker said.',
          ]),
    ]

    return ok(
      {
        heartbeat: heartbeatError
          ? null
          : {
              status,
              lastSeenAt: report.lastSeenAt?.toISOString() ?? null,
              ageSeconds: report.ageSeconds,
              outreach: report.outreach,
              sms: report.sms,
              chat: report.chat,
              halted: row ? detailFlag(row.detail, 'halted') : null,
              lockHeld: row ? detailFlag(row.detail, 'lockHeld') : null,
            },
        heartbeatError,
        schema: { state, expected: EXPECTED_MIGRATION, applied },
        worker: health
          ? {
              halted: health.halted,
              lockHeld: health.lockHeld,
              outreach: health.outreach,
              sms: health.sms,
              chat: health.chat,
              bootedAt: health.bootedAt.toISOString(),
              version: health.version,
              heartbeatWrittenAt: health.heartbeatWrittenAt?.toISOString() ?? null,
            }
          : null,
      },
      bounded(lines, BUDGET),
    )
  },
}

// ---------------------------------------------------------------------------
// recent_errors
// ---------------------------------------------------------------------------

/**
 * The only shapes an `error` field may have to be shown: an error CLASS
 * (`TypeError`, `DoveSoftHttpError`) or an upper-case CODE (`ENOTFOUND`).
 * The worker's ring keeps nothing else; this is the same rule, checked again
 * where the words leave for the model.
 */
const ERROR_CLASS = /^[A-Z][A-Za-z0-9]*(Error|Exception)$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/

function shownError(value: unknown): string | null {
  return typeof value === 'string' && (ERROR_CLASS.test(value) || ERROR_CODE.test(value)) ? value : null
}

/** One entry as it may be shown: its own fields, re-checked, and nothing a caller added. */
function shownEntry(e: OpsLogEntry) {
  return {
    level: e.level === 'error' ? ('error' as const) : ('warn' as const),
    message: clip(String(e.msg), 200),
    count: Number.isFinite(e.count) ? Math.max(1, Math.floor(e.count)) : 1,
    firstAt: toDate(e.firstAt),
    lastAt: toDate(e.lastAt),
    error: shownError(e.error),
  }
}

const recentErrorsShape = {
  limit: z
    .number().int().min(1).max(50).optional()
    .describe('How many kinds of warning or error, the most recently seen first. Default 20.'),
}

export const recentErrors: AgencyToolSpec<typeof recentErrorsShape> = {
  name: 'recent_errors',
  description:
    'Read the warnings and errors the worker answering you has logged since it booted, the most recently seen ' +
    'first: each kind’s message, its level, how often and when, and its error class or code where it had one. ' +
    'Only kinds and counts are kept — never the values a log line carried, so no id, address, host or reason. ' +
    'Use it after worker_status to see why something is failing. A read.',
  shape: recentErrorsShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'chat:use')) {
      return fail('not_permitted', 'The person you are helping cannot read the worker’s log.')
    }
    if (!ctx.ops) {
      await ctx.audit('agent.recent_errors', { returned: 0, kinds: 0, ownView: false })
      return ok(
        { kinds: 0, returned: 0, entries: [] },
        'This context keeps no worker log: recent_errors reads the warnings and errors of the worker that runs ' +
          'the chat, and none is attached here. worker_status reads the heartbeat any worker writes.',
      )
    }

    const bootedAt = ctx.ops.health().bootedAt
    const all = ctx.ops
      .recentLog()
      .map(shownEntry)
      .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0))
    const page = all.slice(0, input.limit ?? 20)
    await ctx.audit('agent.recent_errors', { returned: page.length, kinds: all.length, ownView: true })

    const entries = page.map((e) => ({
      level: e.level,
      message: e.message,
      count: e.count,
      firstAt: e.firstAt?.toISOString() ?? null,
      lastAt: e.lastAt?.toISOString() ?? null,
      error: e.error,
    }))

    if (all.length === 0) {
      return ok(
        { kinds: 0, returned: 0, entries },
        `No warning or error has been logged by the worker answering you since it booted (${when(bootedAt)}).`,
      )
    }

    const lines = page.map((e) => {
      const seen = e.lastAt ? `last ${when(e.lastAt)}` : 'last seen at an unreadable time'
      const first = e.count > 1 && e.firstAt ? `, first ${when(e.firstAt)}` : ''
      return `  ${e.level.padEnd(5)} ×${e.count}  ${e.message}${e.error ? ` (${e.error})` : ''} — ${seen}${first}`
    })
    return ok(
      { kinds: all.length, returned: page.length, entries },
      bounded(
        [
          `${plural(all.length, 'kind')} of warning and error logged by the worker answering you since it booted ` +
            `(${when(bootedAt)}), the most recently seen first${page.length < all.length ? `; showing ${page.length}` : ''}.`,
          'Only kinds and counts are kept: each line’s message and level, its error class or code where it had one, ' +
            'how often and when — never a value the line carried (an id, an address, a host, a reason).',
          ...lines,
        ],
        BUDGET,
      ),
    )
  },
}

// ---------------------------------------------------------------------------
// queue_status
// ---------------------------------------------------------------------------

/** The statuses a message can still go out from — the sender's and the compliance page's set. */
const LIVE_STATUSES = ['awaiting_approval', 'approved', 'queued', 'sending'] as const
type LiveStatus = (typeof LIVE_STATUSES)[number]

interface StatusCounts {
  total: number
  /** Due now: nothing scheduled, or scheduled at or before now. Meaningful for approved and queued. */
  due: number
  byChannel: Map<string, number>
  dueByChannel: Map<string, number>
  /** The earliest `scheduled_for` still ahead, among the deferred. */
  nextAt: Date | null
  /** The oldest claim among `sending` rows: when it was last changed. */
  oldestAt: Date | null
}

const emptyCounts = (): StatusCounts => ({
  total: 0, due: 0, byChannel: new Map(), dueByChannel: new Map(), nextAt: null, oldestAt: null,
})

const add = (m: Map<string, number>, k: string, n: number): void => {
  m.set(k, (m.get(k) ?? 0) + n)
}

const earliest = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a < b ? a : b)

/** "3 (email 2, sms 1)", or "none". */
function counted(n: number, byChannel: ReadonlyMap<string, number>): string {
  if (n === 0) return 'none'
  const split = byChannelWords(byChannel)
  return split ? `${n} (${split})` : `${n}`
}

function dueLine(label: string, c: StatusCounts): string {
  if (c.total === 0) return `${label}: none.`
  const deferred = c.total - c.due
  const deferredByChannel = new Map<string, number>()
  for (const [k, n] of c.byChannel) add(deferredByChannel, k, n - (c.dueByChannel.get(k) ?? 0))
  return (
    `${label}: ${c.total} — due now ${counted(c.due, c.dueByChannel)}; deferred ${counted(deferred, deferredByChannel)}` +
    (deferred > 0 && c.nextAt ? `, the earliest may go at ${when(c.nextAt)}` : '') +
    '.'
  )
}

const queueStatusShape = {}

export const queueStatus: AgencyToolSpec<typeof queueStatusShape> = {
  name: 'queue_status',
  description:
    'Read what is waiting to go out for this organisation, and why: drafts awaiting a person’s approval, approved ' +
    'and auto-send messages due now or deferred (and when the next may go), messages being sent, refusals by ' +
    'reason and failures by channel among messages that changed in the last 24 hours, agent tool calls waiting ' +
    'on a person, open LinkedIn steps, ' +
    'and approved messages on a channel this worker carries no provider for. Counts only — no recipient, subject ' +
    'or body. A read.',
  shape: queueStatusShape,
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'chat:use')) {
      return fail('not_permitted', 'The person you are helping cannot read the outbound queue.')
    }
    const now = ctx.now()
    const nowIso = now.toISOString()
    const since = new Date(now.getTime() - DAY_MS).toISOString()
    const health = ctx.ops?.health() ?? null
    const t = schema.touches
    // When a row last changed: the claim, the refusal or the failure is an
    // UPDATE, which the trigger stamps; a row inserted in that state has only
    // its creation. No column records the moment of the refusal itself, and
    // any later UPDATE re-stamps it — deleting or erasing a contact is one
    // (ON DELETE SET NULL) — so the lines say which clock they read (review
    // round 16). Leaving out rows with no contact would hide a real refusal
    // too: an agent's draft names nobody until a person picks the recipient.
    const changedAt = sql`coalesce(${t.updatedAt}, ${t.createdAt})`
    const changedRecently = sql`${changedAt} >= ${since}::timestamptz`

    const [live, refused, failed, agentApprovals, steps] = await Promise.all([
      ctx.db
        .select({
          status: t.status,
          channel: t.channel,
          total: sql<number>`count(*)::int`.mapWith(Number),
          due: sql<number>`(count(*) FILTER (WHERE ${t.scheduledFor} IS NULL OR ${t.scheduledFor} <= ${nowIso}::timestamptz))::int`.mapWith(Number),
          nextAt: sql<Date | null>`min(${t.scheduledFor}) FILTER (WHERE ${t.scheduledFor} > ${nowIso}::timestamptz)`.mapWith(t.scheduledFor),
          oldestAt: sql<Date | null>`min(${changedAt})`.mapWith(t.createdAt),
        })
        .from(t)
        .where(and(eq(t.orgId, ctx.orgId), eq(t.direction, 'out'), inArray(t.status, [...LIVE_STATUSES])))
        .groupBy(t.status, t.channel),
      ctx.db
        .select({ code: t.refusalCode, total: sql<number>`count(*)::int`.mapWith(Number) })
        .from(t)
        .where(and(
          eq(t.orgId, ctx.orgId), eq(t.direction, 'out'), eq(t.status, 'refused'), changedRecently,
        ))
        .groupBy(t.refusalCode),
      ctx.db
        .select({ channel: t.channel, total: sql<number>`count(*)::int`.mapWith(Number) })
        .from(t)
        .where(and(
          eq(t.orgId, ctx.orgId), eq(t.direction, 'out'), eq(t.status, 'failed'), changedRecently,
        ))
        .groupBy(t.channel),
      ctx.db
        .select({
          live: sql<number>`(count(*) FILTER (WHERE ${schema.approvals.expiresAt} > ${nowIso}::timestamptz))::int`.mapWith(Number),
          expired: sql<number>`(count(*) FILTER (WHERE ${schema.approvals.expiresAt} <= ${nowIso}::timestamptz))::int`.mapWith(Number),
        })
        .from(schema.approvals)
        .where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.status, 'pending'))),
      ctx.db
        .select({ open: sql<number>`count(*)::int`.mapWith(Number) })
        .from(schema.tasks)
        .where(and(
          eq(schema.tasks.orgId, ctx.orgId), eq(schema.tasks.kind, 'linkedin_send'), isNull(schema.tasks.doneAt),
        )),
    ])

    const by: Record<LiveStatus, StatusCounts> = {
      awaiting_approval: emptyCounts(), approved: emptyCounts(), queued: emptyCounts(), sending: emptyCounts(),
    }
    for (const r of live) {
      const c = own(by, r.status)
      if (!c) continue
      const total = Number(r.total) || 0
      const due = Number(r.due) || 0
      c.total += total
      c.due += due
      add(c.byChannel, r.channel, total)
      add(c.dueByChannel, r.channel, due)
      c.nextAt = earliest(c.nextAt, toDate(r.nextAt))
      c.oldestAt = earliest(c.oldestAt, toDate(r.oldestAt))
    }
    const refusedByCode = new Map<string, number>()
    for (const r of refused) add(refusedByCode, r.code ?? 'unknown', Number(r.total) || 0)
    const failedByChannel = new Map<string, number>()
    for (const r of failed) add(failedByChannel, r.channel, Number(r.total) || 0)
    const refusedTotal = [...refusedByCode.values()].reduce((a, b) => a + b, 0)
    const failedTotal = [...failedByChannel.values()].reduce((a, b) => a + b, 0)
    const pending = Number(agentApprovals[0]?.live) || 0
    const expired = Number(agentApprovals[0]?.expired) || 0
    const openSteps = Number(steps[0]?.open) || 0

    /** Approved and auto-send rows on one channel: what the sender takes, if it carries the channel. */
    const waitingOn = (channel: string) => ({
      total: (by.approved.byChannel.get(channel) ?? 0) + (by.queued.byChannel.get(channel) ?? 0),
      due: (by.approved.dueByChannel.get(channel) ?? 0) + (by.queued.dueByChannel.get(channel) ?? 0),
    })
    const sms = waitingOn('sms')
    const email = waitingOn('email')
    const linkedin = waitingOn('linkedin')
    // The state the sender's `<channel> rows waiting: no provider` line
    // describes: a row it leaves exactly as it was, with no reason on it.
    const smsWithoutProvider = health && health.sms === 'off' && sms.total > 0 ? sms : null
    const mailboxSends = health ? health.outreach === 'send-and-receive' || health.outreach === 'send-only' : null
    const emailWithoutProvider = health && mailboxSends === false && email.total > 0 ? email : null

    await ctx.audit('agent.queue_status', {
      awaiting: by.awaiting_approval.total,
      approved: by.approved.total,
      queued: by.queued.total,
      sending: by.sending.total,
      refused: refusedTotal,
      failed: failedTotal,
      agentApprovals: pending,
      linkedinSteps: openSteps,
      smsWithoutProvider: smsWithoutProvider?.total ?? 0,
      emailWithoutProvider: emailWithoutProvider?.total ?? 0,
      ownView: health !== null,
    })

    const sending = by.sending
    const lines = [
      `What is waiting to go out for this organisation, as of ${when(now)} — counts only; no recipient, subject ` +
        'or body is read.',
      `Awaiting a person on /approvals: ${counted(by.awaiting_approval.total, by.awaiting_approval.byChannel)}.`,
      dueLine('Approved', by.approved),
      dueLine('Queued by an auto-send campaign', by.queued),
      sending.total === 0
        ? 'Being sent: none.'
        : `Being sent: ${counted(sending.total, sending.byChannel)}` +
          (sending.oldestAt ? `; the oldest claim was taken ${elapsed(secondsSince(sending.oldestAt, now))} ago` : '') +
          '. A claim left by a worker that stopped is marked failed when the worker next boots' +
          ((sending.byChannel.get('linkedin') ?? 0) > 0
            ? `; a LinkedIn hand-over a person started and never finished is failed by /tasks after ` +
              `${LINKEDIN_STEP_STUCK_MINUTES} minutes.`
            : '.'),
      // Which clock, once, before the two lines that read it.
      'Refused and failed below count messages that last CHANGED in the last 24 hours: no column records the ' +
        'moment of a refusal itself, so a later change to an old one — deleting its contact, say — counts it again.',
      refusedTotal === 0
        ? 'Refused in the last 24 hours: none.'
        : `Refused in the last 24 hours: ${refusedTotal} — ` +
          [...refusedByCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([code, n]) => `${code} ${n}`).join(', ') +
          '. Each message carries its reason.',
      failedTotal === 0
        ? 'Failed in the last 24 hours: none.'
        : `Failed in the last 24 hours: ${counted(failedTotal, failedByChannel)}. Each message carries what went ` +
          'wrong; a failed one may or may not have gone, so check before drafting it again.',
      `Agent tool calls waiting on a person: ${pending === 0 ? 'none' : pending}` +
        (expired > 0 ? ` (and ${expired} past ${expired === 1 ? 'its' : 'their'} expiry, not yet swept)` : '') +
        '.',
      `Open LinkedIn steps on /tasks: ${openSteps === 0 ? 'none' : openSteps}.` +
        (linkedin.total > 0 || openSteps > 0
          ? ' A LinkedIn message is sent by a person from /tasks, never by the worker; /tasks lists a step for ' +
            'each approved one when it is opened.'
          : ''),
      ...(smsWithoutProvider
        ? [
            `${plural(smsWithoutProvider.total, 'approved SMS', 'approved SMS')} (${smsWithoutProvider.due} due now) ` +
              `${smsWithoutProvider.total === 1 ? 'waits' : 'wait'} with no SMS provider on this worker: ` +
              `${smsWithoutProvider.total === 1 ? 'it stays' : 'they stay'} approved, with no reason on ` +
              `${smsWithoutProvider.total === 1 ? 'it' : 'them'}, until DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID ` +
              'are set where the worker runs. ' +
              // The sender writes that line, and the worker starts a sender
              // only when it carries a provider: a mailbox or DoveSoft. With
              // SMS off here, that is the mailbox (review round 16).
              (mailboxSends
                ? 'Its log names this state "sms rows waiting: no provider".'
                : 'This worker sends from no mailbox either, so it runs no sender at all, and nothing in its log ' +
                  'names this state.'),
          ]
        : []),
      ...(emailWithoutProvider
        ? [
            `${plural(emailWithoutProvider.total, 'approved email')} (${emailWithoutProvider.due} due now) ` +
              `${emailWithoutProvider.total === 1 ? 'waits' : 'wait'} with no mailbox to send from on this worker: ` +
              `${emailWithoutProvider.total === 1 ? 'it stays' : 'they stay'} approved until SMTP_HOST and ` +
              'MAIL_FROM are set where the worker runs.',
          ]
        : []),
      ...(health === null
        ? [
            'Whether this worker carries email and SMS is not visible in this context: where it does not, an ' +
              'approved message on that channel waits with no reason on it. worker_status reads its heartbeat.',
          ]
        : []),
    ]

    const plain = (m: ReadonlyMap<string, number>) => Object.fromEntries(m)
    const status = (c: StatusCounts) => ({
      total: c.total,
      due: c.due,
      deferred: c.total - c.due,
      byChannel: plain(c.byChannel),
      nextAt: c.nextAt?.toISOString() ?? null,
    })
    return ok(
      {
        asOf: nowIso,
        awaitingApproval: { total: by.awaiting_approval.total, byChannel: plain(by.awaiting_approval.byChannel) },
        approved: status(by.approved),
        queued: status(by.queued),
        sending: {
          total: sending.total,
          byChannel: plain(sending.byChannel),
          oldestClaimAt: sending.oldestAt?.toISOString() ?? null,
        },
        refusedLast24h: { total: refusedTotal, byCode: plain(refusedByCode) },
        failedLast24h: { total: failedTotal, byChannel: plain(failedByChannel) },
        agentApprovals: { pending, expired },
        linkedinSteps: { open: openSteps },
        waitingWithoutProvider: {
          sms: smsWithoutProvider ? smsWithoutProvider.total : health ? 0 : null,
          email: emailWithoutProvider ? emailWithoutProvider.total : health ? 0 : null,
        },
      },
      bounded(lines, BUDGET),
    )
  },
}

// ---------------------------------------------------------------------------
// rescan_stale
// ---------------------------------------------------------------------------

/** The most one call re-scans: a person's request, not the nightly batch. */
const RESCAN_STALE_MAX = 3

/** A company whose evidence is stale or missing, as this tool weighs it. */
interface Due {
  readonly companyId: string
  readonly domain: string
  readonly name: string | null
  /** The newest scan of any outcome — what the floor reads. */
  readonly lastAttemptAt: Date | null
  /** The newest scan that REACHED the site — the evidence, judged by `isStale`. */
  readonly lastOkAt: Date | null
}

/** The newest successful scan of each company in the org. */
async function latestSuccessfulScans(db: AgencyDb, orgId: string): Promise<Map<string, Date>> {
  const rows = await db
    .select({ companyId: schema.scans.companyId, ranAt: max(schema.scans.ranAt) })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.ok, true)))
    .groupBy(schema.scans.companyId)
  const out = new Map<string, Date>()
  for (const r of rows) {
    const at = toDate(r.ranAt)
    if (at) out.set(r.companyId, at)
  }
  return out
}

/**
 * Every company whose LATEST SUCCESSFUL scan is stale or missing, in the
 * order a call takes them: never scanned first, then never reached (the
 * oldest attempt first), then stale (the oldest evidence first).
 *
 * The nightly queue (`rescanQueue`) is the reader, so its rules hold here
 * too — a `*.inbound` company, named after a person by the booking page, is
 * never picked, and staleness is `isStale` against a scan's `ran_at`. What
 * it is handed differs: each row's scan time is the newest scan that
 * REACHED the site, because that is the evidence the send path and every
 * page judge (a newer scan that did not reach it supersedes nothing), where
 * the nightly run reads the newest attempt. Its own floor is therefore
 * turned off here and applied by the caller to the newest ATTEMPT instead.
 */
async function dueForRescan(
  db: AgencyDb,
  orgId: string,
  staleDays: number,
  now: Date,
): Promise<{ readonly companies: number; readonly due: Due[] }> {
  const [rows, okAt] = await Promise.all([companyList(db, orgId), latestSuccessfulScans(db, orgId)])
  const attempt = new Map(rows.map((r) => [r.companyId, r.lastScanAt]))
  // Never attempted first, then the oldest attempt: `rescanQueue` keeps this
  // order among the companies with no evidence (its sort is stable) and puts
  // the stale ones after them, the oldest evidence first.
  const ordered = [...rows].sort((a, b) =>
    a.lastScanAt === null || b.lastScanAt === null
      ? (a.lastScanAt === null ? 0 : 1) - (b.lastScanAt === null ? 0 : 1)
      : a.lastScanAt.getTime() - b.lastScanAt.getTime(),
  )
  const evidence: CompanyListRow[] = ordered.map((r) => ({ ...r, lastScanAt: okAt.get(r.companyId) ?? null }))
  const due = rescanQueue(evidence, { staleDays, now, minAgeHours: 0 }).map((r) => ({
    companyId: r.companyId,
    domain: r.domain,
    name: r.name,
    lastAttemptAt: attempt.get(r.companyId) ?? null,
    lastOkAt: r.lastScanAt,
  }))
  return { companies: rows.length, due }
}

/** A scan that outlived the longest its own timeouts allow: abandoned, never recorded. */
class ScanAbandoned extends Error {
  constructor(ms: number) {
    super(`scan outlived its ${ms} ms worst case`)
    this.name = 'ScanAbandoned'
  }
}

/**
 * `work`, or a `ScanAbandoned` once `ms` have passed — the nightly run's
 * rule (`within` in packages/db/src/rescan.ts): the per-hop timeouts do not
 * bound a body that drips a byte inside each window, so the worst case is
 * enforced rather than assumed. The abandoned request cannot be cancelled,
 * but it never reaches `recordScan`. Unref'd: a background scan must not
 * hold a process open.
 */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScanAbandoned(ms)), ms)
    timer.unref?.()
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

const STILL_RUNNING = Symbol('still running')

/** Each of `work` as it stands after `ms`: its value, or STILL_RUNNING. Never rejects for one that does not. */
async function settledBy<T>(work: readonly Promise<T>[], ms: number): Promise<(T | typeof STILL_RUNNING)[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof STILL_RUNNING>((resolve) => {
    timer = setTimeout(() => resolve(STILL_RUNNING), ms)
  })
  try {
    return await Promise.all(work.map((w) => Promise.race([w, expired])))
  } finally {
    clearTimeout(timer)
  }
}

type Settled =
  | { readonly kind: 'reached' | 'unreachable'; readonly scanId: string; readonly result: ScoreResult }
  | { readonly kind: 'abandoned' | 'refused' }
  | { readonly kind: 'failed'; readonly error: string }

/** The scanner's answer before its detail: "ENOTFOUND", "HTTP 503", "TimeoutError" — never an address. */
function fetchReason(fetchError: string): string {
  return clip((fetchError.split(':')[0] ?? '').trim() || 'no response', 60)
}

function scoreWords(r: ScoreResult): string {
  return `${r.score}/100, ${r.disqualified ? `disqualified — ${clip(r.disqualified, 80)}` : r.tier || 'below threshold'}`
}

function outcomeLine(t: Due, o: Settled | typeof STILL_RUNNING, worstCaseMs: number): string {
  const label = `${t.domain}${t.name ? ` (${clip(t.name, 60)})` : ''}`
  const before = t.lastOkAt
    ? `last observed ${day(t.lastOkAt)}`
    : t.lastAttemptAt
      ? 'no scan had reached the site before'
      : 'never scanned before'
  if (o === STILL_RUNNING) {
    return (
      `  ${label} — still running — ask again shortly; it records itself if it finishes within ` +
      `${Math.round(worstCaseMs / 1000)} seconds of starting, and is abandoned unrecorded after that (${before})`
    )
  }
  switch (o.kind) {
    case 'reached':
      return `  ${label} — reached the site: ${scoreWords(o.result)} (${before})`
    case 'unreachable':
      return (
        `  ${label} — did not reach the site (${fetchReason(o.result.fetchError)}); recorded as unreachable: ` +
        `nothing was observed, so it has no score — not a 0 (${before})`
      )
    case 'abandoned':
      return `  ${label} — abandoned: the scan outlived the longest its timeouts allow, and nothing was recorded (${before})`
    case 'refused':
      return `  ${label} — not scanned: the scanner refuses to request this host, which is not a public site`
    case 'failed':
      return `  ${label} — the scan failed before anything was recorded (${o.error}); nothing was observed (${before})`
  }
}

const rescanShape = {
  limit: z
    .number().int().min(1).max(RESCAN_STALE_MAX).optional()
    .describe(`How many companies to re-scan in this call, at most ${RESCAN_STALE_MAX}. Default 2.`),
}

export interface RescanStaleOptions {
  /** How long a call may wait before it answers. Defaults to `TOOL_TIME_BUDGET_MS`. */
  readonly deadlineMs?: number
  /**
   * The longest one scan may run before it is abandoned unrecorded. Defaults
   * to the nightly run's own, derived from the timeouts the worker binds.
   */
  readonly scanWorstCaseMs?: number
}

/**
 * `rescan_stale`, with its clock. The registered tool is `rescanStale`
 * below; a test builds one with a short deadline, so "still running" is
 * proved without waiting 25 seconds.
 */
export function makeRescanStale(options: RescanStaleOptions = {}): AgencyToolSpec<typeof rescanShape> {
  const deadlineMs = options.deadlineMs ?? TOOL_TIME_BUDGET_MS
  const worstCaseMs = options.scanWorstCaseMs ?? rescanWorstCaseMs(RESCAN_SCAN_TIMEOUTS)
  /**
   * `<org>:<company>` for every scan this tool started whose REQUEST has not
   * ended. A scan still running when a call answered is not started a
   * second time by the next: the person was told to ask again, and asking
   * again must not put two scans of one site side by side. An abandoned
   * scan keeps its key until the scanner's own promise settles, because
   * abandoning it closes nothing — its request is still open to the site.
   */
  const inFlight = new Set<string>()

  return {
    name: 'rescan_stale',
    description:
      `Re-scan a few companies (2 by default, at most ${RESCAN_STALE_MAX}) whose evidence is stale or missing — ` +
      'no scan that reached the site within the ICP’s freshness window — the oldest first, by requesting only ' +
      'their own public pages: posture review from the outside, not a security test. It answers within about ' +
      `${Math.round(deadlineMs / 1000)} seconds; a scan still running then records itself if it finishes within ` +
      `${Math.round(worstCaseMs / 1000)} seconds of starting, the longest its timeouts allow, and is abandoned ` +
      'unrecorded after that. ' +
      'Never scans an inbound lead with no website or a host the scanner refuses, skips a company tried in the ' +
      `last ${RESCAN_MIN_AGE_HOURS} hours, and does nothing while the nightly rescan is running.`,
    shape: rescanShape,
    async handler(input, ctx): Promise<ToolOutcome<unknown>> {
      const startedAt = Date.now()
      if (!can(ctx.principal, 'companies:write')) {
        return fail('not_permitted', 'The person you are helping cannot record scans of companies. Nothing was scanned.')
      }
      const icp = await requireIcp(ctx.db, ctx.orgId)
      if (!icp) {
        return fail('invalid_state', 'No active ICP profile that can be read, so a scan would have nothing to be scored against.')
      }
      // Never the raw value: `isStale` throws on one that is not a positive number.
      const staleDays = staleAfterDaysOf(icp.definition)
      const now = ctx.now()
      const limit = input.limit ?? 2

      // The nightly run CLAIMS each org before it selects anything; while a
      // claim holds, a scan started here could request the same site beside
      // it, before either is recorded. So read the claim, under its lock —
      // and take none: a claim taken here would make the night's delivery
      // skip this org until tomorrow.
      const heldUntil = await rescanClaimHeldUntil(ctx.db, ctx.orgId, now)
      const { companies, due: queue } = await dueForRescan(ctx.db, ctx.orgId, staleDays, now)
      if (heldUntil) {
        await ctx.audit('agent.rescan_stale', {
          scanned: 0, reached: 0, unreachable: 0, abandoned: 0, failed: 0, stillRunning: 0, skipped: 0,
          remaining: queue.length, companyIds: [],
          cronRunning: true,
        })
        return ok(
          { cronRunning: true, heldUntil: heldUntil.toISOString(), due: queue.length, scanned: 0, companies: [] },
          `The nightly rescan is running for this organisation now — its claim holds until ${when(heldUntil)} — ` +
            'so nothing was scanned, to keep two scans of one site from running side by side. ' +
            `${plural(queue.length, 'company', 'companies')} had stale or missing evidence when it was asked; ` +
            'ask again after that.',
        )
      }

      const floorMs = RESCAN_MIN_AGE_HOURS * 3_600_000
      const key = (companyId: string): string => `${ctx.orgId}:${companyId}`
      const skipped: Due[] = []
      const running: Due[] = []
      const waiting: Due[] = []
      const eligible: Due[] = []
      for (const d of queue) {
        // A refused host takes no slot: it would never be requested at all.
        if (!isScannableHost(normaliseDomain(d.domain))) skipped.push(d)
        else if (inFlight.has(key(d.companyId))) running.push(d)
        else if (d.lastAttemptAt !== null && now.getTime() - d.lastAttemptAt.getTime() < floorMs) waiting.push(d)
        else eligible.push(d)
      }
      const picked = eligible.slice(0, limit)

      // The worker's scanner, bound to the nightly run's timeouts; the same
      // binding here when no worker handed one in.
      const scan: OpsScan =
        ctx.ops?.scan ?? ((domain, definition, o) => scanDomain(domain, definition, { ...o, ...RESCAN_SCAN_TIMEOUTS }))
      const work = picked.map((target) => {
        const k = key(target.companyId)
        const release = (): void => {
          inFlight.delete(k)
        }
        inFlight.add(k)
        let requested = false
        // The key is released when the scanner's own promise settles, never
        // when the race against the worst case is lost.
        const boundedScan: OpsScan = (domain, definition, o) => {
          requested = true
          const request = Promise.resolve().then(() => scan(domain, definition, o))
          request.then(release, release)
          return within(request, worstCaseMs)
        }
        // Through the one writer of a scan and its score. It never rejects:
        // a scan that outlives this call settles in the background, records
        // itself if it finishes within its worst case, and must not become
        // an unhandled rejection.
        return scanAndRecord(ctx, target.domain, target.companyId, target.name, icp, boundedScan)
          .then((out): Settled => ({
            kind: out.result.reachable ? 'reached' : 'unreachable', scanId: out.scanId, result: out.result,
          }))
          .catch((err: unknown): Settled =>
            err instanceof UnscannableHostError
              ? { kind: 'refused' }
              : err instanceof ScanAbandoned
                ? { kind: 'abandoned' }
                : { kind: 'failed', error: errorClass(err) },
          )
          .finally(() => {
            // Refused or failed before any request was made: nothing holds the site.
            if (!requested) release()
          })
      })
      const outcomes = await settledBy(work, Math.max(0, deadlineMs - (Date.now() - startedAt)))

      const kinds = outcomes.map((o) => (o === STILL_RUNNING ? 'still_running' : o.kind))
      const reached = kinds.filter((k) => k === 'reached').length
      const stillRunning = kinds.filter((k) => k === 'still_running').length
      const refusedAtScan = kinds.filter((k) => k === 'refused').length
      // Only a scan RECORDED as unreachable is one; an abandoned or failed
      // scan recorded nothing, and is counted as what it was.
      const unreachable = kinds.filter((k) => k === 'unreachable').length
      const abandoned = kinds.filter((k) => k === 'abandoned').length
      const failed = kinds.filter((k) => k === 'failed').length
      const remaining = queue.length - reached

      await ctx.audit('agent.rescan_stale', {
        scanned: picked.length,
        reached,
        unreachable,
        abandoned,
        failed,
        stillRunning,
        skipped: skipped.length + refusedAtScan,
        remaining,
        companyIds: picked.map((p) => p.companyId),
        cronRunning: false,
      })

      const more = eligible.length - picked.length
      const why = [
        more > 0 ? `${more} more can be scanned by asking again` : null,
        running.length > 0
          ? `${running.length} ${running.length === 1 ? 'is' : 'are'} still being scanned from an earlier request`
          : null,
        waiting.length > 0
          ? `${waiting.length} ${waiting.length === 1 ? 'was' : 'were'} tried in the last ${RESCAN_MIN_AGE_HOURS} ` +
            'hours and will not be tried again until then (scan_company re-scans one now)'
          : null,
        skipped.length > 0
          ? `${skipped.length} ${skipped.length === 1 ? 'has a domain' : 'have domains'} the scanner refuses to ` +
            `request — not a public site — so ${skipped.length === 1 ? 'it is' : 'they are'} never scanned`
          : null,
      ].filter((p): p is string => p !== null)

      // Only the summary reaches the model: every count and every company's
      // outcome is said here, not left in `data`.
      const window = `no scan that reached the site in the last ${plural(staleDays, 'day')}`
      const head =
        companies === 0
          ? 'There are no companies in the CRM, so nothing was scanned.'
          : queue.length === 0
            ? 'No company has stale or missing evidence: every one with a website has a scan that reached it within ' +
              `the last ${plural(staleDays, 'day')}, so nothing was scanned.`
            : picked.length === 0
              ? `${plural(queue.length, 'company', 'companies')} ${queue.length === 1 ? 'has' : 'have'} stale or ` +
                `missing evidence (${window}), and none can be scanned by this call.`
              : `Re-scanned ${picked.length} of the ${plural(queue.length, 'company', 'companies')} whose evidence ` +
                `was stale or missing (${window}), the oldest first, by requesting only their own public pages — ` +
                'posture review from the outside, not a security test.'
      const tail =
        queue.length === 0
          ? []
          : [
              remaining === 0
                ? 'No company has stale or missing evidence now.'
                : `${plural(remaining, 'company', 'companies')} still ${remaining === 1 ? 'has' : 'have'} stale or ` +
                  `missing evidence${why.length > 0 ? `: ${why.join('; ')}` : ''}. Nothing may be quoted from a ` +
                  'company until a scan that reached its site is current.',
              ...(reached > 0
                ? ['get_company reads what a new scan observed; get_evidence_changes compares it with the scan before.']
                : []),
            ]

      return ok(
        {
          cronRunning: false,
          staleAfterDays: staleDays,
          due: queue.length,
          scanned: picked.length,
          reached,
          unreachable,
          abandoned,
          failed,
          stillRunning,
          skipped: skipped.length + refusedAtScan,
          waiting: waiting.length,
          runningFromEarlier: running.length,
          remaining,
          companies: picked.map((t, i) => {
            const o = outcomes[i]
            const done = o === undefined || o === STILL_RUNNING ? null : o
            const result = done && (done.kind === 'reached' || done.kind === 'unreachable') ? done : null
            return {
              companyId: t.companyId,
              domain: t.domain,
              name: t.name,
              outcome: kinds[i] ?? 'still_running',
              scanId: result?.scanId ?? null,
              // A scan that did not reach the site has no score — never a 0 (§2.2).
              score: result?.kind === 'reached' ? result.result.score : null,
              tier: result?.kind === 'reached' ? result.result.tier || null : null,
              qualified: result?.kind === 'reached' ? result.result.qualified : null,
              disqualifiedReason: result?.kind === 'reached' ? result.result.disqualified || null : null,
              lastObservedAt: t.lastOkAt?.toISOString() ?? null,
            }
          }),
        },
        bounded([head, ...picked.map((t, i) => outcomeLine(t, outcomes[i] ?? STILL_RUNNING, worstCaseMs)), ...tail], BUDGET),
      )
    },
  }
}

export const rescanStale: AgencyToolSpec<typeof rescanShape> = makeRescanStale()
