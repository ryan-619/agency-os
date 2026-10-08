/**
 * Follow-up sequences, advanced by the worker (0024).
 *
 * Every `intervalMs` (five minutes) and once at boot, one pass of
 * `advanceSequences`: start the runs whose opener has gone, then take, wait on
 * or stop each live run. Every write in it is claimed over what it read, so
 * the web's daily cron advancing the same runs takes each step once. Needs no
 * model: a follow-up is a template filled in, drafted for a person to approve
 * where the campaign does not auto-send, and judged by the send path at
 * sending like every other message.
 *
 * A pass never overlaps another; a pass that fails is logged once per streak,
 * by the error's class (a driver message can carry the DSN), and once when it
 * works again. A RUN that fails inside a pass is counted and left as it was,
 * and the pass goes on (review, 2026-10-08): it is logged at warn with run
 * ids and error classes, every pass it fails in, because one run that can
 * never advance is a person whose follow-ups have silently stopped.
 */
import { advanceSequences, type AdvanceResult, type AgencyDb } from '@agency/db'
import type { Logger } from '../logger.js'

export const SEQUENCE_INTERVAL_MS = 5 * 60_000

export interface SequenceDeps {
  readonly db: AgencyDb
  readonly log: Logger
  readonly now: () => Date
  readonly intervalMs?: number
}

const moved = (r: AdvanceResult) =>
  r.started + r.messages + r.tasks + r.skipped + r.returned + Object.values(r.stopped).reduce((a, n) => a + (n ?? 0), 0) > 0

export function startSequences(deps: SequenceDeps): () => void {
  let busy = false
  let failing: string | null = null
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const r = await advanceSequences(deps.db, { now: deps.now() })
      // Counts only: who and which campaign are in the audit rows the pass wrote.
      const { faults, ...counts } = r
      if (moved(r)) deps.log.info('follow-up sequences advanced', { ...counts })
      if (r.failed > 0) deps.log.warn('follow-up sequences: some runs could not be advanced', { failed: r.failed, faults })
      if (failing !== null) deps.log.info('follow-up sequences advance again', { after: failing })
      failing = null
    } catch (err) {
      const error = err instanceof Error ? err.name : 'UnknownError'
      if (error !== failing) deps.log.warn('follow-up sequences could not advance', { error })
      failing = error
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), deps.intervalMs ?? SEQUENCE_INTERVAL_MS)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
