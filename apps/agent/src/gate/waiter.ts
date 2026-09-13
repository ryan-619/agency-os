/**
 * Waiting for a human.
 *
 * `canUseTool` parks here while someone decides. The SDK is blunt about the
 * cost of getting this wrong: *"an accidental null means no control_response
 * is sent and the tool stays blocked indefinitely — permission prompts have no
 * park deadline."* So this function has exactly one contract, and the tests
 * assert it directly: **it always settles, and it never rejects.** A decision,
 * a deadline, or an abort — one of those three, every time.
 *
 * It POLLS. That is a decision worth its reasons, because LISTEN/NOTIFY is the
 * obvious idea:
 *
 *  - `pg.Pool` cannot receive notifications at all. `pool.query('LISTEN x')`
 *    appears to succeed, registers on a random pooled backend, and silently
 *    delivers nothing. A correct version needs a dedicated `pg.Client`, its own
 *    reconnect, and its own health story.
 *  - Notifications are not durable. A decision landing between the insert and
 *    the subscribe is lost forever, so a correct NOTIFY design still needs the
 *    poll underneath it — all of this code, plus all of that code.
 *  - The test engine is a single embedded connection, so a two-connection
 *    waiter/decider split cannot be exercised by the suite at all.
 *  - And measured against a decision that takes minutes, it buys about a
 *    second.
 *
 * It was also checked rather than assumed: over the PGlite socket bridge this
 * project uses for local development, `NOTIFY` is silently dropped — the
 * bridge has no notification handling at all. A LISTEN-only waiter would hang
 * on a developer's own machine, and a hang here is indistinguishable from the
 * model thinking.
 */
import type { ApprovalRow } from '@agency/db'

/**
 * `aborted` and `unavailable` are both "no decision", and they are separate
 * because they mean opposite things to the person watching.
 *
 * `aborted` — the turn was stopped, so the request is genuinely dead.
 * `unavailable` — the gate could not READ the row. The approval may be alive,
 *   undecided, and on someone's screen right now. Reporting that as an expiry
 *   (which it was) put "expired" on a card that was still decidable.
 */
export type DecisionStatus = 'approved' | 'denied' | 'expired' | 'aborted' | 'unavailable'

export interface Decision {
  readonly status: DecisionStatus
  readonly decidedBy?: string | null
  readonly reason?: string | null
}

export interface WaiterDeps {
  /** Reads the current row. Throws on a database failure; this file handles it. */
  readonly read: (approvalId: string) => Promise<ApprovalRow | null>
  /** Marks the row expired. Returns null if a decision won the race. */
  readonly expire: (approvalId: string) => Promise<ApprovalRow | null>
  readonly now: () => Date
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly pollMs: number
  /** How many consecutive read failures to tolerate before giving up. */
  readonly readRetries: number
  readonly log: {
    warn: (msg: string, fields?: Record<string, unknown>) => void
    error: (msg: string, fields?: Record<string, unknown>) => void
  }
}

export interface ApprovalWaiter {
  await(approvalId: string, opts: { signal?: AbortSignal; deadline: Date }): Promise<Decision>
  /** False after the read budget has been exhausted. Surfaced on /readyz. */
  readonly healthy: boolean
}

function decisionFrom(row: ApprovalRow): Decision | null {
  if (row.status === 'approved' || row.status === 'denied') {
    return { status: row.status, decidedBy: row.decidedBy, reason: row.decidedReason }
  }
  if (row.status === 'expired') return { status: 'expired' }
  return null
}

export function createApprovalWaiter(deps: WaiterDeps): ApprovalWaiter {
  let healthy = true

  return {
    get healthy() {
      return healthy
    },

    async await(approvalId, opts) {
      let consecutiveFailures = 0

      for (;;) {
        // 1. Read FIRST, before any sleep. A human who decided between the
        //    insert and this call is seen immediately rather than after a
        //    poll interval — and on a redelivery the row is usually already
        //    decided, so this returns without sleeping at all.
        let row: ApprovalRow | null
        try {
          row = await deps.read(approvalId)
          consecutiveFailures = 0
          healthy = true
        } catch (err) {
          consecutiveFailures += 1
          deps.log.warn('approval read failed', {
            approvalId,
            attempt: consecutiveFailures,
            error: err instanceof Error ? err.name : 'UnknownError',
          })
          if (consecutiveFailures > deps.readRetries) {
            // A bare read with no tolerance turns a two-second database blip
            // during a twenty-minute wait into a permanent denial of a live,
            // undecided approval — while the row stays pending and the human
            // approves into nothing. Only after the budget is spent does this
            // give up, and it gives up by DENYING, never by hanging.
            healthy = false
            deps.log.error('approval waiter gave up reading', { approvalId })
            // NOT 'aborted'. The row is untouched and may still be pending —
            // the database is what could not be reached, not the human.
            return { status: 'unavailable' }
          }
          // Exponential backoff, bounded by the deadline check below.
          await deps.sleep(Math.min(16_000, 1000 * 2 ** (consecutiveFailures - 1)), opts.signal)
          continue
        }

        // 2. The row is gone. Nothing to wait for; deny rather than spin.
        if (!row) {
          deps.log.error('approval row vanished while waiting', { approvalId })
          return { status: 'unavailable' }
        }

        // 3. Decided.
        const decided = decisionFrom(row)
        if (decided) return decided

        // 4. Past its deadline. The deadline is the ROW's, never an
        //    independent timer that could disagree with what the human sees.
        if (deps.now().getTime() >= row.expiresAt.getTime()) {
          const expired = await deps.expire(approvalId)
          if (expired) return { status: 'expired' }
          // The expiry matched nothing, which means a decision landed in the
          // same instant and won. Re-read rather than assuming.
          const after = await deps.read(approvalId)
          const late = after ? decisionFrom(after) : null
          return late ?? { status: 'expired' }
        }

        // 5. The turn was stopped.
        if (opts.signal?.aborted) return { status: 'aborted' }

        await deps.sleep(deps.pollMs, opts.signal)
        if (opts.signal?.aborted) return { status: 'aborted' }
      }
    },
  }
}

/** A sleep that wakes early when the turn is aborted, and never rejects. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
