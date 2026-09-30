import type { DigestFacts, DigestWorker } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * The two Slack events the daily cron sends, built field by field.
 *
 * Never a spread: the facts object is typed to hold counts and domains, and
 * copying the fields by name is what keeps it that way if somebody adds a
 * field to `DigestFacts` for a page — a spread would carry it to Slack
 * without anybody deciding it should go. A `.inbound` domain in
 * `topRotting` is passed through as it is and masked by `slackMessage`, the
 * one place that decides what a domain may be called in a channel.
 *
 * Beside the route, free of `server-only` and `@/`, so
 * `apps/web/test/worker-check.test.ts` runs this and not a copy.
 */
export function digestNotification(args: {
  readonly orgId: string
  readonly facts: DigestFacts
  readonly worker: DigestWorker
}): Extract<NotificationEvent, { kind: 'digest' }> {
  const f = args.facts
  return {
    kind: 'digest',
    orgId: args.orgId,
    pendingApprovals: f.pendingApprovals,
    unhandledReplies: f.unhandledReplies,
    rottingDeals: f.rottingDeals,
    staleCompanies: f.staleCompanies,
    neverScanned: f.neverScanned,
    dueTasks: f.dueTasks,
    overdueTasks: f.overdueTasks,
    refusals24h: f.refusals24h.map((r) => ({ code: r.code, n: r.n })),
    optOutsNotRecorded24h: f.optOutsNotRecorded24h,
    spend24hUsd: f.spend24hUsd,
    worker: args.worker,
    topRotting: [...f.topRotting],
  }
}

/** The alert that approvals are landing on nothing. The instant, in ISO, and how long ago — no more. */
export function workerSilentNotification(args: {
  readonly orgId: string
  readonly lastSeenAt: Date | null
  readonly ageSeconds: number | null
}): Extract<NotificationEvent, { kind: 'worker_silent' }> {
  return {
    kind: 'worker_silent',
    orgId: args.orgId,
    lastTickAt: args.lastSeenAt ? args.lastSeenAt.toISOString() : null,
    ageSeconds: args.ageSeconds,
  }
}
