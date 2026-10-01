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
 * A STOP filed under a contact names the message it arrived on. One from a
 * number no single contact holds — nobody, several people, or a number that
 * is not E.164 — has no message row and no contact, so it goes with
 * `touchId: null` and `contactId: null`, and the message links to
 * /compliance rather than to anything built from the number. It is filed
 * under `unplacedOrgId`, the deployment's `DOVESOFT_ORG_ID` — the org the
 * recorder audits such a push under — and is null without one: the
 * notification's audit row needs an org, and the route then says in its
 * error line that no alarm was raised.
 */
export function smsOptOutNotRecordedNotification(
  outcome: InboundSmsOutcome,
  unplacedOrgId: string | null,
): Extract<NotificationEvent, { kind: 'opt_out_not_recorded' }> | null {
  if (!outcome.optOutNotRecorded) return null
  if (outcome.matched === 'none') return smsUnplacedOptOutNotification(unplacedOrgId)
  if (outcome.duplicate) return null
  return {
    kind: 'opt_out_not_recorded',
    orgId: outcome.orgId,
    touchId: outcome.touchId,
    contactId: outcome.contactId,
    path: 'reply',
  }
}

/**
 * The alarm for a STOP no message row and no contact can be named for — one
 * from a number no single contact holds, and one whose recording failed
 * outright, before anything said whose it was. Filed under `unplacedOrgId`
 * (`DOVESOFT_ORG_ID`); null without one.
 */
export function smsUnplacedOptOutNotification(
  unplacedOrgId: string | null,
): Extract<NotificationEvent, { kind: 'opt_out_not_recorded' }> | null {
  if (unplacedOrgId === null) return null
  return { kind: 'opt_out_not_recorded', orgId: unplacedOrgId, touchId: null, contactId: null, path: 'reply' }
}
