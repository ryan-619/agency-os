import type { ProposalRow } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * The Slack event for a proposal the team marked accepted — or null for any
 * other status this route records.
 *
 * Read off the row `setProposalStatus` returned, which is what was written,
 * not off the request. `via` is `'team'` because this route is the team's
 * own button; a buyer accepting through a share link is announced by that
 * route, as `'share_link'`. Accepting also closes the deal as won (inside
 * `setProposalStatus`), and that close is NOT announced separately: it is
 * the same event, and the message already says the deal closes.
 *
 * Beside the route, free of `server-only` and `@/`, so
 * `apps/web/test/notification-shapes.test.ts` runs this and not a copy.
 */
export function proposalAcceptedNotification(args: {
  readonly orgId: string
  readonly row: Pick<ProposalRow, 'id' | 'status'>
  readonly companyDomain: string
}): Extract<NotificationEvent, { kind: 'proposal_accepted' }> | null {
  if (args.row.status !== 'accepted') return null
  return {
    kind: 'proposal_accepted',
    orgId: args.orgId,
    proposalId: args.row.id,
    companyDomain: args.companyDomain,
    via: 'team',
  }
}
