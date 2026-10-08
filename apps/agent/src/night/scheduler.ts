/**
 * The night shift, started by the worker (0025).
 *
 * Once a minute, and once at boot: every org whose night shift is due — its
 * zone's clock past its time on a night that has not run, or "Run it now"
 * pressed — is CLAIMED for that night (`claimNightShift`, one UPDATE), then
 * run (`runNightShift`): the saved Google Maps searches, the new businesses
 * filed, their sites scanned and measured, the morning list written. One org
 * at a time, and a look never overlaps another. A night that fails is audited
 * `night.failed` with the error's class and logged once per streak; the night
 * is spent once claimed, so it is tried again tomorrow, never every minute.
 *
 * It needs the Google key — Places is the search — so a worker without one
 * starts none, and says so at boot.
 */
import { appendAudit, claimNightShift, nightShiftsDue, type AgencyDb } from '@agency/db'
import { runNightShift, type OpsScan, type PageSpeedClient, type PlacesClient } from '@agency/tools'
import type { Logger } from '../logger.js'

export interface NightShiftDeps {
  readonly db: AgencyDb
  readonly log: Logger
  readonly now: () => Date
  readonly places: PlacesClient
  readonly pagespeed?: PageSpeedClient | undefined
  readonly scan?: OpsScan
  readonly intervalMs?: number
}

/** One look: every due night, one at a time. Exported for the tests. */
export async function runDueNights(deps: NightShiftDeps): Promise<number> {
  let ran = 0
  for (const due of await nightShiftsDue(deps.db, deps.now())) {
    if (!(await claimNightShift(deps.db, { orgId: due.orgId, localDate: due.localDate }))) continue
    try {
      const r = await runNightShift({
        db: deps.db, orgId: due.orgId, localDate: due.localDate, now: deps.now, places: deps.places,
        ...(deps.pagespeed ? { pagespeed: deps.pagespeed } : {}),
        ...(deps.scan ? { scan: deps.scan } : {}),
      })
      // Counts only: the businesses are in the CRM, and their ids in the night's audit row.
      deps.log.info('night shift ran', {
        orgId: due.orgId, date: due.localDate, requested: due.requested, searches: r.searches, added: r.added,
        scanned: r.scanned, audited: r.audited, top: r.top.length, why: r.why,
      })
      ran++
    } catch (err) {
      const error = err instanceof Error ? err.name : 'UnknownError'
      deps.log.warn('the night shift failed', { orgId: due.orgId, date: due.localDate, error })
      await appendAudit(deps.db, {
        orgId: due.orgId, actor: 'night_shift', action: 'night.failed', subjectType: 'org', subjectId: due.orgId,
        detail: { date: due.localDate, error },
      }).catch(() => {})
    }
  }
  return ran
}

export function startNightShift(deps: NightShiftDeps): () => void {
  let busy = false
  let failing: string | null = null
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      await runDueNights(deps)
      if (failing !== null) deps.log.info('the night shift check works again', { after: failing })
      failing = null
    } catch (err) {
      const error = err instanceof Error ? err.name : 'UnknownError'
      if (error !== failing) deps.log.warn('the night shift check failed', { error })
      failing = error
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 60_000)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
