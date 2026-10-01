import {
  slackOptOutNotRecordedPayload,
  slackPayloadOf,
  type ReplyKind,
  type SlackOptOutNotRecordedEvent,
  type SlackPayload,
} from '@agency/core'
import { refusalWords } from './refusal-words'

/**
 * What a notification SAYS (§5.5's spirit: Slack gets ids and a link, never
 * lead data).
 *
 * A Slack channel is somebody else's system, outside every rule this
 * product enforces about who may see a prospect's words. So a message
 * carries the event, the company's public domain, the row ids, and a deep
 * link back into the app — where the session, the role and the audit log
 * are — and NEVER a body, a name, an address, a phone number, a note or a
 * chosen time. The union below has no field that could hold one, which is
 * how that rule is kept: the builder cannot leak what it was not given.
 * `slack-message.test.ts` still passes decoy fields through a cast and
 * asserts they never reach the payload, in case the builder ever spreads.
 *
 * A free-mail lead has no company; the booking page files them under
 * `<address>.inbound`, which IS the person's address with its punctuation
 * swapped. That row name reaches the channel NOWHERE — not in the text, and
 * not in the link either: Slack unfurls and logs every URL it is handed, so
 * a link built from the domain would post the address to hooks.slack.com
 * just as surely as writing it out. Such a message links to a page reached
 * by an id or to the list page instead (§5.5: lead data stays local).
 *
 * Pure: no `env()`, no `fetch`, no `server-only`, so the whole vocabulary is
 * testable as data. The origin is an argument — `env().AUTH_URL`, never the
 * Host header — because the link is what somebody clicks, and a forged host
 * would send them somewhere else.
 *
 * One message has a second sender. An opt-out that could not be recorded is
 * also raised by the worker, for a reply it read over IMAP, so that message
 * — and the cut at Slack's length limit every message gets — is built by
 * `packages/core/src/slack-payload.ts`, which both processes call: the
 * channel reads the same bytes whichever one noticed.
 */
export type NotificationEvent =
  | {
      kind: 'reply'
      orgId: string
      contactId: string
      touchId: string
      companyDomain: string | null
      replyKind: ReplyKind
      paused: boolean
      suppressed: boolean
    }
  | { kind: 'booking'; orgId: string; meetingId: string; companyDomain: string; needsReview: boolean }
  | { kind: 'deal_closed'; orgId: string; dealId: string; companyDomain: string; stage: 'won' | 'lost' }
  | {
      kind: 'proposal_accepted'
      orgId: string
      proposalId: string
      companyDomain: string
      via: 'team' | 'share_link'
    }
  /** Built in packages/core: the worker raises it too. */
  | SlackOptOutNotRecordedEvent
  | { kind: 'worker_silent'; orgId: string; lastTickAt: string | null; ageSeconds: number | null }
  | {
      kind: 'digest'
      orgId: string
      pendingApprovals: number
      unhandledReplies: number
      rottingDeals: number
      staleCompanies: number
      neverScanned: number
      dueTasks: number
      overdueTasks: number
      refusals24h: readonly { code: string; n: number }[]
      optOutsNotRecorded24h: number
      spend24hUsd: string
      worker: DigestWorkerStatus
      /** The newest heartbeat's instant, ISO — what a retired worker's line dates it by. */
      workerLastSeenAt: string | null
      /**
       * The bounce auto-pauses this run read, and how many get a
       * `campaign_paused` notice of their own after this message (at most
       * the cap). Counts only: the rest are named on /campaigns.
       */
      campaignPauses: { found: number; notices: number }
      /** Domains, most rotten first. */
      topRotting: readonly string[]
    }
  | { kind: 'campaign_paused'; orgId: string; campaignId: string; bouncePct: number; threshold: number }

export type { SlackPayload }

const REPLY_WORDS: Readonly<Record<ReplyKind, string>> = {
  opted_out: 'asked to stop',
  interested: 'interested',
  not_now: 'not now',
  wrong_person: 'the wrong person',
  auto_reply: 'an automatic reply',
  other: 'a reply',
}

/** The digest's "Worker:" vocabulary — `heartbeatReportedStatus` in packages/db. */
type DigestWorkerStatus = 'never' | 'live' | 'silent' | 'not_configured' | 'retired'

const WORKER_WORDS: Readonly<Record<Exclude<DigestWorkerStatus, 'retired'>, string>> = {
  never: 'never seen',
  live: 'live',
  silent: 'SILENT — nothing is sending or reading replies',
  not_configured: 'not configured on this deployment',
}

/**
 * A session somebody ran by hand and closed more than a week ago, with no
 * worker configured: dated by its last heartbeat (the UTC day — the instant
 * is on /settings/deployment) and not called silent, because nobody is being
 * alerted about it and the line should not read as an alarm.
 */
function workerWords(worker: DigestWorkerStatus, lastSeenAt: string | null): string {
  if (worker !== 'retired') return WORKER_WORDS[worker]
  const day = lastSeenAt !== null && /^\d{4}-\d{2}-\d{2}T/.test(lastSeenAt) ? lastSeenAt.slice(0, 10) : null
  return `retired — ${day ? `last seen ${day}; ` : ''}no worker is configured, so nothing is sending or reading replies`
}

/**
 * The company a message is about, as it may be said out loud. A free-mail
 * lead's `<address>.inbound` row is named after the person, so it is not
 * said at all.
 */
