import { NextResponse } from 'next/server'
import { parseIcpDefinition, type IcpDefinition } from '@agency/core'
import { scanDomain, UnscannableHostError } from '@agency/scanner'
import {
  activeIcpProfile, claimRescan, listOrgIds, rescanWorstCaseMs, runRescan,
  RESCAN_MARGIN_MS, RESCAN_SCAN_TIMEOUTS,
  type AgencyDb, type RescanResult,
} from '@agency/db/queries'
import { cronRequest } from '@/lib/cron-auth'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'

/**
 * The daily bounded rescan (§2.2). Vercel calls it once a day — `vercel.json`,
 * `17 3 * * *` — with `Authorization: Bearer <CRON_SECRET>`.
 *
 * `findings.stale` is a cache, written only when somebody scans, and nothing
 * scanned on a schedule. This is `npm run scan -- --stale` on a timer. It is
 * not a scan button: nobody clicks it, and a person still scans one company
 * with `npm run scan -- <domain>`.
 *
 * The route is a translation. What is due, in what order, how many, and when
 * to stop starting scans all live in `packages/db/src/rescan.ts`, where they
 * are tested against a real Postgres; here is only the gate, the loop over
 * orgs, and the scanner handed in with the cron's timeouts.
 *
 * ## The ceiling
 *
 * `maxDuration = 300` needs Fluid Compute on the project (the default for new
 * ones; without it Hobby stops a function at 60 s). The budget is that
 * ceiling less `RESCAN_MARGIN_MS`, SHARED across orgs and measured from the
 * moment this handler starts, and a company is dispatched only when its
 * worst case — derived from the same timeouts passed to `scanDomain` — still
 * fits in what is left. So a scan that starts is one that can finish, and the
 * audit row and this answer are always written.
 *
 * ## Twice at once
 *
 * Vercel may deliver one cron event more than once, and two deliveries that
 * overlap both read the queue before either records a scan. So each org is
 * CLAIMED before anything is selected (`claimRescan`: an advisory lock and a
 * `scan.cron_started` row that holds until this run's ceiling), and a
 * delivery that finds another's claim reports the org `skipped: 'claimed'`
 * and moves on. Under compose, where nothing schedules these routes, the
 * same holds for a host crontab and a person's `curl` arriving together.
 *
 * ## What it answers
 *
 * 200 with the counts per org, only after the work is done — never a
 * redirect, never early. An org with no usable ICP is reported and passed
 * over, as is one another delivery is already running; an org whose run
 * threw is reported by error class and makes the answer a 500, so the
 * platform's cron log shows the failure. The log line carries the route and
 * the outcome and nothing else — never the header, never a domain.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type OrgAnswer =
  | ({ readonly orgId: string } & RescanResult)
  | { readonly orgId: string; readonly notRun: 'no_active_icp' | 'unparseable_icp' }
  | { readonly orgId: string; readonly skipped: 'claimed'; readonly heldUntil: string }
  | { readonly orgId: string; readonly failed: string }

export async function GET(request: Request): Promise<NextResponse> {
  const started = Date.now()
  const check = cronRequest({
    authorization: request.headers.get('authorization'),
    secret: env().CRON_SECRET,
    vercelEnv: env().VERCEL_ENV,
  })
  if (!check.ok) {
    log.warn('cron request refused', { route: 'cron.rescan', outcome: check.error })
    return NextResponse.json({ error: check.error }, { status: check.status })
  }

  const db = getDb() as unknown as AgencyDb
  const deadline = started + maxDuration * 1000 - RESCAN_MARGIN_MS
  const scanWorstCaseMs = rescanWorstCaseMs(RESCAN_SCAN_TIMEOUTS)
  const schedule = request.headers.get('x-vercel-cron-schedule')
  const orgs: OrgAnswer[] = []

  let orgIds: string[]
  try {
    orgIds = await listOrgIds(db)
  } catch (err) {
    log.error('cron rescan failed', { route: 'cron.rescan', outcome: 'failed', error: errorName(err) })
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }

  for (const orgId of orgIds) {
    try {
      const profile = await activeIcpProfile(db, orgId)
      if (!profile) { orgs.push({ orgId, notRun: 'no_active_icp' }); continue }
      let definition: IcpDefinition
      try {
        definition = parseIcpDefinition(profile.definition)
      } catch {
        orgs.push({ orgId, notRun: 'unparseable_icp' })
        continue
      }
      // Before anything is selected: another delivery may be mid-run.
      const claim = await claimRescan(db, { orgId, now: new Date(), budgetMs: deadline - Date.now(), schedule })
      if (!claim.claimed) {
        orgs.push({ orgId, skipped: 'claimed', heldUntil: claim.heldUntil.toISOString() })
        continue
      }
      const result = await runRescan(db, {
        orgId,
        icp: { id: profile.id, definition },
        scan: (domain, company) => scanDomain(domain, definition, { company, ...RESCAN_SCAN_TIMEOUTS }),
        budgetMs: deadline - Date.now(),
        scanWorstCaseMs,
        batch: env().RESCAN_BATCH_SIZE,
        now: () => new Date(),
        unscannable: (err) => err instanceof UnscannableHostError,
        schedule,
      })
      orgs.push({ orgId, ...result })
    } catch (err) {
      orgs.push({ orgId, failed: errorName(err) })
    }
  }

  const failed = orgs.some((o) => 'failed' in o)
  if (failed) log.error('cron rescan finished', { route: 'cron.rescan', outcome: 'failed' })
  else log.info('cron rescan finished', { route: 'cron.rescan', outcome: 'ok' })
  return NextResponse.json({ orgs }, { status: failed ? 500 : 200 })
}

/** The class only. A driver error's message can carry the DSN (§2.3). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError'
}
