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
 * How long a worker may go unheard before it is called silent, when nothing
 * better is known. Forty sender ticks at the default fifteen seconds: long
 * enough that one slow tick or a database blip is not an alarm, short enough
 * that a machine scaled to zero is named within ten minutes rather than
 * noticed days later as a queue that stopped moving.
 */
export const HEARTBEAT_SILENT_AFTER_SECONDS = 600

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

export interface HeartbeatReport {
  /** This web deployment is configured to reach a worker (`deployment().worker`). */
  readonly configured: boolean
  readonly lastSeenAt: Date | null
  readonly ageSeconds: number | null
  readonly outreach: string | null
  readonly chat: string | null
  /**
   * `not_configured` only when there is no row AND no worker is configured —
   * a deployment that never meant to run one. A configured deployment with
   * no row is `never`: something should be ticking and nothing ever has.
   */
  readonly status: 'not_configured' | 'never' | 'live' | 'silent'
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
  return {
    configured,
    lastSeenAt: row?.lastTickAt ?? null,
    ageSeconds: heartbeatAge(row, now),
    outreach: row?.outreach ?? null,
    chat: row?.chat ?? null,
    status: observed === 'never' && !configured ? 'not_configured' : observed,
  }
}
