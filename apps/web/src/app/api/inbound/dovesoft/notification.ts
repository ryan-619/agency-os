import type { InboundSmsOutcome } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * The Slack events a text a contact sent back raises — the SMS twins of
 * `../email/notification.ts`, built from `recordInboundSms`'s outcome.
 *
 * Kept beside the route, importing types only, so the route's OWN
 * construction is what `apps/web/test/dovesoft-webhook.test.ts` runs. Every
 * field is named, never spread: ids, the company's domain and the kind —
 * never the number, never the words (`lib/slack-message.ts`).
 */

type Filed = Extract<InboundSmsOutcome, { matched: 'contact' }>

/**
 * The ordinary reply notice, or null: nothing filed under a contact, a
 * retried push (`duplicate`), and a STOP whose suppression could not be
 * written — that one raises the alarm below instead, because "asked to
 * stop … paused" would read as handled.
 */
export function smsReplyNotification(outcome: InboundSmsOutcome): Extract<NotificationEvent, { kind: 'reply' }> | null {
  if (outcome.matched !== 'contact' || outcome.duplicate || outcome.optOutNotRecorded) return null
  const filed: Filed = outcome
  return {
    kind: 'reply',
    orgId: filed.orgId,
    contactId: filed.contactId,
    touchId: filed.touchId,
    companyDomain: filed.companyDomain,
    replyKind: filed.replyKind,
    paused: filed.paused,
    suppressed: filed.suppressed,
  }
}

/**
 * The alarm a STOP raises when its phone suppression could not be written —
 * §2.1's Phase 4 obligation said to a person, the event the email, unsubscribe
 * and erasure paths send, with `path: 'reply'` (a text that said stop is a
 * reply). AWAITED by the route. Null for every other outcome, including a
 * retry, which answers `optOutNotRecorded: false`.
 *
 * Only for a text filed under a contact: the event names the message the
 * request arrived on, and a STOP from a number no single contact holds has
 * no message row. That case is answered 500 so DoveSoft retries the
 * suppression, and the recorder's audit row and error line record it.
 */
export function smsOptOutNotRecordedNotification(
  outcome: InboundSmsOutcome,
): Extract<NotificationEvent, { kind: 'opt_out_not_recorded' }> | null {
  if (outcome.matched !== 'contact' || outcome.duplicate || !outcome.optOutNotRecorded) return null
  return {
    kind: 'opt_out_not_recorded',
    orgId: outcome.orgId,
    touchId: outcome.touchId,
    contactId: outcome.contactId,
    path: 'reply',
  }
}
