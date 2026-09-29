// STUB — filled in wave 2 by worker-heartbeat
/**
 * The worker's heartbeat (§2.4): one row per worker, keyed by `hostname:pid`,
 * rewritten every sender tick, so that "is the worker alive?" is a timestamp
 * somebody can read from `/api/health` rather than an inference from a queue
 * that has stopped moving.
 *
 * Why it exists at all: Fly scales a machine to zero between requests, and a
 * worker that was scaled away looks fine from the outside — `/readyz` answers
 * on a machine that was just woken, and nothing else says the tick stopped.
 * A heartbeat that stops is the fact the CLAUDE.md header warns nobody can
 * otherwise see.
 *
 * This revision writes nothing. The seam is declared here so `index.ts` is
 * wired once and never edited again: the implementation replaces the body of
 * this file and keeps `HeartbeatDeps`, `startHeartbeat` and `lastHeartbeatAt`
 * exactly as declared. A failing write must be logged by `err.name` and
 * survived — a worker that dies because its heartbeat table is missing is the
 * enforcement `/api/health` deliberately refuses to do (CLAUDE.md §4).
 */
import type { AgencyDb } from '@agency/db'
import type { HealthInputs } from '../health.js'
import type { Logger } from '../logger.js'

/** What one heartbeat row says about the worker, read fresh at every write. */
export interface HeartbeatInputs {
  /** `HealthInputs['outreach']` on purpose: the row and /readyz share one vocabulary. */
  readonly outreach: HealthInputs['outreach']
  readonly chat: 'enabled' | 'disabled'
  /** Configuration facts only — never a credential (§2.3). */
  readonly detail: Record<string, unknown>
}

export interface HeartbeatDeps {
  readonly db: AgencyDb
  readonly log: Logger
  /** The sender tick's interval: one row per worker, rewritten that often. */
  readonly intervalMs: number
  /** `hostname:pid` — the row's key, and what the boot log prints. */
  readonly workerId: string
  /** Stamped AFTER the single-worker lock, like everything else at boot. */
  readonly bootedAt: Date
  readonly inputs: () => HeartbeatInputs
}

/** Starts the heartbeat; returns stop(). The stub writes nothing. */
export function startHeartbeat(_deps: HeartbeatDeps): () => Promise<void> {
  return async () => {}
}

/**
 * When the last heartbeat actually REACHED the database, for `/readyz`. Null
 * until one has — which, in this revision, is always: nothing is written. A
 * write that failed does not move it, so a worker whose table is missing
 * reports a stale or absent time here rather than a cheerful one.
 */
export function lastHeartbeatAt(): Date | null {
  return null
}
