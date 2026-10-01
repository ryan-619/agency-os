/**
 * Is the worker silent — the one fact that means approvals land on nothing
 * (§2.4)?
 *
 * The worker runs the sender tick and reads the mailbox. When it stops, an
 * approved message stays approved forever and a reply is never seen, and
 * nothing looks broken: every page still renders, and on Fly a machine
 * scaled to zero answers `/readyz` the moment somebody wakes it. So the
 * alert that the worker has gone quiet CANNOT come from the worker. It comes
 * from the daily cron, which runs on the web half, reading the heartbeat the
 * worker stops writing.
 *
 * Silent means a worker has written a heartbeat and not been heard from
 * within the threshold — whatever this web half is configured with, because
 * an observation beats configuration: the documented production shape is
 * Vercel with no `AGENT_URL` (chat not exposed) and a worker on Fly, and
 * when that worker stops its row goes quiet while `deployment().worker`
 * still says false. With NO row, it is silent only where a worker is
 * CONFIGURED (`never`). A deployment that never meant to run one is not
 * silent — it is one where nothing sends, which `nothingWillSendNote`
 * already says on every page that would promise it, and an alert about it
 * every morning would teach the channel to ignore the one that matters.
 *
 * And a row does not beat configuration forever. Only a running worker's
 * own write prunes the table, so `./tools/run-worker.sh` run once against
 * production and closed leaves a row nothing will ever remove — and with no
 * horizon, a deployment with no worker configured was alerted about it
 * every morning, for good. Where no worker is configured, a row older than
 * `HEARTBEAT_RETIRED_AFTER_DAYS` is that session, RETIRED: not silent, and
 * named in the digest as retired rather than alerted about. A worker that
 * was running and stopped still gets that week of notices; a configured one
 * is silent however long it stays so.
 *
 * Pure: no `server-only`, no `@/`, no clock. The route reads the newest
 * heartbeat and passes the threshold that row earns (`heartbeatSilentAfter`,
 * which never goes below the default here), and the rules above are
 * `heartbeatReport`'s own, so the alert and the digest's "Worker:" line —
 * `heartbeatReport` over the same row — cannot disagree. They did: this
 * returned "not silent" for any deployment without `AGENT_URL`, so the
 * digest said "Worker: SILENT" and the alert was recorded `not_needed`.
 */
import { HEARTBEAT_RETIRED_AFTER_DAYS } from '@agency/db/queries'

/**
 * `HEARTBEAT_SILENT_AFTER_SECONDS` in packages/db, restated so this module
 * needs nothing from the database package to have a default;
 * `worker-check.test.ts` fails if the two drift. The retirement horizon is
 * imported rather than restated: it is one number, kept in one place.
 */
export const WORKER_SILENT_AFTER_SECONDS = 600

export interface WorkerCheck {
  readonly silent: boolean
  /**
   * No worker is configured and the row is past the retirement horizon: a
   * closed session, never silent. `heartbeatReport`'s `retired`, over the
   * same row.
   */
  readonly retired: boolean
  /** Whole seconds since the last heartbeat, never negative; null when there is none. */
  readonly ageSeconds: number | null
}

export function workerSilent(
  status: { readonly configured: boolean; readonly lastSeenAt: Date | null },
  now: Date,
  silentAfterSeconds: number = WORKER_SILENT_AFTER_SECONDS,
): WorkerCheck {
  // A threshold that is not a positive number is a caller's bug, and the
  // safe reading of it is the default — never "nothing is ever silent".
  const threshold =
    Number.isFinite(silentAfterSeconds) && silentAfterSeconds > 0 ? silentAfterSeconds : WORKER_SILENT_AFTER_SECONDS
  const seen = status.lastSeenAt?.getTime()
  // An unreadable timestamp is not evidence that anything ticked.
  const ageSeconds =
    seen === undefined || !Number.isFinite(seen) || !Number.isFinite(now.getTime())
      ? null
      : // The worker stamps with its clock and this reads with another's: a
        // row a second in the future is skew, not a worker yet to tick.
        Math.max(0, Math.floor((now.getTime() - seen) / 1000))
  // No row: silent only where a worker was meant to be running.
  if (status.lastSeenAt === null) return { silent: status.configured, retired: false, ageSeconds }
  // A row is an observation. One that cannot be read is not evidence that
  // anything ticked, and one past the threshold is a worker that stopped —
  // unless none is configured and it stopped more than a week ago.
  const stopped = ageSeconds === null || ageSeconds > threshold
  const retired =
    stopped && !status.configured && ageSeconds !== null && ageSeconds > HEARTBEAT_RETIRED_AFTER_DAYS * 86_400
  return { silent: stopped && !retired, retired, ageSeconds }
}
