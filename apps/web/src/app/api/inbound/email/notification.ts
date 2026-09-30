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
 * Every field is named, never spread: the outcome is a row-shaped object a
 * later change may widen, and what reaches Slack is only what this list says.
 */
export function replyNotification(outcome: InboundOutcome): Extract<NotificationEvent, { kind: 'reply' }> | null {
  if (outcome.matched === 'none' || outcome.duplicate) return null
  return {
    kind: 'reply',
    orgId: outcome.orgId,
    contactId: outcome.contactId,
    touchId: outcome.touchId,
    companyDomain: outcome.companyDomain,
    replyKind: outcome.replyKind,
    paused: outcome.paused,
    suppressed: outcome.suppressed,
  }
}
