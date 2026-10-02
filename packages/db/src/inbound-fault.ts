/**
 * A "stop" whose recording THREW, as every inbound email path reads it —
 * the two webhooks (`apps/web/src/app/api/inbound/email/fault.ts`) and the
 * worker's IMAP inbox (`apps/agent/src/outreach/inbox.ts`).
 *
 * `recordInboundReply` is one transaction, so a fault leaves nothing about
 * the reply stored, and the provider's retry (or the inbox's own) records
 * all of it. Until one lands, §2.1's Phase 4 obligation is unmet, and it
 * does not wait for a retry that may fail the same way: the contact is
 * paused, a `contact.opt_out_not_recorded` row is written — what
 * /compliance and the digest count, and what keeps /inbox from drafting to
 * them — and the alarm is raised.
 *
 * Whose it was comes from the recorder itself: its rolled-back line names
 * the org and the contact it was filing under, so nothing is read again
 * from a database that just failed and nothing re-decides what the words
 * meant. The webhooks kept that line; the IMAP path did not (review round
 * 6), so its stop was abandoned after five attempts with log lines only.
 * One reader of the line now, and one shape for what follows it, so a
 * person in /audit or the Slack channel cannot tell which process noticed.
 *
 * Pure: no I/O, no database, no clock. The callers write; this says what.
 */
import type { SlackOptOutNotRecordedEvent } from '@agency/core'
import type { InboundLog } from './outreach.js'

/** What the recorder said about a stop it rolled back: ids only. */
export interface RolledBackOptOut {
  readonly orgId: string
  readonly contactId: string
  /** The message the reply answered, when it was matched by one. */
  readonly inReplyTo: string | null
}

/**
 * The recorder's log, forwarded line for line to `forward` — and the last
 * `OPT-OUT NOT RECORDED` line that names an org and a contact, kept. On a
 * throw, the only line the recorder writes is the rolled-back one: its
 * other loud lines are said only once the reply has COMMITTED, so a caller
 * reads `rolledBack()` only when the recorder threw.
 */
export function keepingRolledBackOptOut(
  forward: InboundLog,
): InboundLog & { readonly rolledBack: () => RolledBackOptOut | null } {
  let kept: RolledBackOptOut | null = null
  return {
    error(message, fields) {
      forward.error(message, fields)
      const orgId = fields?.['orgId']
      const contactId = fields?.['contactId']
      if (message.startsWith('OPT-OUT NOT RECORDED') && typeof orgId === 'string' && typeof contactId === 'string') {
        const inReplyTo = fields?.['inReplyTo']
        kept = { orgId, contactId, inReplyTo: typeof inReplyTo === 'string' ? inReplyTo : null }
      }
    },
    rolledBack: () => kept,
  }
}

/**
 * The pause, in the words the reply path already uses for an opt-out whose
 * suppression could not be written (`recordInboundReply`, and sms.ts for a
 * text): `pauseReasonClass` reads it as `opt_out_not_recorded`, so no
 * answer from /inbox and no Resume on /contacts lifts it. Written with
 * `pauseContactOverriding`, over any earlier reason, because an older
 * `replied …` left in place is a pause answering that reply ends.
 */
export function rolledBackOptOutPauseReason(now: Date): string {
  return `opt-out not recorded: reply ${now.toISOString()} (record_failed)`
}

/** The audit row: ids, the channel and a reason class — never the address or the words (§2.3). */
export function rolledBackOptOutAudit(placed: RolledBackOptOut): {
  readonly orgId: string
  readonly actor: 'system'
  readonly action: 'contact.opt_out_not_recorded'
  readonly subjectType: 'contact'
  readonly subjectId: string
  readonly detail: { readonly channel: 'email'; readonly why: 'record_failed' }
} {
  return {
    orgId: placed.orgId,
    actor: 'system',
    action: 'contact.opt_out_not_recorded',
    subjectType: 'contact',
    subjectId: placed.contactId,
    detail: { channel: 'email', why: 'record_failed' },
  }
}

/**
 * The alarm. The touch it names is the message the reply answered; a reply
 * matched by its address alone answered none on file, and the message then
 * says so and names the contact (`slackOptOutNotRecordedPayload`).
 */
export function rolledBackOptOutAlarm(placed: RolledBackOptOut): SlackOptOutNotRecordedEvent {
  return {
    kind: 'opt_out_not_recorded',
    orgId: placed.orgId,
    touchId: placed.inReplyTo,
    contactId: placed.contactId,
    path: 'reply',
  }
}
