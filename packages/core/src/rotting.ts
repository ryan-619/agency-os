/**
 * Untouched-for-N-days, and what is due.
 *
 * A card on the board that nobody has changed for a while is the failure
 * mode a pipeline exists to make visible, so the board marks it. The number
 * it shows is measured from `deals.updated_at` — which `deals_set_updated_at`
 * writes on EVERY update of the row, a stage move or a due date alike — and
 * not from when the deal entered its stage, because there is no
 * `stage_entered_at` and inventing one from the wrong column would be a
 * finding nobody observed. The label is therefore "untouched for N days",
 * never "in stage for N days"; the copy is fixed here so the two cannot
 * drift apart.
 *
 * The thresholds live here and not in the component (CLAUDE.md §2: "the
 * board moves cards; the rules do not live on the board"). Pure: the clock
 * is an argument.
 */

const MS_PER_DAY = 86_400_000

/**
 * How many days a deal may sit unchanged at each stage before it is marked.
 *
 * `null` means the stage never rots: a won or lost deal is an outcome, and an
 * outcome does not go stale. Replied is the shortest — a person answered and
 * is waiting — and meeting/proposal the longest, because a proposal takes a
 * buyer's time to read, not ours.
 */
export const STAGE_ROT_DAYS: Readonly<Record<string, number | null>> = Object.freeze({
  new: 7,
  contacted: 10,
  replied: 5,
  meeting: 14,
  proposal: 14,
  won: null,
  lost: null,
})

export interface RottingState {
  /** Whole days since the row last changed. Never negative. */
  readonly days: number
  /** `days >= threshold`. */
  readonly rotten: boolean
  /** The stage's threshold, so a card can say "past 10 days". */
  readonly threshold: number
}

/**
 * How long a deal has gone untouched, and whether that is past the stage's
 * threshold. Null for a closed stage, a stage this module does not know, or
 * a timestamp that is not one — there is no honest number in any of those.
 *
 * Days are whole days, floored: six days and twenty-three hours is "6 days"
 * and is not yet rotten at a threshold of 7. A `lastChangedAt` in the future
 * is a clock problem, not a negative age, and reads as 0.
 */
export function rottingState(stage: string, lastChangedAt: Date, now: Date): RottingState | null {
  if (!Object.prototype.hasOwnProperty.call(STAGE_ROT_DAYS, stage)) return null
  const threshold = STAGE_ROT_DAYS[stage]
  if (threshold === null || threshold === undefined) return null
  const then = lastChangedAt.getTime()
  const at = now.getTime()
  if (!Number.isFinite(then) || !Number.isFinite(at)) return null
  const days = Math.max(0, Math.floor((at - then) / MS_PER_DAY))
  return { days, rotten: days >= threshold, threshold }
}

/** The one wording for the age line, so a component cannot say "in stage for". */
export function untouchedLabel(days: number): string {
  return `untouched for ${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * Is a due date past? A deal with no due date is not overdue — "nobody set
 * one" and "it is late" are different facts, and only one of them is a
 * reproach. Exactly `now` is not yet past.
 */
export function isOverdue(nextActionAt: Date | null | undefined, now: Date): boolean {
  if (nextActionAt === null || nextActionAt === undefined) return false
  const at = nextActionAt.getTime()
  if (!Number.isFinite(at)) return false
  return at < now.getTime()
}
