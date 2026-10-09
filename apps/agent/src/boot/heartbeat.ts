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
 * `worker.ts` is wired once and never edited again: it calls `startHeartbeat`
 * after the single-worker lock and reads `lastHeartbeatAt` into `/readyz`.
 *
 * A failing write is logged by `err.name` and survived. A worker that dies
 * because its heartbeat table is missing is the enforcement `/api/health`
 * deliberately refuses to do (CLAUDE.md §4) — and it would stop the sender
 * and the inbox, which work perfectly well without the row, to report a
 * problem nobody could then read.
 */
import { writeHeartbeat, type AgencyDb } from '@agency/db'
import type { HealthInputs } from '../health.js'
import type { Logger } from '../logger.js'
import { faultFields } from '../log-fields.js'

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

/**
 * The package version when the worker was started through npm, which sets
 * it; null under `node dist/index.js`, which is how the image runs it. Null
 * is the honest answer there rather than a version read off some file that
 * may not be the one running.
 */
const VERSION = process.env['npm_package_version'] ?? null

/** The version every heartbeat row carries, for the worker's own view (`worker_status`). */
export function workerVersion(): string | null {
  return VERSION
}

/** The instant stamped on the last row that actually reached the database. */
let lastWritten: Date | null = null

/**
 * Starts the heartbeat; returns stop().
 *
 * Writes once immediately — a worker that has booted should not wait a whole
 * interval before `/api/health` can see it — and then every `intervalMs`.
 * Writes never overlap and never queue: a write still in flight when the
 * next interval fires means that interval is skipped, not stacked behind it,
 * so a database that is slow for a minute produces one late row rather than
 * a burst of four the moment it recovers.
 *
 * stop() is memoised and awaits the write in flight, so shutting down never
 * closes the pool under a heartbeat — the same rule the voice service learned
 * the hard way — and nothing is written after it resolves.
 */
export function startHeartbeat(deps: HeartbeatDeps): () => Promise<void> {
  let stopped = false
  let inFlight: Promise<void> | null = null
  /**
   * The error class of the failure streak in progress, or null when the last
   * write landed. One line when a streak starts or its cause changes, one
   * when it ends — not one every fifteen seconds for as long as a migration
   * is missing, which is 5,760 identical lines a day and trains everybody to
   * stop reading the log. The staleness itself is not hidden by this: it is
   * `heartbeatWrittenAt` on `/readyz` and `worker.ageSeconds` on `/api/health`.
   */
  let failing: string | null = null
  let failures = 0

  const beat = async (): Promise<void> => {
    const at = new Date()
    try {
      const i = deps.inputs()
      await writeHeartbeat(deps.db, {
        workerId: deps.workerId,
        bootedAt: deps.bootedAt,
        lastTickAt: at,
        outreach: i.outreach,
        chat: i.chat,
        // The interval is the worker's to know: the web reads it to decide
        // how long is too long, so a slow tick is not mistaken for silence.
        detail: { ...i.detail, intervalMs: deps.intervalMs, version: VERSION },
      })
      lastWritten = at
      if (failing !== null) {
        deps.log.info('heartbeat written again', { workerId: deps.workerId, failedWrites: failures })
        failing = null
        failures = 0
      }
    } catch (err) {
      // Only the class: a driver error can carry the DSN (§2.3).
      const name = err instanceof Error ? err.name : 'UnknownError'
      failures += 1
      if (failing !== name) {
        deps.log.warn('heartbeat not written; the worker carries on', {
          workerId: deps.workerId,
          ...faultFields(err),
        })
        failing = name
      }
    }
  }

  const tick = (): void => {
    if (stopped || inFlight !== null) return
    inFlight = beat().finally(() => {
      inFlight = null
    })
  }

  tick()
  const timer = setInterval(tick, deps.intervalMs)
  timer.unref()

  let stopping: Promise<void> | null = null
  return () => {
    stopping ??= (async () => {
      stopped = true
      clearInterval(timer)
      await inFlight
    })()
    return stopping
  }
}

/**
 * When the last heartbeat actually REACHED the database, for `/readyz`: the
 * `last_tick_at` of the newest row this process wrote. Null until one has. A
 * write that failed does not move it, so a worker whose table is missing
 * reports a stale or absent time here rather than a cheerful one.
 */
export function lastHeartbeatAt(): Date | null {
  return lastWritten
}
