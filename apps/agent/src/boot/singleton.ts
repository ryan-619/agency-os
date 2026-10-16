/**
 * One worker, enforced rather than assumed.
 *
 * The restart reconciler in `reconcile.ts` clears every running turn and
 * expires every pending approval it finds at boot — which is exactly right for
 * rows this process left behind, and exactly wrong for rows a second, healthy
 * worker is currently serving. It would kill live turns and expire approvals a
 * human is looking at.
 *
 * So the assumption is turned into a lock. A Postgres advisory lock is the
 * right instrument: it lives in the database everything else already depends
 * on (§12 forbids adding Redis), it is released automatically when the
 * connection drops — including when the process is killed — and it needs no
 * table, no migration and no cleanup job.
 *
 * It is held on a DEDICATED connection, never a pooled one. A pool hands a
 * connection back after each query, and `pg_advisory_lock` is scoped to the
 * session that took it: on a pool, the lock would be released the moment the
 * connection was reused, which is a lock that reads as held and is not.
 */
import { Client } from 'pg'
import type { Logger } from '../logger.js'

/**
 * Any stable 64-bit number. Derived from a string rather than written as a
 * magic integer so a second component taking a different lock is obviously a
 * different string, not a typo in a digit.
 */
export const WORKER_LOCK_KEY = hashKey('agency-os:agent-worker')

function hashKey(s: string): number {
  // FNV-1a, 32-bit, then widened. Advisory locks take a bigint; a 32-bit value
  // is plenty of space for the handful of locks this application will ever own.
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export interface WorkerLock {
  release(): Promise<void>
  /**
   * Is the lock still actually held?
   *
   * False once the connection has dropped. Postgres releases an advisory lock
   * the moment its session ends, so from that point the worker is running
   * WITHOUT the exclusion it thinks it has — and another worker can start.
   * `/readyz` reports it so an operator sees it rather than inferring it.
   */
  readonly held: boolean
}

export interface LockOptions {
  readonly connectionString: string
  readonly log: Logger
  /** A redeploy overlaps briefly; the old worker's TCP teardown is not instant. */
  readonly attempts?: number
  readonly retryMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * A dedicated `pg.Client` is an EventEmitter, and an EventEmitter with no
 * `'error'` listener RE-THROWS — out of the event loop, where nothing catches
 * it. So a database restart, a failover, or an idle-connection timeout on the
 * lock connection did not degrade the worker: it killed the process, mid-turn,
 * with a stack trace about a socket and no mention of a lock.
 *
 * The lock is the second layer rather than the first (the restart reconciler
 * is scoped by boot time, see CLAUDE.md §4), so losing it is not a reason to
 * stop serving turns that are already running. It IS a reason to say so
 * loudly, in the log and on /readyz, because the exclusion is gone until
 * someone restarts the worker.
 */
function watchForDisconnect(client: Client, log: Logger, onLost: () => void): void {
  // Said once: pg emits 'error' for the socket and again for the query the
  // drop interrupted, and on 2026-10-09 the operator's log carried the line
  // twice for one drop. The lock is lost once.
  let said = false
  client.on('error', (err: Error) => {
    onLost()
    if (said) return
    said = true
    log.error('the worker lock connection dropped, so the lock is NO LONGER HELD', {
      error: err.name,
      consequence:
        'Another worker can now start against this database. Turns already running are unaffected; ' +
        'restart this worker when convenient.',
    })
  })
  client.on('end', onLost)
}

/**
 * Take the worker lock, or fail loudly.
 *
 * Retries a few times, because a rolling redeploy genuinely overlaps: the new
 * container starts before the old one's connection has finished closing.
 * Beyond that window a second worker is a misconfiguration, and starting
 * anyway would mean two processes reconciling each other's live state.
 */
export async function acquireWorkerLock(opts: LockOptions): Promise<WorkerLock> {
  const attempts = opts.attempts ?? 5
  const retryMs = opts.retryMs ?? 2000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const client = new Client({ connectionString: opts.connectionString })
  // Before connect(), so a failure during the handshake is handled too.
  client.on('error', () => {})
  await client.connect()

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [WORKER_LOCK_KEY],
    )
    if (rows[0]?.locked) {
      opts.log.info('worker lock acquired', { attempt })
      let held = true
      watchForDisconnect(client, opts.log, () => {
        held = false
      })
      return {
        get held() {
          return held
        },
        async release() {
          held = false
          try {
            await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_KEY])
          } catch {
            // The connection is already gone, which means Postgres released
            // the lock for us. Nothing to do, and nothing worth failing a
            // shutdown over.
          } finally {
            await client.end().catch(() => {})
          }
        },
      }
    }
    if (attempt < attempts) {
      opts.log.warn('another agent worker holds the lock; retrying', { attempt, retryMs })
      await sleep(retryMs)
    }
  }

  await client.end().catch(() => {})
  throw new Error(
    'Another agent worker is already running against this database. Only one may run at a time, ' +
      'because this one reconciles interrupted turns and pending approvals at boot — with two, each ' +
      'would cancel the other\'s live work. Stop the other worker, or wait for its connection to close.',
  )
}
