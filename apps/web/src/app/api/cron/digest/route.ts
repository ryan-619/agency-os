import { NextResponse } from 'next/server'
import { DEFAULT_STALE_AFTER_DAYS, parseIcpDefinition } from '@agency/core'
import {
  DIGEST_WINDOW_HOURS, activeIcpProfile, appendAudit, digestCounts, digestFacts, digestOnce, digestRecord,
  heartbeatReport, heartbeatSilentAfter, listOrgIds, readLatestHeartbeat,
  type AgencyDb, type DigestNotPosted, type DigestRecord,
} from '@agency/db/queries'
import { cronRequest } from '@/lib/cron-auth'
import { getDb } from '@/lib/db'
import { deployment } from '@/lib/deployment'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import type { NotificationEvent } from '@/lib/slack-message'
import { deliverNotification } from '@/lib/slack-post'
import { workerSilent } from '@/lib/worker-check'
import { digestNotification, workerSilentNotification } from './notification'

/**
 * The daily digest, and the alert that the worker has gone quiet (§2.3,
 * §2.4). Vercel calls it once a day — `vercel.json`, `43 6 * * *` — with
 * `Authorization: Bearer <CRON_SECRET>`, behind the same gate as the rescan.
 *
 * The CRM leaves notification to Slack: one message a morning saying what
 * needs a person — approvals, unhandled replies, rotting deals, stale
 * evidence, due tasks, the last day's refusals and spend — and, first among
 * them when it is not zero, an opt-out that could not be recorded. And a
 * separate message when a worker is configured and has not been heard from,
 * because that is the one fact that means approved messages are going
 * nowhere, and the worker cannot be the one to say it.
 *
 * ## Once a day, whatever Vercel delivers
 *
 * Vercel may deliver one cron event more than once. Each org runs inside
 * `digestOnce`: a transaction that takes an advisory lock, looks for a
 * `cron.digest` audit row in the last twenty hours, and only then gathers,
 * posts and records — so a duplicate waits on the lock, finds the row, and
 * sends nothing. Everything inside uses the transaction's handle, including
 * the `notification.*` rows the posts write: on Vercel the pool is one
 * connection and the transaction holds it. A post that fails is recorded
 * as such and is not retried until tomorrow's run — a retry is a second
 * message whenever the first one timed out after all.
 *
 * ## With no Slack
 *
 * Nothing leaves the building, and the run is still the record: the
 * `cron.digest` row is written with `posted: false, why: 'no_slack'` and the
 * counts, so /audit shows what the digest would have said, and the answer is
 * 200 `{ posted: false, why: 'no_slack' }`.
 *
 * ## What leaves
 *
 * Counts, refusal codes, company domains and a link to the dashboard — the
 * events in `slack-message.ts` have no field for anything else, and a free-
 * mail lead's `<address>.inbound` row is called "a personal address" there.
 * The log line carries the route and the outcome and nothing else.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Outcome =
  | { readonly posted: true; readonly workerSilent: boolean }
  | { readonly posted: false; readonly why: DigestNotPosted; readonly workerSilent: boolean }

type OrgAnswer =
  | ({ readonly orgId: string } & Outcome)
  | { readonly orgId: string; readonly skipped: 'already_ran' }
  | { readonly orgId: string; readonly failed: string }

export async function GET(request: Request): Promise<NextResponse> {
  const check = cronRequest({
    authorization: request.headers.get('authorization'),
    secret: env().CRON_SECRET,
    vercelEnv: env().VERCEL_ENV,
  })
  if (!check.ok) {
    log.warn('cron request refused', { route: 'cron.digest', outcome: check.error })
    return NextResponse.json({ error: check.error }, { status: check.status })
  }

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const since = new Date(now.getTime() - DIGEST_WINDOW_HOURS * 3_600_000)
  const slack = env().SLACK_WEBHOOK_URL ? { webhookUrl: env().SLACK_WEBHOOK_URL!, origin: env().AUTH_URL } : null
  const configured = deployment().worker
  const orgs: OrgAnswer[] = []

  let orgIds: string[]
  let heartbeat: Awaited<ReturnType<typeof readLatestHeartbeat>>
  try {
    // One worker serves every org in this database, so its heartbeat is read once.
    ;[orgIds, heartbeat] = await Promise.all([listOrgIds(db), readLatestHeartbeat(db)])
  } catch (err) {
    log.error('cron digest failed', { route: 'cron.digest', outcome: 'failed', error: errorName(err) })
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
  const report = heartbeatReport(heartbeat, configured, now)
  const silence = workerSilent(
    { configured, lastSeenAt: heartbeat?.lastTickAt ?? null },
    now,
    heartbeatSilentAfter(heartbeat),
  )

  for (const orgId of orgIds) {
    try {
      const run = await digestOnce(db, orgId, since, async (tx): Promise<Outcome> => {
        const facts = await digestFacts(tx, orgId, { now, staleDays: await staleDaysFor(tx, orgId) })
        const counts = digestCounts(facts)
        const base = { orgId, counts, worker: report.status } as const

        if (!slack) {
          await digestRecord(tx, {
            ...base, posted: false, why: 'no_slack', workerAlert: silence.silent ? 'no_slack' : 'not_needed',
          })
          return { posted: false, why: 'no_slack', workerSilent: silence.silent }
        }

        const posted = await post(tx, slack, digestNotification({ orgId, facts, worker: report.status }))
        // After the digest, so the alert is the newest message in the channel.
        let workerAlert: NonNullable<DigestRecord['workerAlert']> = 'not_needed'
        if (silence.silent) {
          const alerted = await post(
            tx,
            slack,
            workerSilentNotification({ orgId, lastSeenAt: report.lastSeenAt, ageSeconds: silence.ageSeconds }),
          )
          workerAlert = alerted ? 'posted' : 'failed'
        }
        if (posted) {
          await digestRecord(tx, { ...base, posted: true, workerAlert })
          return { posted: true, workerSilent: silence.silent }
        }
        await digestRecord(tx, { ...base, posted: false, why: 'slack_failed', workerAlert })
        return { posted: false, why: 'slack_failed', workerSilent: silence.silent }
      })
      orgs.push(run.ran ? { orgId, ...run.value } : { orgId, skipped: 'already_ran' })
    } catch (err) {
      orgs.push({ orgId, failed: errorName(err) })
    }
  }

  const failed = orgs.some((o) => 'failed' in o)
  const outcome = failed ? 'failed' : !slack ? 'no_slack' : orgs.some((o) => 'why' in o) ? 'slack_failed' : 'ok'
  if (outcome === 'ok' || outcome === 'no_slack') log.info('cron digest finished', { route: 'cron.digest', outcome })
  else if (outcome === 'slack_failed') log.warn('cron digest finished', { route: 'cron.digest', outcome })
  else log.error('cron digest finished', { route: 'cron.digest', outcome })

  return NextResponse.json(
    slack
      ? { posted: orgs.some((o) => 'posted' in o && o.posted), orgs }
      : { posted: false, why: 'no_slack', orgs },
    { status: failed ? 500 : 200 },
  )
}

/**
 * Post one event and say whether Slack took it. `deliverNotification` never
 * throws and returns nothing; what it did is what it asks the audit writer
 * to record, so that is where the answer is read — before the write, so a
 * row that fails to write cannot turn a message Slack accepted into one it
 * did not.
 */
async function post(
  tx: AgencyDb,
  slack: { readonly webhookUrl: string; readonly origin: string },
  event: NotificationEvent,
): Promise<boolean> {
  let sent = false
  await deliverNotification(event, {
    webhookUrl: slack.webhookUrl,
    origin: slack.origin,
    audit: async (entry) => {
      sent = entry.action === 'notification.sent'
      await appendAudit(tx, entry)
    },
  })
  return sent
}

/**
 * The ICP's staleness threshold, or §2.2's default. An org with no active
 * profile, or one that does not parse, still gets its digest: the threshold
 * is the only thing the digest reads from it.
 */
async function staleDaysFor(db: AgencyDb, orgId: string): Promise<number> {
  const profile = await activeIcpProfile(db, orgId)
  if (!profile) return DEFAULT_STALE_AFTER_DAYS
  try {
    const days = parseIcpDefinition(profile.definition).freshness?.stale_after_days
    return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : DEFAULT_STALE_AFTER_DAYS
  } catch {
    return DEFAULT_STALE_AFTER_DAYS
  }
}

/** The class only. A driver error's message can carry the DSN (§2.3). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError'
}
