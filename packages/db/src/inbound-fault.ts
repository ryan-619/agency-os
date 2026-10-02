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
 * The contact it was filing under is not always who asked (review round
 * 7). A reply matched by References is filed under the contact OUR message
 * went to, whoever answered it, so a colleague in the thread replying all
 * "please remove me" was held as the contact's own opt-out nobody recorded
 * — a pause no Resume lifts and a row the inbox reads however old — and
 * the contact, who never asked to stop, was locked out for good, even once
 * the retry suppressed the colleague. The line says `fromIsContact` now,
 * and when the sender was somebody else everything below is about THEM:
 * the contact is paused as by any reply, the row is about the message
 * they answered with the contact only as `filedUnder`, and the alarm says
 * whose address to record.
 *
 * And the sender is held (review round 8): when they are a contact of the
 * org too, the recorder read who they are before the fault and named them
 * on its line (`senderContactIds`), and each is held as their own opt-out
 * nobody recorded — paused over any earlier reason and audited as theirs
 * (`rolledBackSenderHolds`), by id, so nothing is read again here either.
 * Until then a colleague's stop held nobody who asked, and the sender's
 * approved message went on the next tick while the retries ran.
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
  /**
   * Whether the reply came from that contact. False only when the recorder
   * said so — a sender shown to be another address, such as a colleague in
   * the thread; a line that does not say (the fault came before the
   * recorder read the contact) is true, which holds the contact as before.
   */
  readonly fromIsContact: boolean
  /**
   * For a stop from somebody else, the contacts of the org who ARE the
   * sender, as the recorder found them before the fault (review round 8):
   * held as the opt-out nobody recorded (`rolledBackSenderHolds`). Absent
   * when the line does not name them — the fault came before the recorder
   * looked, or the stop was the contact's own.
   */
  readonly senderContactIds?: readonly string[]
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
        const fromIsContact = fields?.['fromIsContact'] !== false
        const senders = fields?.['senderContactIds']
        kept = {
          orgId,
          contactId,
          inReplyTo: typeof inReplyTo === 'string' ? inReplyTo : null,
          fromIsContact,
          ...(!fromIsContact && Array.isArray(senders)
            ? { senderContactIds: senders.filter((id): id is string => typeof id === 'string' && id !== contactId) }
            : {}),
        }
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

/**
 * How the contact is held until a retry records the reply.
 *
 * Their own stop: the reason above, `overriding` any earlier one. A stop
 * from somebody else is not theirs to be held for (review round 7): they
 * are paused as the recorded reply would have paused them, `replied <ISO>`,
 * and only if nothing holds them already (`pauseContact`, which keeps a
 * stronger reason) — a pause a person lifts, and one the retry's own pause
 * finds in place and keeps.
 */
export function rolledBackOptOutPause(
  placed: RolledBackOptOut,
  now: Date,
): { readonly reason: string; readonly overriding: boolean } {
  return placed.fromIsContact
    ? { reason: rolledBackOptOutPauseReason(now), overriding: true }
    : { reason: `replied ${now.toISOString()}`, overriding: false }
}

/**
 * How each contact who IS the sender of a colleague's stop is held until a
 * retry records it (review round 8): as the opt-out nobody recorded that it
 * is — the pause above, `overriding` any earlier reason, which no answer and
 * no Resume lifts — and a `contact.opt_out_not_recorded` row with them as
 * its subject, the shape the contact's own stop writes. Nothing for the
 * contact's own stop, which `rolledBackOptOutPause` already holds.
 */
export function rolledBackSenderHolds(
  placed: RolledBackOptOut,
  now: Date,
): readonly {
  readonly contactId: string
  readonly reason: string
  readonly audit: {
    readonly orgId: string
    readonly actor: 'system'
    readonly action: 'contact.opt_out_not_recorded'
    readonly subjectType: 'contact'
    readonly subjectId: string
    readonly detail: { readonly channel: 'email'; readonly why: 'record_failed' }
  }
}[] {
  if (placed.fromIsContact) return []
  return (placed.senderContactIds ?? []).map((contactId) => ({
    contactId,
    reason: rolledBackOptOutPauseReason(now),
    audit: {
      orgId: placed.orgId,
      actor: 'system',
      action: 'contact.opt_out_not_recorded',
      subjectType: 'contact',
      subjectId: contactId,
      detail: { channel: 'email', why: 'record_failed' },
    },
  }))
}

/** The audit row: ids, the channel and a reason class — never the address or the words (§2.3). */
export function rolledBackOptOutAudit(placed: RolledBackOptOut): {
  readonly orgId: string
  readonly actor: 'system'
  readonly action: 'contact.opt_out_not_recorded'
  readonly subjectType: 'contact' | 'touch' | null
  readonly subjectId: string | null
  readonly detail:
    | { readonly channel: 'email'; readonly why: 'record_failed' }
    | { readonly channel: 'email'; readonly why: 'record_failed'; readonly fromIsContact: false; readonly filedUnder: string }
} {
  if (!placed.fromIsContact) {
    // About the message they answered, which names the company, and never
    // the contact: a row whose subject or `contactId` is the contact is
    // what /inbox and /contacts read as the contact's OWN opt-out nobody
    // recorded, for good. `filedUnder` is the id, for a person to follow.
    return {
      orgId: placed.orgId,
      actor: 'system',
      action: 'contact.opt_out_not_recorded',
      subjectType: placed.inReplyTo ? 'touch' : null,
      subjectId: placed.inReplyTo,
      detail: { channel: 'email', why: 'record_failed', fromIsContact: false, filedUnder: placed.contactId },
    }
  }
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
 * says so and names the contact (`slackOptOutNotRecordedPayload`). A stop
 * from somebody else names no contact — suppressing the contact's address
 * would record nobody's opt-out — and says the sender was another address.
 */
export function rolledBackOptOutAlarm(placed: RolledBackOptOut): SlackOptOutNotRecordedEvent {
  if (!placed.fromIsContact) {
    return {
      kind: 'opt_out_not_recorded',
      orgId: placed.orgId,
      touchId: placed.inReplyTo,
      contactId: null,
      path: 'reply',
      fromIsContact: false,
    }
  }
  return {
    kind: 'opt_out_not_recorded',
    orgId: placed.orgId,
    touchId: placed.inReplyTo,
    contactId: placed.contactId,
    path: 'reply',
  }
}
