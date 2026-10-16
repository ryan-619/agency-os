/** The night shift's morning list (`src/night.ts`). */
import { describe, expect, it } from 'vitest'
import { nightRank, nightScore } from '../src/index.js'

describe('the morning list', () => {
  it('puts what a business needs first, then whether it can be called and is established', () => {
    expect(nightScore({ needs: 2, hasPhone: true, rating: 4.5, reviews: 120 })).toBeCloseTo(6 + 2 + 1 + 1.2)
    // Reviews count up to 300: a famous chain does not outrank a clinic with needs.
    expect(nightScore({ needs: 0, hasPhone: true, rating: 4.9, reviews: 50_000 })).toBe(6)
    expect(nightScore({ needs: 2, hasPhone: false, rating: null, reviews: null })).toBe(6)
  })

  it('ranks best first, leaves out a business with nothing it needs, and keeps the order of a tie', () => {
    const a = { id: 'a', needs: 1, hasPhone: false, rating: null, reviews: null }
    const b = { id: 'b', needs: 3, hasPhone: true, rating: 4.2, reviews: 10 }
    const c = { id: 'c', needs: 0, hasPhone: true, rating: 5, reviews: 300 }
    const d = { id: 'd', needs: 1, hasPhone: false, rating: null, reviews: null }
    expect(nightRank([a, b, c, d], 10).map((x) => x.id)).toEqual(['b', 'a', 'd'])
    expect(nightRank([a, b, c, d], 1).map((x) => x.id)).toEqual(['b'])
  })
})
