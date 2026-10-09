/**
 * Reading the newest worker heartbeat, for /api/health and the deployment
 * page (§2.4). The READ half only: the writer lives in heartbeat.ts and is
 * exported from the package root alone, never from ./queries — a web bundle
 * that could write a heartbeat could report a worker it invented.
 *
 * Why the row exists: Fly scales a machine to zero between requests, and a
 * worker that was scaled away looks fine from outside. `/readyz` answers on a
 * machine that was just woken, approvals land on nothing, and nothing says
 * the tick stopped. A heartbeat that stops is that fact as a timestamp.
 *
 * Two different facts meet here and neither is allowed to overrule the
 * other. Whether THIS web deployment is configured to reach a worker is
 * configuration (`deployment().worker`); whether a worker has written to
 * THIS database, and when, is an observation. A worker on Fly writing to a
 * database whose web half has no `AGENT_URL` is sending mail all the same —
 * so a live row reads `live` whatever the configuration says, and only the
 * ABSENCE of a row is qualified by it (`not_configured` against `never`).
 *
 * Everything below the query is pure, so the transitions are tested at
 * fixed instants rather than against a clock.
 */
import { desc } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import type { WorkerHeartbeat } from './schema.js'

/** The worker's outreach mode — `/readyz`'s vocabulary, and the CHECK's. */
export type HeartbeatOutreach = 'disabled' | 'send-only' | 'send-and-receive' | 'receive-only'
/** Whether the worker can take a chat turn. Never which credential it uses (§2.3). */
export type HeartbeatChat = 'enabled' | 'disabled'
/**
 * Whether the worker sends SMS through DoveSoft (0019): `on` with both
 * DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID on its host, `off` otherwise.
 * Separate from `outreach`, which describes the MAILBOX only — a worker with
 * no SMTP and DoveSoft on reports `outreach: 'disabled'` and sends texts.
 */
export type HeartbeatSms = 'on' | 'off'

/**
 * How long a worker may go unheard before it is called silent, when nothing
 * better is known. Forty sender ticks at the default fifteen seconds: long
 * enough that one slow tick or a database blip is not an alarm, short enough
 * that a machine scaled to zero is named within ten minutes rather than
 * noticed days later as a queue that stopped moving.
 */
export const HEARTBEAT_SILENT_AFTER_SECONDS = 600

/**
 * Where NO worker is configured, a silent row older than this is a retired
 * session rather than a worker that stopped. `./tools/run-worker.sh` run
 * once against production and closed leaves its row behind, and only a
 * running worker's own write prunes the table — so without a horizon that
 * row raised the worker-silent alert every morning forever, the daily noise
 * that teaches a channel to ignore the one alert that matters. A week,
 * because a worker that was running and stopped is worth a week of notices
 * first. The one place this number lives: `workerSilent` on the web reads
 * it from here.
 */
export const HEARTBEAT_RETIRED_AFTER_DAYS = 7

/**
 * How many missed ticks make a worker silent when the row says how often it
 * ticks. A worker configured with a twenty-minute tick is not silent eleven
 * minutes after its last write; it is on time. The threshold is the larger
 * of the two, so a fast tick never makes the alarm twitchier than the
 * default.
 */
const MISSED_TICKS = 3

/**
 * The newest heartbeat any worker has written, or null when none has.
 *
 * Newest by `last_tick_at`, not by `booted_at` or insertion: during a
 * rollout the outgoing worker's row and the incoming one's both exist, and
 * the question is whether ANYTHING is ticking.
 */
export async function readLatestHeartbeat(db: AgencyDb): Promise<WorkerHeartbeat | null> {
  const [row] = await db
    .select()
    .from(schema.workerHeartbeats)
    .orderBy(desc(schema.workerHeartbeats.lastTickAt))
    .limit(1)
  return row ?? null
}

/**
 * Whole seconds since the row's last tick, or null when there is no row.
 *
 * Never negative. The worker stamps `last_tick_at` with its own clock and the
 * web reads it with another machine's, so a row a second "in the future" is
 * skew between two hosts, not a worker that has yet to tick — and an age of
 * -1 is a number nobody should have to interpret.
 */
export function heartbeatAge(row: { readonly lastTickAt: Date } | null, now: Date): number | null {
  if (row === null) return null
  return Math.max(0, Math.floor((now.getTime() - row.lastTickAt.getTime()) / 1000))
}

/**
 * `never` (no row), `live` (heard within the threshold, inclusive) or
 * `silent` (not heard for longer than it).
 */
export function heartbeatStatus(
  row: { readonly lastTickAt: Date } | null,
  now: Date,
  silentAfterSeconds: number = HEARTBEAT_SILENT_AFTER_SECONDS,
): 'never' | 'live' | 'silent' {
  const age = heartbeatAge(row, now)
  if (age === null) return 'never'
  return age <= silentAfterSeconds ? 'live' : 'silent'
}

/**
 * The silence threshold for one row: the default, or three of the worker's
 * own ticks if that is longer. The tick interval is read from the row's
 * `detail` because only the worker knows it; a row that does not carry one —
 * or carries something that is not a positive number — gets the default.
 */
export function heartbeatSilentAfter(row: { readonly detail: unknown } | null): number {
  const detail = row?.detail
  const intervalMs =
    typeof detail === 'object' && detail !== null && 'intervalMs' in detail
      ? (detail as { intervalMs: unknown }).intervalMs
      : null
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return HEARTBEAT_SILENT_AFTER_SECONDS
  }
  return Math.max(HEARTBEAT_SILENT_AFTER_SECONDS, Math.ceil((intervalMs * MISSED_TICKS) / 1000))
}

