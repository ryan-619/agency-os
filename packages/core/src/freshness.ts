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

export const DEFAULT_STALE_AFTER_DAYS = 14

const MS_PER_DAY = 86_400_000

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
