import type { DealRow } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * Whether a board move CLOSED the deal, and how — or null when it did not.
 *
 * Read off the row before the PATCH and the row `setDealStage` returned,
 * never off the request: a PATCH naming `won` on a deal that is already won
 * re-stamps `closed_at` and changes nothing anybody needs to hear about, and
 * a PATCH that only edits `nextAction` never touched the stage at all.
 * Reopening a closed deal is a move too, but not a close — it announces
 * nothing.
 *
 * Beside the route, free of `server-only` and `@/`, so
 * `apps/web/test/notification-shapes.test.ts` runs this and not a copy.
 */
export function closedStage(
  before: Pick<DealRow, 'stage'>,
  after: Pick<DealRow, 'stage'>,
): 'won' | 'lost' | null {
  if (after.stage === before.stage) return null
  if (after.stage === 'won') return 'won'
  if (after.stage === 'lost') return 'lost'
  return null
}

/**
 * The Slack event for a closed deal. The lost reason is NOT in it: it is a
 * person's free text about a prospect, and a channel is outside every rule
 * about who may read that — the link goes back to where it can be read.
 */
export function dealClosedNotification(args: {
  readonly orgId: string
  readonly dealId: string
  readonly stage: 'won' | 'lost'
  readonly companyDomain: string
}): Extract<NotificationEvent, { kind: 'deal_closed' }> {
  return {
    kind: 'deal_closed',
    orgId: args.orgId,
    dealId: args.dealId,
    companyDomain: args.companyDomain,
    stage: args.stage,
  }
}