/**
 * What the row says about SMS, from `detail.sms` — written by
 * `apps/agent/src/worker.ts` beside `halted` and `lockHeld`, because the
 * table's `outreach` column and its CHECK predate DoveSoft. Null for no row,
 * and for a row that does not carry `on` or `off`: a worker from before 0019
 * wrote nothing, and a value nobody defined is not guessed at.
 */
export function heartbeatSms(row: { readonly detail: unknown } | null): HeartbeatSms | null {
  const detail = row?.detail
  const sms = typeof detail === 'object' && detail !== null && 'sms' in detail ? (detail as { sms: unknown }).sms : null
  return sms === 'on' || sms === 'off' ? sms : null
}

/**
 * Whether the worker writes the morning brief (0020), from `detail.brief` —
 * `on` where it has a model, as chat needs. Null for no row, and for a row
 * that does not say: a worker started before 0020 writes none, whatever its
 * chat says, and the Assistant page says to restart it.
 */
export function heartbeatBrief(row: { readonly detail: unknown } | null): 'on' | 'off' | null {
  const detail = row?.detail
  const brief =
    typeof detail === 'object' && detail !== null && 'brief' in detail ? (detail as { brief: unknown }).brief : null
  return brief === 'on' || brief === 'off' ? brief : null
}

/**
 * Whether this worker runs the night shift (0025): `detail.night`, `on` when
 * it holds the Google key Places needs, `off` without. Null for no row and
 * for a worker from before 0025, which never ran one.
 */
export function heartbeatNight(row: { readonly detail: unknown } | null): 'on' | 'off' | null {
  const detail = row?.detail
  const night =
    typeof detail === 'object' && detail !== null && 'night' in detail ? (detail as { night: unknown }).night : null
  return night === 'on' || night === 'off' ? night : null
}

/**
 * Whether a mailbox accepted the worker's login (`apps/agent/src/outreach/
 * mail-login.ts`), from `detail.smtpLogin` or `detail.imapLogin`. Null for no
 * row, a worker with no such mailbox, and a worker from before the check —
 * none of which says anything about a login.
 */
export type HeartbeatMailLogin = 'unchecked' | 'ok' | 'refused' | 'unreachable'

export function heartbeatMailLogin(
  row: { readonly detail: unknown } | null,
  key: 'smtpLogin' | 'imapLogin',
): HeartbeatMailLogin | null {
  const detail = row?.detail
  const v = typeof detail === 'object' && detail !== null && key in detail ? (detail as Record<string, unknown>)[key] : null
  return v === 'unchecked' || v === 'ok' || v === 'refused' || v === 'unreachable' ? v : null
}

export interface HeartbeatReport {
  /** This web deployment is configured to reach a worker (`deployment().worker`). */
  readonly configured: boolean
  readonly lastSeenAt: Date | null
  readonly ageSeconds: number | null
  /** The MAILBOX: `HeartbeatOutreach`'s vocabulary. Says nothing about SMS. */
  readonly outreach: string | null
  readonly chat: string | null
  /** SMS through DoveSoft (`heartbeatSms`); null when the row does not say. */
  readonly sms: HeartbeatSms | null
  /** The outgoing mailbox's login (`heartbeatMailLogin`); null when the row does not say. */
  readonly smtpLogin: HeartbeatMailLogin | null
  /** The reply mailbox's login; null when the row does not say. */
  readonly imapLogin: HeartbeatMailLogin | null
  /**
   * `not_configured` only when there is no row AND no worker is configured —
   * a deployment that never meant to run one. A configured deployment with
   * no row is `never`: something should be ticking and nothing ever has.
   */
  readonly status: 'not_configured' | 'never' | 'live' | 'silent'
  /**
   * A `silent` row older than `HEARTBEAT_RETIRED_AFTER_DAYS` where no worker
   * is configured: a session somebody ran by hand and closed. The status
   * stays `silent`, because nothing is sending and every page that says so
   * is right; the digest line and /api/health name it `retired`
   * (`heartbeatReportedStatus`), and nobody is alerted about it.
   */
  readonly retired: boolean
}

/**
 * The newest row and the configuration, as one report. Pure: the caller
 * reads the row and the flag, this decides what they say together.
 */
export function heartbeatReport(
  row: Pick<WorkerHeartbeat, 'lastTickAt' | 'outreach' | 'chat' | 'detail'> | null,
  configured: boolean,
  now: Date,
): HeartbeatReport {
  const observed = heartbeatStatus(row, now, heartbeatSilentAfter(row))
  const ageSeconds = heartbeatAge(row, now)
  return {
    configured,
    lastSeenAt: row?.lastTickAt ?? null,
    ageSeconds,
    outreach: row?.outreach ?? null,
    chat: row?.chat ?? null,
    sms: heartbeatSms(row),
    smtpLogin: heartbeatMailLogin(row, 'smtpLogin'),
    imapLogin: heartbeatMailLogin(row, 'imapLogin'),
    status: observed === 'never' && !configured ? 'not_configured' : observed,
    // Configured, a stopped worker is silent however long ago it stopped:
    // somebody meant one to be running. An age that cannot be read is not a week.
    retired:
      !configured &&
      observed === 'silent' &&
      ageSeconds !== null &&
      Number.isFinite(ageSeconds) &&
      ageSeconds > HEARTBEAT_RETIRED_AFTER_DAYS * 86_400,
  }
}

/** What the digest's "Worker:" line and /api/health call the worker: the report's status, or `retired`. */
export type HeartbeatReportedStatus = HeartbeatReport['status'] | 'retired'

export function heartbeatReportedStatus(
  report: Pick<HeartbeatReport, 'status' | 'retired'>,
): HeartbeatReportedStatus {
  return report.retired ? 'retired' : report.status
}