export function displayDomain(domain: string | null): string {
  if (!domain || domain.endsWith('.inbound')) return 'a personal address'
  return domain
}

/** A row name that must not leave the building — see `displayDomain`. */
function isPersonal(domain: string | null): boolean {
  return displayDomain(domain) !== domain
}

export function slackMessage(event: NotificationEvent, origin: string): SlackPayload {
  const base = origin.replace(/\/+$/, '')
  const link = (path: string): string => `${base}${path}`
  /**
   * The company page for a real domain; for a free-mail lead's row, the
   * page given instead — one whose path carries no part of the address.
   */
  const companyLink = (domain: string | null, instead: string): string =>
    domain && !isPersonal(domain) ? link(`/companies/${encodeURIComponent(domain)}`) : link(instead)
  const lines: string[] = []

  switch (event.kind) {
    case 'reply': {
      lines.push(`Reply from ${displayDomain(event.companyDomain)} — ${REPLY_WORDS[event.replyKind]}.`)
      if (event.suppressed) {
        lines.push('They asked to stop — do not answer. The address is on the suppression list.')
      } else if (event.paused) {
        lines.push('Their sequence is paused; nothing more goes out until a person decides.')
      }
      lines.push(`touch ${event.touchId} · contact ${event.contactId}`)
      lines.push(companyLink(event.companyDomain, '/inbox'))
      break
    }
    case 'booking': {
      lines.push(`New booking — ${displayDomain(event.companyDomain)}.`)
      if (event.needsReview) {
        lines.push('The company record needs a look: the address was free-mail, so the company is named after the person.')
      }
      lines.push(`meeting ${event.meetingId}`)
      lines.push(link(`/meetings/${encodeURIComponent(event.meetingId)}`))
      break
    }
    case 'deal_closed': {
      lines.push(`Deal ${event.stage} — ${displayDomain(event.companyDomain)}.`)
      lines.push(`deal ${event.dealId}`)
      lines.push(companyLink(event.companyDomain, '/pipeline'))
      break
    }
    case 'proposal_accepted': {
      lines.push(
        `Proposal accepted — ${displayDomain(event.companyDomain)}, ${
          event.via === 'share_link' ? 'through the share link' : 'recorded by the team'
        }. The deal closes as won.`,
      )
      lines.push(`proposal ${event.proposalId}`)
      lines.push(link(`/proposals/${encodeURIComponent(event.proposalId)}`))
      break
    }
    case 'opt_out_not_recorded':
      // The worker posts this one too; one builder, so the bytes are the same.
      return slackOptOutNotRecordedPayload(event, origin)
    case 'worker_silent': {
      lines.push('Worker silent.')
      lines.push(
        event.lastTickAt
          ? `Last tick ${event.lastTickAt}${event.ageSeconds != null ? `, ${event.ageSeconds}s ago` : ''}.`
          : 'It has never ticked.',
      )
      lines.push('Approved messages are not being sent and replies are not being read until it is back.')
      lines.push(link('/settings/deployment'))
      break
    }
    case 'digest': {
      lines.push('Daily digest.')
      lines.push(
        `Approvals pending: ${event.pendingApprovals} · replies unhandled: ${event.unhandledReplies} · deals rotting: ${event.rottingDeals}`,
      )
      lines.push(`Companies stale: ${event.staleCompanies} · never scanned: ${event.neverScanned}`)
      lines.push(`Tasks due: ${event.dueTasks} (overdue: ${event.overdueTasks})`)
      lines.push(
        event.refusals24h.length === 0
          ? 'Refusals in the last 24h: none'
          : `Refusals in the last 24h: ${event.refusals24h.map((r) => `${r.n} ${refusalWords(r.code)}`).join(', ')}`,
      )
      if (event.optOutsNotRecorded24h > 0) {
        lines.push(`NEEDS A PERSON: ${event.optOutsNotRecorded24h} opt-out(s) in the last 24h could not be recorded.`)
      }
      // Past the cap a pause gets no notice of its own; this line is where the
      // channel hears there were more. A count and the list page, never a name.
      const shown = Math.max(0, event.campaignPauses.notices)
      const more = event.campaignPauses.found - shown
      if (more > 0) {
        const campaigns = more === 1 ? 'campaign paused itself' : 'campaigns paused themselves'
        lines.push(
          shown > 0
            ? `Campaign pauses: ${shown} announced below, and ${more} more ${campaigns} — see ${link('/campaigns')}`
            : `${more} ${campaigns} since the last digest — see ${link('/campaigns')}`,
        )
      }
      lines.push(`Agent spend in the last 24h: USD ${event.spend24hUsd}`)
      lines.push(`Worker: ${workerWords(event.worker, event.workerLastSeenAt)}`)
      if (event.topRotting.length > 0) {
        lines.push(`Rotting first: ${event.topRotting.map(displayDomain).join(', ')}`)
      }
      lines.push(link('/'))
      break
    }
    case 'campaign_paused': {
      lines.push(
        `Campaign paused itself — ${event.bouncePct}% of what it sent bounced, past the ${event.threshold}% threshold. Check the addresses before turning it back on.`,
      )
      lines.push(`campaign ${event.campaignId}`)
      lines.push(link('/campaigns'))
      break
    }
  }

  // A digest with a long tail is cut at Slack's limit, not dropped.
  return slackPayloadOf(lines)
}
