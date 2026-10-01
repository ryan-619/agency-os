import type { ShareAcceptResult } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../../lib/slack-message'

/**
 * The Slack event for a proposal a buyer accepted through its share link —
 * or null for a refusal, which posts nothing.
 *
 * Read off what `shareAccept` returned, which is what was written: ids and
 * the company's domain. The name the buyer typed is on the share row and
 * never here, and neither is the token. `via: 'share_link'` is what tells
 * this apart from the team's own button, which posts `'team'` from its own
 * route. The deal closing as won is the same event, not a second message.
 *
 * Beside the route, free of `server-only` and `@/`, so
 * `apps/web/test/proposal-buyer-view.test.ts` runs this and not a copy.
 */
export function shareAcceptedNotification(
  result: ShareAcceptResult,
): Extract<NotificationEvent, { kind: 'proposal_accepted' }> | null {
  if (!result.ok) return null
  return {
    kind: 'proposal_accepted',
    orgId: result.orgId,
    proposalId: result.proposalId,
    companyDomain: result.companyDomain,
    via: 'share_link',
  }
}
