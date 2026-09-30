/**
 * The worker writes one row per instance, upserted every tick (§2.4).
 * Exported from the package root ONLY — a web bundle that could write a
 * heartbeat is a fake-liveness oracle: `/api/health` would report a worker
 * the bundle itself invented (queries.ts says why; barrel.test.ts asserts it).
 *
 * The row carries configuration facts and never a credential (§2.3): the
 * outreach mode, whether chat is enabled, and whatever the worker puts in
 * `detail` — counts and names, never a key, a DSN or a message body.
 */
import { lt, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import type { HeartbeatChat, HeartbeatOutreach } from './heartbeat-read.js'

/**
 * A worker that has not ticked for this long is not coming back under the
 * same row. Rows past it are deleted on the next write by ANY worker, so the
 * table stays one row per recent instance rather than one per restart ever.
 */
export const HEARTBEAT_RETENTION_DAYS = 30

export interface HeartbeatWrite {
  /** `hostname:pid` — the row's key. */
  readonly workerId: string
  /** Stamped after the single-worker lock. Moves on every restart. */
  readonly bootedAt: Date
  /** This write's instant, on the worker's clock. Never before `bootedAt`, by CHECK. */
  readonly lastTickAt: Date
  readonly outreach: HeartbeatOutreach
  readonly chat: HeartbeatChat
  /** Configuration facts only. */
  readonly detail: Record<string, unknown>
}

/**
 * Upsert this worker's row, after pruning rows nobody has written for
 * `HEARTBEAT_RETENTION_DAYS`.
 *
 * The prune goes FIRST so that this function throws exactly when the row
 * was not written: the caller treats a throw as "no heartbeat reached the
 * database" and does not move its own last-written time, and a prune that
 * failed after a successful upsert would have made that a lie. It also
 * covers a worker whose own row aged out — same machine, same pid, a month
 * off — which is deleted and then written fresh rather than resurrected.
 *
 * `booted_at` is overwritten on conflict, not kept. `hostname:pid` is stable
 * across restarts on Fly and in compose (the same machine, pid 1), so an
 * upsert that left it alone would report a dead process's boot instant for
 * the new one — a worker that restarted every five minutes would read as
 * having been up for a week.
 */
export async function writeHeartbeat(db: AgencyDb, beat: HeartbeatWrite): Promise<void> {
  const cutoff = new Date(beat.lastTickAt.getTime() - HEARTBEAT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  await db.delete(schema.workerHeartbeats).where(lt(schema.workerHeartbeats.lastTickAt, cutoff))

  await db
    .insert(schema.workerHeartbeats)
    .values({
      workerId: beat.workerId,
      bootedAt: beat.bootedAt,
      lastTickAt: beat.lastTickAt,
      outreach: beat.outreach,
      chat: beat.chat,
      detail: beat.detail,
    })
    .onConflictDoUpdate({
      target: schema.workerHeartbeats.workerId,
      set: {
        bootedAt: sql`excluded.booted_at`,
        lastTickAt: sql`excluded.last_tick_at`,
        outreach: sql`excluded.outreach`,
        chat: sql`excluded.chat`,
        detail: sql`excluded.detail`,
      },
    })
}
