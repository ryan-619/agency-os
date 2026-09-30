/**
 * The pipeline's numbers. The properties that matter are the honest ones:
 * below the minimum sample a figure is null rather than a small number, a
 * figure always comes with its denominator, an open deal is neither won nor
 * lost, a stay is measured only when both of its ends were recorded, and the
 * answer does not depend on the order the rows arrived in.
 */
import { describe, it, expect } from 'vitest'
import {
  ANALYTICS_NOTE, pipelineMetrics, type DealFact, type Transition,
} from '../src/analytics.js'

const DAY = 86_400_000
const t0 = new Date('2026-06-01T09:00:00.000Z')
const at = (days: number): Date => new Date(t0.getTime() + days * DAY)
const now = at(120)

const deal = (id: string, stage: string, created: number, closed: number | null = null): DealFact => ({
  id, stage, createdAt: at(created), closedAt: closed === null ? null : at(closed), updatedAt: null,
})
const move = (dealId: string, from: string | null, to: string, day: number): Transition => ({
  dealId, from, to, at: at(day),
})

const row = <T extends { stage?: string; from?: string }>(list: readonly T[], key: string): T =>
  list.find((r) => (r.stage ?? r.from) === key)!

describe('pipelineMetrics', () => {
  it('counts deals per stage from the table, separating open from closed', () => {
    const m = pipelineMetrics(
      [deal('a', 'new', 0), deal('b', 'new', 0), deal('c', 'won', 0, 10), deal('d', 'lost', 0, 12)],
      [],
      now,
    )
    expect(m.perStage.map((s) => s.stage)).toEqual(['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'])
    expect(row(m.perStage, 'new')).toEqual({ stage: 'new', open: 2, total: 2 })
    expect(row(m.perStage, 'won')).toEqual({ stage: 'won', open: 0, total: 1 })
    expect(row(m.perStage, 'lost')).toEqual({ stage: 'lost', open: 0, total: 1 })
  })

  /** "One of one" is a 100% rate and means nothing. */
  it('answers null below the minimum sample, and still gives the counts', () => {
    const deals = [
      deal('a', 'won', 0, 20), deal('b', 'won', 0, 30), deal('c', 'lost', 0, 5), deal('d', 'lost', 0, 6),
    ]
    const m = pipelineMetrics(deals, [], now)
    expect(m.minSample).toBe(5)
    expect(m.winRate).toEqual({ won: 2, closed: 4, rate: null })
    expect(m.velocityDays).toBeNull()
    expect(m.velocitySample).toBe(2)

    const five = pipelineMetrics([...deals, deal('e', 'won', 0, 40)], [], now)
    expect(five.winRate).toEqual({ won: 3, closed: 5, rate: 3 / 5 })
  })

  /** An open deal has been neither won nor lost; counting it would make every rate a guess. */
  it('computes the win rate from closed deals only', () => {
    const closed = [
      deal('a', 'won', 0, 10), deal('b', 'won', 0, 10), deal('c', 'lost', 0, 10),
      deal('d', 'lost', 0, 10), deal('e', 'lost', 0, 10),
    ]
    const open = [deal('f', 'proposal', 0), deal('g', 'meeting', 0), deal('h', 'new', 0)]
    const m = pipelineMetrics([...closed, ...open], [], now)
    expect(m.winRate).toEqual({ won: 2, closed: 5, rate: 0.4 })
    // A `won` stage with no closed_at is not a close anybody recorded.
    const odd = pipelineMetrics([...closed, deal('x', 'won', 0)], [], now)
    expect(odd.winRate.closed).toBe(5)
  })

  it('takes the median of an even count as the mean of the middle two', () => {
    const won = [4, 10, 2, 8, 6, 12].map((d, i) => deal(`w${i}`, 'won', 0, d))
    const m = pipelineMetrics(won, [], now)
    expect(m.velocitySample).toBe(6)
    // sorted 2 4 6 8 10 12 → (6 + 8) / 2
    expect(m.velocityDays).toBe(7)

    const odd = pipelineMetrics(won.slice(0, 5), [], now)
    // 2 4 6 8 10 → 6
    expect(odd.velocityDays).toBe(6)
  })

  it('measures a stay only when its arrival and departure were both recorded', () => {
    const transitions: Transition[] = []
    for (let i = 0; i < 5; i++) {
      transitions.push(move(`d${i}`, null, 'contacted', 0))
      transitions.push(move(`d${i}`, 'contacted', 'replied', 2 + i)) // stays of 2,3,4,5,6 days
    }
    // A departure that does not name the stage the arrival reached: a move
    // in between went unrecorded, so this is not a sample for `replied`.
    transitions.push(move('gap', null, 'replied', 0))
    transitions.push(move('gap', 'meeting', 'proposal', 50))
    const m = pipelineMetrics([], transitions, now)
    expect(row(m.medianDaysInStage, 'contacted')).toEqual({ stage: 'contacted', days: 4, sample: 5 })
    // Five deals are still in `replied` with no departure — not stays anybody measured.
    expect(row(m.medianDaysInStage, 'replied')).toEqual({ stage: 'replied', days: null, sample: 0 })
  })

  it('counts entered and advanced per stage, a skip counting as advancing', () => {
    const deals = [
      deal('a', 'replied', 0), // new → contacted → replied, still there
      deal('b', 'lost', 0, 9), // new → contacted → lost
      deal('c', 'meeting', 0), // booked straight into meeting from new
      deal('d', 'new', 0), // never moved
    ]
    const transitions = [
      move('a', null, 'new', 0), move('a', 'new', 'contacted', 1), move('a', 'contacted', 'replied', 2),
      move('b', null, 'new', 0), move('b', 'new', 'contacted', 1), move('b', 'contacted', 'lost', 9),
      move('c', null, 'new', 0), move('c', 'new', 'meeting', 3),
    ]
    const m = pipelineMetrics(deals, transitions, now, { minSample: 1 })
    expect(row(m.conversion, 'new')).toEqual({ from: 'new', to: 'contacted', entered: 4, advanced: 3, rate: 0.75 })
    expect(row(m.conversion, 'contacted')).toEqual({ from: 'contacted', to: 'replied', entered: 2, advanced: 1, rate: 0.5 })
    expect(row(m.conversion, 'replied')).toEqual({ from: 'replied', to: 'meeting', entered: 1, advanced: 0, rate: 0 })
    expect(row(m.conversion, 'proposal')).toEqual({ from: 'proposal', to: 'won', entered: 0, advanced: 0, rate: null })
  })

  it('knows a deal by where it is now when no move of it was recorded', () => {
    // A proposal accepted as won is not a recorded move, but the deal's row
    // says `won`, so the proposal it left from counts as advanced.
    const m = pipelineMetrics(
      [deal('a', 'won', 0, 30)],
      [move('a', 'meeting', 'proposal', 20)],
      now,
      { minSample: 1 },
    )
    expect(row(m.conversion, 'proposal')).toMatchObject({ entered: 1, advanced: 1 })
    expect(row(m.conversion, 'meeting')).toMatchObject({ entered: 1, advanced: 1 })
  })

  it('ignores a move to the stage it came from, and a stage it does not know', () => {
    const m = pipelineMetrics(
      [],
      [move('a', 'new', 'new', 1), move('b', null, 'negotiating', 1), move('c', 'toString', 'new', 1)],
      now,
      { minSample: 1 },
    )
    expect(m.conversion.every((c) => c.entered === 0)).toBe(true)
  })

  it('gives the same answer whatever order the rows arrive in', () => {
    const deals = [deal('a', 'meeting', 0), deal('b', 'won', 0, 40), deal('c', 'lost', 0, 20)]
    const transitions = [
      move('a', null, 'new', 0), move('a', 'new', 'contacted', 2), move('a', 'contacted', 'meeting', 5),
      move('b', null, 'contacted', 1), move('b', 'contacted', 'replied', 4), move('b', 'replied', 'proposal', 9),
      move('c', null, 'new', 0), move('c', 'new', 'lost', 20),
      // Two moves of one deal stamped in the same millisecond.
      move('d', null, 'new', 7), move('d', 'new', 'contacted', 7),
    ]
    const forward = pipelineMetrics(deals, transitions, now, { minSample: 1 })
    const reversed = pipelineMetrics([...deals].reverse(), [...transitions].reverse(), now, { minSample: 1 })
    expect(reversed).toEqual(forward)
    expect(row(forward.medianDaysInStage, 'new')).toMatchObject({ sample: 3 })
  })

  it('carries its note and the moment it describes', () => {
    const m = pipelineMetrics([], [], now)
    expect(m.note).toBe(ANALYTICS_NOTE)
    expect(m.note).toMatch(/lower bounds/)
    expect(m.asOf).toEqual(now)
  })

  it('refuses a nonsense minimum rather than reporting every figure', () => {
    expect(pipelineMetrics([], [], now, { minSample: 0 }).minSample).toBe(5)
    expect(pipelineMetrics([], [], now, { minSample: Number.NaN }).minSample).toBe(5)
  })
})
