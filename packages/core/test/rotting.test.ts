/**
 * Untouched-for-N-days. The number is measured from `deals.updated_at`,
 * which every change to the row writes — so it is "untouched", never "in
 * stage", and the label is fixed in core so a component cannot say otherwise.
 */
import { describe, it, expect } from 'vitest'
import { STAGE_ROT_DAYS, dealIsOverdue, rottingState, untouchedLabel } from '../src/rotting.js'

const DAY = 86_400_000
const now = new Date('2026-09-30T12:00:00.000Z')
const ago = (ms: number): Date => new Date(now.getTime() - ms)

describe('STAGE_ROT_DAYS', () => {
  it('has a threshold for every open stage and none for an outcome', () => {
    expect(STAGE_ROT_DAYS).toEqual({
      new: 7, contacted: 10, replied: 5, meeting: 14, proposal: 14, won: null, lost: null,
    })
    expect(Object.isFrozen(STAGE_ROT_DAYS)).toBe(true)
  })
})

describe('rottingState', () => {
  /**
   * THE boundary. Whole days, floored: a minute short of the threshold is
   * still inside it, and the threshold itself is past.
   */
  it('turns rotten on the threshold day, not a minute before', () => {
    expect(rottingState('replied', ago(5 * DAY - 60_000), now)).toEqual({ days: 4, rotten: false, threshold: 5 })
    expect(rottingState('replied', ago(5 * DAY), now)).toEqual({ days: 5, rotten: true, threshold: 5 })
    expect(rottingState('replied', ago(12 * DAY), now)).toEqual({ days: 12, rotten: true, threshold: 5 })
  })

  it('uses each stage’s own threshold', () => {
    expect(rottingState('new', ago(7 * DAY), now)?.rotten).toBe(true)
    expect(rottingState('contacted', ago(7 * DAY), now)?.rotten).toBe(false)
    expect(rottingState('contacted', ago(10 * DAY), now)?.rotten).toBe(true)
    expect(rottingState('meeting', ago(13 * DAY), now)?.rotten).toBe(false)
    expect(rottingState('proposal', ago(14 * DAY), now)?.rotten).toBe(true)
  })

  /** An outcome does not go stale: a won deal from last year is not a reproach. */
  it('never rots a closed stage', () => {
    expect(rottingState('won', ago(400 * DAY), now)).toBeNull()
    expect(rottingState('lost', ago(400 * DAY), now)).toBeNull()
  })

  it('answers null for a stage it does not know, rather than guessing a threshold', () => {
    expect(rottingState('negotiating', ago(30 * DAY), now)).toBeNull()
    expect(rottingState('', ago(30 * DAY), now)).toBeNull()
    // Not an own key, so not a stage — `toString` must not read as one.
    expect(rottingState('toString', ago(30 * DAY), now)).toBeNull()
    expect(rottingState('constructor', ago(30 * DAY), now)).toBeNull()
  })

  it('reads a timestamp in the future as untouched today, not a negative age', () => {
    expect(rottingState('new', new Date(now.getTime() + 3 * DAY), now)).toEqual({ days: 0, rotten: false, threshold: 7 })
  })

  it('answers null for a date that is not one', () => {
    expect(rottingState('new', new Date('not a date'), now)).toBeNull()
  })
})

describe('untouchedLabel', () => {
  /** "in stage for" would be a claim the column cannot support. */
  it('says untouched, never in stage', () => {
    expect(untouchedLabel(12)).toBe('untouched for 12 days')
    expect(untouchedLabel(1)).toBe('untouched for 1 day')
    expect(untouchedLabel(12)).not.toMatch(/in stage/)
  })
})

describe('dealIsOverdue', () => {
  it('is past only after the moment, not at it', () => {
    expect(dealIsOverdue(ago(1), now)).toBe(true)
    expect(dealIsOverdue(now, now)).toBe(false)
    expect(dealIsOverdue(new Date(now.getTime() + DAY), now)).toBe(false)
  })

  /** "Nobody set one" and "it is late" are different facts. */
  it('never calls a deal with no due date overdue', () => {
    expect(dealIsOverdue(null, now)).toBe(false)
    expect(dealIsOverdue(undefined, now)).toBe(false)
    expect(dealIsOverdue(new Date('nope'), now)).toBe(false)
  })
})
