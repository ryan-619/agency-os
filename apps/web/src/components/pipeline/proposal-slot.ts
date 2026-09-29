/**
 * What the proposal page hands to each of its slots — the print and download
 * links, and the buyer's share link — beside the status control. Fixed here
 * so the page never changes when a slot fills in.
 */
export interface ProposalSlotProps {
  readonly orgId: string
  readonly proposalId: string
  readonly status: string
  /**
   * Derived by the page from the scan's `ran_at` (§2.2), never read from a
   * stored flag, so a slot that hands the document to anyone carries the
   * same warning the page shows.
   */
  readonly evidenceStale: boolean
  /** `can(principal, 'deals:write')` — the same capability the status control uses. */
  readonly canWrite: boolean
}
