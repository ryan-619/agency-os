/**
 * The bundled CLI prices Sonnet 5.5 and Opus 5.5 at its fallback rate; the
 * worker re-prices them from their tokens (2026-10-15).
 */
import { describe, expect, it } from 'vitest'
import { correctedCostUsd, modelPrice } from '../src/model-prices.js'

const usage = (model: string, over: Record<string, unknown> = {}) => ({
  [model]: {
    inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    costUSD: 7.5, costBasis: 'unknown', ...over,
  },
})

describe('modelPrice', () => {
  it('lists the two chat models and ignores a context-window suffix and case', () => {
    expect(modelPrice('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 })
    expect(modelPrice('Claude-Opus-5-5[1m]')).toMatchObject({ input: 4, output: 20 })
  })

  it('knows nothing else, and nothing on the prototype', () => {
    expect(modelPrice('claude-haiku-4-5')).toBeNull()
    expect(modelPrice('sonnet')).toBeNull()
    expect(modelPrice('__proto__')).toBeNull()
    expect(modelPrice('constructor')).toBeNull()
  })
})

describe('correctedCostUsd', () => {
  it('re-prices an entry the CLI priced at its fallback', () => {
    // $5 × 1 + $25 × 0.1 = 7.5 at the fallback; $2 × 1 + $10 × 0.1 = 3 really.
    expect(correctedCostUsd(7.5, usage('claude-sonnet-5-5'))).toBeCloseTo(3, 10)
    expect(correctedCostUsd(7.5, usage('claude-opus-5-5'))).toBeCloseTo(6, 10)
  })

  it('counts cache reads and writes at their own prices', () => {
    const u = usage('claude-sonnet-5-5', {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, costUSD: 6.75,
    })
    expect(correctedCostUsd(6.75, u)).toBeCloseTo(0.2 + 2.5, 10)
  })

  it('leaves what else the total carries, and an entry the CLI priced from its list', () => {
    expect(correctedCostUsd(8, usage('claude-sonnet-5-5'))).toBeCloseTo(3.5, 10)
    expect(correctedCostUsd(7.5, usage('claude-sonnet-5-5', { costBasis: 'list' }))).toBe(7.5)
    expect(correctedCostUsd(7.5, usage('claude-haiku-4-5'))).toBe(7.5)
  })

  it('re-prices each listed model in a turn that used two', () => {
    const u = { ...usage('claude-sonnet-5-5'), ...usage('claude-opus-5-5') }
    expect(correctedCostUsd(15, u)).toBeCloseTo(9, 10)
  })

  it('leaves the total alone for a shape it cannot read, and never goes below zero', () => {
    expect(correctedCostUsd(0.4, undefined)).toBe(0.4)
    expect(correctedCostUsd(0.4, null)).toBe(0.4)
    expect(correctedCostUsd(0.4, [1, 2])).toBe(0.4)
    expect(correctedCostUsd(0.4, { 'claude-sonnet-5-5': 'x' })).toBe(0.4)
    expect(correctedCostUsd(Number.NaN, undefined)).toBe(0)
    expect(correctedCostUsd(0, usage('claude-sonnet-5-5', { costUSD: 99 }))).toBe(0)
  })
})
