/**
 * The sender tick (PROMPT.md §8.4).
 *
 * Every `OUTREACH_TICK_MS`, take the messages that are due — `approved` by a
 * person, or `queued` by an auto-send campaign — and run each one through
 * `dispatchTouch`. That function is the single send path: it re-checks every
 * §2.1 rule at the moment of sending and is the only thing that talks to the
 * provider. This file decides nothing; it schedules.
 *
 * ## Why a tick and not a trigger
 *
 * Approving a draft could call the provider directly from the web route. It
 * does not, for two reasons. The web app must not hold a mail transport (it is
 * built with no secrets, and a transport that can deliver has no business in
 * that graph — see packages/db/src/queries.ts). And a message approved at
 * 23:00 in the recipient's zone should be SENT at 08:00, not refused at 23:00
 * — the tick will find it still `approved` next morning, and the quiet-hours
 * refusal is what happens to it in the meantime. That second point is why a
 * `quiet_hours` refusal is not terminal for an approved message; see below.
 *
 * ## One worker, one tick
 *
 * Two workers would both pick up the same `approved` row and both send it.
 * The single-worker advisory lock is what prevents that, and CLAUDE.md §4
 * records that the lock does not isolate over the local PGlite bridge — so on
 * a developer's machine two workers really would double-send. The claim
 * below (`status = 'sending'` in the predicate) is the second layer: it turns
 * a double-send into a "matched 0 rows" for the loser.
 *
 * A worker that dies between the claim and the provider leaves a row in
 * `sending` forever. `recoverStuckSends` at boot marks those `failed` with a
 * reason — the SAFE direction, because the alternative is guessing whether the
 * provider was reached and sending it again.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { dispatchTouch, dueTouches, schema, type AgencyDb, type MessageProvider } from '@agency/db'
import type { Logger } from '../logger.js'

export interface SenderDeps {
  readonly db: AgencyDb
  readonly provider: MessageProvider
  readonly log: Logger
  readonly batch: number
  readonly now?: () => Date
}

export interface TickSummary {
  readonly picked: number
  readonly sent: number
  readonly refused: number
  readonly deferred: number
  readonly failed: number
}

/**
 * One pass over what is due.
 *
 * Never throws: a tick that died on one bad row would stop every message
 * behind it. Each row is settled by `dispatchTouch` into an explained state,
 * and a provider failure — which `dispatchTouch` re-throws so a caller CAN
 * retry — is logged here and left as `failed` for a person to look at.
 */
export async function runSenderTick(deps: SenderDeps): Promise<TickSummary> {
  const now = deps.now?.() ?? new Date()
  const summary = { picked: 0, sent: 0, refused: 0, deferred: 0, failed: 0 }

  let due
  try {
    due = await dueTouches(deps.db, deps.batch, now)
  } catch (err) {
    deps.log.warn('sender could not read the queue', {
      error: err instanceof Error ? err.name : 'UnknownError',
    })
    return summary
  }
  summary.picked = due.length

  for (const touch of due) {
    // Claim it. `sending` is a status the CHECK knows (0011), and the
    // predicate is what makes a second worker's identical pick match nothing.
    // The ORIGINAL row is what goes to `dispatchTouch`, so it still reads as
    // approved or queued there and `approvedByHuman` is computed correctly.
    const claimed = await deps.db
      .update(schema.touches)
      .set({ status: 'sending' })
      .where(and(eq(schema.touches.id, touch.id), inArray(schema.touches.status, ['approved', 'queued'])))
      .returning({ id: schema.touches.id })
      .catch(() => [])
    if (claimed.length === 0) continue

    try {
      const result = await dispatchTouch(deps.db, deps.provider, touch, { now })
      if (result.sent) {
        summary.sent += 1
        continue
      }
      const code = result.decision.allowed ? 'send_now' : result.decision.code

      /**
       * A message refused for quiet hours or the cap is not dead: the person
       * (or the campaign) said yes, and the only thing wrong is the clock. Put
       * it back to the status it came from with `scheduled_for` set, so a tick
       * after the window finds it. Everything else — suppression, consent, a
       * missing recipient — stays refused, because time will not change it.
       *
       * An hour for quiet hours, six for the cap. Neither is precise and
       * neither needs to be: the tick re-checks the real rule when it arrives,
       * and a message that is still too early is deferred again.
       */
      if (code === 'quiet_hours' || code === 'daily_cap') {
        const retryAt = new Date(now.getTime() + (code === 'daily_cap' ? 6 : 1) * 60 * 60 * 1000)
        await deps.db
          .update(schema.touches)
          .set({ status: touch.status, refusalCode: null, scheduledFor: retryAt })
          .where(eq(schema.touches.id, touch.id))
        summary.deferred += 1
        deps.log.info('deferred an approved message', { touchId: touch.id, because: code, until: retryAt.toISOString() })
        continue
      }
      summary.refused += 1
    } catch (err) {
      // `dispatchTouch` has already marked the row `failed` with the reason.
      summary.failed += 1
      deps.log.error('a message failed at the provider', {
        touchId: touch.id,
        provider: deps.provider.name,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }

  if (summary.picked > 0) deps.log.info('sender tick', summary)
  return summary
}

/** Start the tick. Returns a stop function that resolves once no tick is mid-flight. */
export function startSender(deps: SenderDeps & { readonly intervalMs: number }): () => Promise<void> {
  let inFlight: Promise<unknown> = Promise.resolve()
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) return
    // Never overlap: a slow provider must not produce two concurrent ticks
    // both holding the same rows.
    inFlight = inFlight.then(() => runSenderTick(deps)).catch(() => {})
  }, deps.intervalMs)
  timer.unref()

  return async () => {
    stopped = true
    clearInterval(timer)
    await inFlight
  }
}
