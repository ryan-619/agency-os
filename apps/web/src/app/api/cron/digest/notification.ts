import type { DigestCampaignPause, DigestFacts, DigestWorker } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * The Slack events the daily cron sends, built field by field.
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
  /** `heartbeatReportedStatus` — `retired` for a closed session nobody is alerted about. */
  readonly worker: DigestWorker
  /** The newest heartbeat's instant: a retired worker's line is dated by it. */
  readonly workerLastSeenAt: Date | null
  /**
   * The pauses `digestCampaignPauses` read and how many get a notice of
   * their own after the digest — so the digest can say how many more there
   * were past the cap.
   */
  readonly campaignPauses: { readonly found: number; readonly notices: number }
}): Extract<NotificationEvent, { kind: 'digest' }> {
  const f = args.facts
  const seen = args.workerLastSeenAt?.getTime()
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
    // An unreadable instant is no date at all, never "Invalid Date" in a channel.
    workerLastSeenAt: seen !== undefined && Number.isFinite(seen) ? new Date(seen).toISOString() : null,
    campaignPauses: { found: args.campaignPauses.found, notices: args.campaignPauses.notices },
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

/**
 * A campaign that paused itself because its addresses bounced — the notice
 * the worker cannot send (it has no Slack path). The campaign's id and the
 * two numbers the pause was made on; never its name, never who bounced. The
 * renderer links to /campaigns.
 */
export function campaignPausedNotification(args: {
  readonly orgId: string
  readonly pause: DigestCampaignPause
}): Extract<NotificationEvent, { kind: 'campaign_paused' }> {
  return {
    kind: 'campaign_paused',
    orgId: args.orgId,
    campaignId: args.pause.campaignId,
    bouncePct: args.pause.bouncePct,
    threshold: args.pause.threshold,
  }
}
