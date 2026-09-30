import type { ReplyKind } from '@agency/core'
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
  | {
      kind: 'opt_out_not_recorded'
      orgId: string
      /** The touch the request arrived on: the clicked message, or the inbound reply. */
      touchId: string
      contactId: string | null
      /** Which way the person asked: the unsubscribe link, an erasure, or a reply that said stop. */
      path: 'unsubscribe' | 'erasure' | 'reply'
    }
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
      worker: 'never' | 'live' | 'silent' | 'not_configured'
      /** Domains, most rotten first. */
      topRotting: readonly string[]
    }
  | { kind: 'campaign_paused'; orgId: string; campaignId: string; bouncePct: number; threshold: number }

export interface SlackPayload {
  readonly text: string
  readonly blocks?: readonly unknown[]
}

/** Slack refuses a `text` past this; a digest with a long tail is cut, not dropped. */
const MAX_TEXT = 4000

const REPLY_WORDS: Readonly<Record<ReplyKind, string>> = {
  opted_out: 'asked to stop',
  interested: 'interested',
  not_now: 'not now',
  wrong_person: 'the wrong person',
  auto_reply: 'an automatic reply',
  other: 'a reply',
}

const WORKER_WORDS: Readonly<Record<'never' | 'live' | 'silent' | 'not_configured', string>> = {
  never: 'never seen',
  live: 'live',
  silent: 'SILENT — nothing is sending or reading replies',
  not_configured: 'not configured on this deployment',
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
    case 'opt_out_not_recorded': {
      lines.push(
        `OPT-OUT NOT RECORDED. Somebody asked to be left alone through ${
          event.path === 'unsubscribe' ? 'the unsubscribe link' : event.path === 'reply' ? 'a reply' : 'an erasure request'
        } and no suppression row could be written. A person has to record it now.`,
      )
      lines.push(`touch ${event.touchId} · contact ${event.contactId ?? 'unknown'}`)
      lines.push(link('/suppressions'))
      break
    }
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
      lines.push(`Agent spend in the last 24h: USD ${event.spend24hUsd}`)
      lines.push(`Worker: ${WORKER_WORDS[event.worker]}`)
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

  const text = lines.join('\n')
  return { text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text }
}
