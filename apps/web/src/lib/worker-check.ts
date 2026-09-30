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
 * Silent means a worker is CONFIGURED here (`deployment().worker`) and has
 * not been heard from within the threshold, or ever. A deployment that never
 * meant to run one is not silent — it is one where nothing sends, which
 * `nothingWillSendNote` already says on every page that would promise it,
 * and an alert about it every morning would teach the channel to ignore the
 * one that matters.
 *
 * Pure: no `server-only`, no `@/`, no clock. The route reads the newest
 * heartbeat and passes the threshold that row earns (`heartbeatSilentAfter`,
 * which never goes below the default here), so the alert and the digest's
 * "Worker:" line — `heartbeatReport` over the same row — cannot disagree.
 */

/**
 * `HEARTBEAT_SILENT_AFTER_SECONDS` in packages/db, restated so this module
 * imports nothing; `worker-check.test.ts` fails if the two drift.
 */
export const WORKER_SILENT_AFTER_SECONDS = 600

export interface WorkerCheck {
  readonly silent: boolean
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
  if (!status.configured) return { silent: false, ageSeconds }
  return { silent: ageSeconds === null || ageSeconds > threshold, ageSeconds }
}
