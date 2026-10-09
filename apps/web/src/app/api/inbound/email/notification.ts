import type { InboundOutcome } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * The Slack event a recorded reply announces — or null, when nothing was
 * recorded that the team could act on.
 *
 * Kept beside the route rather than inside it so the route's OWN
 * construction is what `apps/web/test/notification-shapes.test.ts` runs: a
 * route file cannot be imported by a test (it reaches `server-only` through
 * `@/lib/db`), and a test that rebuilt the event by hand would prove its
 * copy, not the route. So this file imports types only, relatively, and
 * nothing that reads the environment.
 *
 * Two outcomes announce nothing:
 *
 *  - `matched: 'none'` — nothing was written, and `why` names a routing
 *    failure (an address two orgs share, one no org has) that nobody can act
 *    on from a Slack channel;
 *  - `duplicate` — a provider retried a delivery that was already recorded.
 *    Without this the channel hears about one reply once per retry, and a
 *    FIRST delivery for an already-paused contact looks identical otherwise
 *    (`paused: false, suppressed: false` on both).
 *
 * And one is not a reply message at all: a reply that said stop and whose
 * suppression row could not be written (`optOutNotRecorded`). The ordinary
 * message would say "asked to stop … paused", which reads as handled; that
 * reply raises `optOutNotRecordedNotification`'s alarm instead.
 *
 * Every field is named, never spread: the outcome is a row-shaped object a
 * later change may widen, and what reaches Slack is only what this list says.
 */
export function replyNotification(outcome: InboundOutcome): Extract<NotificationEvent, { kind: 'reply' }> | null {
  if (outcome.matched === 'none' || outcome.duplicate || outcome.optOutNotRecorded) return null
  const event: Extract<NotificationEvent, { kind: 'reply' }> = {
    kind: 'reply',
    orgId: outcome.orgId,
    contactId: outcome.contactId,
    touchId: outcome.touchId,
    companyDomain: outcome.companyDomain,
    replyKind: outcome.replyKind,
    paused: outcome.paused,
    suppressed: outcome.suppressed,
  }
  // A colleague's reply filed under the contact our mail went to (review
  // round 8): "they asked to stop" beside the contact's id pointed a person
  // at somebody who never asked. Said only when it is so; a reply of the
  // contact's own posts the bytes it always did.
  if (outcome.fromIsContact === false) event.fromIsContact = false
  return event
}

/**
 * The alarm a reply raises when it asked to be left alone and no
 * suppression row could be written — or null for every other outcome.
 *
 * §2.1's Phase 4 obligation: an opt-out that failed to store must reach a
 * person. `recordInboundReply` has already audited it and logged `OPT-OUT
 * NOT RECORDED`; this is the real-time half, the same event the unsubscribe
 * and erasure routes send. The route AWAITS it rather than scheduling it
 * with `after()`, because a host without `waitUntil` would drop a
 * scheduled post silently, and this is the one notification that must not
 * be lost to a platform detail. A retried delivery raises nothing: the first
 * one did, and `duplicate` answers `optOutNotRecorded: false`.
 */
export function optOutNotRecordedNotification(
  outcome: InboundOutcome,
): Extract<NotificationEvent, { kind: 'opt_out_not_recorded' }> | null {
  if (outcome.matched === 'none' || outcome.duplicate || !outcome.optOutNotRecorded) return null
  // A colleague's stop filed under the contact our mail went to (review
  // round 7): the opt-out is the sender's, so the alarm names their reply
  // and never the contact, whose address is the wrong one to record.
  if (outcome.fromIsContact === false) {
    return {
      kind: 'opt_out_not_recorded',
      orgId: outcome.orgId,
      touchId: outcome.touchId,
      contactId: null,
      path: 'reply',
      fromIsContact: false,
    }
  }
  return {
    kind: 'opt_out_not_recorded',
    orgId: outcome.orgId,
    touchId: outcome.touchId,
    contactId: outcome.contactId,
    path: 'reply',
  }
}
