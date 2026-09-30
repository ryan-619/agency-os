/**
 * How old an observation is allowed to be before it must be re-verified.
 *
 * PROMPT.md §2.2: "Findings older than 14 days are marked stale and must be
 * re-verified before appearing in any outbound draft."
 *
 * The threshold is the ICP's `freshness.stale_after_days`, never a constant
 * here. The `findings.stale` COLUMN is a cache of this answer, written by a
 * sweep that only runs when someone runs a scan — so the column can say fresh
 * about an observation that aged past the threshold an hour ago. Anything
 * deciding whether a finding may be shown or quoted must ask this function
 * about the scan's `ran_at`, and treat the column as a hint, never as the
 * answer. A page that trusted the column rendered a three-week-old gap
 * unmarked.
 */
import { parseIcpDefinition } from './icp.js'

export const DEFAULT_STALE_AFTER_DAYS = 14

const MS_PER_DAY = 86_400_000

/**
 * The threshold an ICP definition sets, as every reader must take it: its
 * `freshness.stale_after_days` when that is a finite positive number, and
 * `DEFAULT_STALE_AFTER_DAYS` otherwise — no profile, a definition that is not
 * a readable ICP (`parseIcpDefinition` refuses it), no `freshness`, or a value
 * `isStale` would throw on.
 *
 * `parseIcpDefinition` does not check `freshness`, and `isStale` refuses a
 * non-positive threshold rather than call everything fresh. Readers that
 * passed the raw value between the two made a hand-edited `0` a 500 on the
 * proposal and company pages, the share link and two agent tools, while
 * `/compliance` fell back to the default — so the page and the tool that
 * must agree did not. Takes the stored `definition` (or an already-parsed
 * one) so there is nothing to read wrongly on the way in.
 */
export function staleAfterDaysOf(definition: unknown): number {
  if (definition === null || definition === undefined) return DEFAULT_STALE_AFTER_DAYS
  let days: unknown
  try {
    days = parseIcpDefinition(definition).freshness?.stale_after_days
  } catch {
    return DEFAULT_STALE_AFTER_DAYS
  }
  return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : DEFAULT_STALE_AFTER_DAYS
}

/** Is an observation made at `observedAt` past its re-verification deadline? */
export function isStale(
  observedAt: Date | string | null | undefined,
  staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS,
  now: Date = new Date(),
): boolean {
  if (observedAt === null || observedAt === undefined) return true
  const at = observedAt instanceof Date ? observedAt : new Date(observedAt)
  const ms = at.getTime()
  // An unparseable timestamp is not evidence that something is fresh.
  if (!Number.isFinite(ms)) return true
  if (!Number.isFinite(staleAfterDays) || staleAfterDays <= 0) {
    throw new Error(`staleAfterDays must be a positive number, got ${String(staleAfterDays)}`)
  }
  return now.getTime() - ms > staleAfterDays * MS_PER_DAY
}

/** The cut-off an "everything older than this is stale" query compares against. */
export function staleBefore(
  staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS,
  now: Date = new Date(),
): Date {
  if (!Number.isFinite(staleAfterDays) || staleAfterDays <= 0) {
    throw new Error(`staleAfterDays must be a positive number, got ${String(staleAfterDays)}`)
  }
  return new Date(now.getTime() - staleAfterDays * MS_PER_DAY)
}
