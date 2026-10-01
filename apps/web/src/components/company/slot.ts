/**
 * What the company page hands to each of its slots.
 *
 * The page is written once and mounts four slots — edit, informational
 * signals, evidence panels, notes — each a server component that a later
 * feature replaces wholesale. This is the contract between them, fixed so
 * that the page never changes when a slot fills in: everything a slot needs
 * to read or write about the company, and nothing a slot could disagree
 * with the page about.
 */
export interface CompanySlotProps {
  readonly orgId: string
  readonly companyId: string
  readonly domain: string
  readonly userId: string
  /**
   * `can(principal, 'companies:write')` — what the edit and notes slots need.
   * A slot that writes something else (a deal, a task) re-derives its own
   * capability inside, from `userId`, rather than trusting this one.
   */
  readonly canWrite: boolean
  /** The ICP's freshness threshold, so a slot judges staleness the way the page does. */
  readonly staleAfterDays: number
}
