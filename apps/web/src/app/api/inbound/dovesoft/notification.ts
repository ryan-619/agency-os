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
 * written in the filed contact's own org — that one raises the alarm below
 * instead, because "asked to stop … paused" would read as handled. A
 * suppression that failed only in ANOTHER org keeps this notice: the filed
 * org's reply was recorded whole, and the other org has its own alarm.
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

type OptOutAlarm = Extract<NotificationEvent, { kind: 'opt_out_not_recorded' }>

/**
 * The alarms a STOP raises when its phone suppression could not be written
 * — §2.1's Phase 4 obligation said to a person, the event the email,
 * unsubscribe and erasure paths send, with `path: 'reply'` (a text that said
 * stop is a reply). Each AWAITED by the route. None for every other outcome,
 * including a retry that wrote nothing it lacked.
 *
 * ONE PER ORG WHERE IT FAILED, filed under that org (review round 6). A
 * STOP filed under a contact whose own suppression failed names the message
 * it arrived on and that contact. Every other org the recorder reports
 * (`optOutNotRecordedIn`) gets its own: naming one of its contacts holding
 * the number, whose record holds it, with no message on file there — or,
 * where no contact there holds it (the `DOVESOFT_ORG_ID` a number nobody
 * holds is filed under, or an unreadable number), no contact either, and
 * the message links to /compliance rather than to anything built from the
 * number. Before, another org's failure was folded into the filed contact's
 * flag, so the one alarm named the org whose suppression had WORKED and the
 * org that needed it heard nothing.
 */
export function smsOptOutAlarms(outcome: InboundSmsOutcome): readonly OptOutAlarm[] {
  const alarms: OptOutAlarm[] = []
  if (outcome.matched === 'contact' && outcome.optOutNotRecorded && !outcome.duplicate) {
    alarms.push({
      kind: 'opt_out_not_recorded',
      orgId: outcome.orgId,
      touchId: outcome.touchId,
      contactId: outcome.contactId,
      path: 'reply',
    })
  }
  for (const lost of outcome.optOutNotRecordedIn) {
    alarms.push({ kind: 'opt_out_not_recorded', orgId: lost.orgId, touchId: null, contactId: lost.contactId, path: 'reply' })
  }
  return alarms
}

/**
 * The alarm for a STOP no message row and no contact can be named for — one
 * whose recording failed outright, before anything said whose it was. Filed
 * under `unplacedOrgId` (`DOVESOFT_ORG_ID`); null without one.
 */
export function smsUnplacedOptOutNotification(unplacedOrgId: string | null): OptOutAlarm | null {
  if (unplacedOrgId === null) return null
  return { kind: 'opt_out_not_recorded', orgId: unplacedOrgId, touchId: null, contactId: null, path: 'reply' }
}
