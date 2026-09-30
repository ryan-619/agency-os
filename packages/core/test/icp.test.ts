/**
 * parseIcpDefinition at the database boundary — the rules that decide what an
 * ICP row may hold.
 *
 * The one this file exists for: `weight: 0` is refused. A signal in the ICP
 * is stamped `scored` by recordScan, so a zero-weight one would be a row that
 * reads as counting while counting for nothing. A signal the agency wants
 * observed and not scored is an entry in the informational catalogue, and
 * promoting it means giving it a real weight.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { orderedSignals, parseIcpDefinition } from '../src/index.js'

const seed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../db/seed/icp-security-gap-saas.json', import.meta.url)), 'utf8'),
) as { signals: Record<string, { weight: number; why: string; order?: number }> } & Record<string, unknown>

function withSignal(key: string, signal: unknown) {
  return { ...seed, signals: { ...seed.signals, [key]: signal } }
}

describe('parseIcpDefinition', () => {
  it('accepts the seeded profile as it is', () => {
    const icp = parseIcpDefinition(seed)
    expect(orderedSignals(icp)).toHaveLength(12)
  })

  it('refuses weight 0, and says where such a signal belongs instead', () => {
    expect(() => parseIcpDefinition(withSignal('csp_quality', { weight: 0, why: 'x', order: 13 })))
      .toThrow(
        'signals.csp_quality.weight must be a positive number — an informational signal is a catalogue entry, not a zero in the ICP',
      )
  })

  it('refuses a negative weight with the same sentence', () => {
    expect(() => parseIcpDefinition(withSignal('csp', { weight: -3, why: 'x', order: 1 })))
      .toThrow(/signals\.csp\.weight must be a positive number/)
  })

  it('refuses a weight that is not a finite number', () => {
    for (const weight of [Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      expect(() => parseIcpDefinition(withSignal('csp', { weight, why: 'x', order: 1 })), String(weight))
        .toThrow(/weight must be a positive number/)
    }
  })

  it('accepts a promoted signal once it carries a real weight', () => {
    const icp = parseIcpDefinition(withSignal('hsts_quality', { weight: 2, why: 'HSTS max-age under 180 days', order: 13 }))
    expect(orderedSignals(icp).at(-1)).toEqual(['hsts_quality', { weight: 2, why: 'HSTS max-age under 180 days', order: 13 }])
  })
})
