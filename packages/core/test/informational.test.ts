/**
 * The informational catalogue (informational.ts) against the scanner's list.
 *
 * The two live in different packages because the scanner depends on core and
 * not the other way round, so this test is what holds them together: a key
 * the scanner emits with no catalogue row would reach the company page with
 * no label and no reason, and a catalogue row for a key the scanner never
 * emits is a label for nothing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  INFORMATIONAL_SIGNALS, informationalStatus, isInformationalSignal, parseIcpDefinition,
} from '../src/index.js'
// By path: core must not depend on the scanner, and only the test needs it.
import { ADDITIVE_SIGNAL_KEYS } from '../../scanner/src/additive.js'

const parityIcp = parseIcpDefinition(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../scanner/test/icp-parity.json', import.meta.url)), 'utf8')),
)
const seedIcp = parseIcpDefinition(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../db/seed/icp-security-gap-saas.json', import.meta.url)), 'utf8')),
)

describe('the informational catalogue', () => {
  it('has a row for exactly the keys the scanner emits', () => {
    expect(Object.keys(INFORMATIONAL_SIGNALS).sort()).toEqual([...ADDITIVE_SIGNAL_KEYS].sort())
    for (const key of ADDITIVE_SIGNAL_KEYS) {
      const row = INFORMATIONAL_SIGNALS[key]!
      expect(row.label.length, key).toBeGreaterThan(3)
      expect(row.why.length, key).toBeGreaterThan(20)
      expect(['header', 'html', 'cookie']).toContain(row.source)
    }
  })

  it('names nothing the ICP scores — in the frozen parity copy or the seed', () => {
    for (const key of ADDITIVE_SIGNAL_KEYS) {
      expect(Object.keys(parityIcp.signals), key).not.toContain(key)
      expect(Object.keys(seedIcp.signals), key).not.toContain(key)
      expect(isInformationalSignal(key)).toBe(true)
    }
    for (const key of Object.keys(seedIcp.signals)) expect(isInformationalSignal(key), key).toBe(false)
  })

  it('does not answer yes for an Object property', () => {
    expect(isInformationalSignal('constructor')).toBe(false)
    expect(isInformationalSignal('toString')).toBe(false)
  })

  /** UI copy rule: posture review from the outside, never a test. */
  it('never describes the review as a test or a probe', () => {
    const text = JSON.stringify(INFORMATIONAL_SIGNALS).toLowerCase()
    expect(text).not.toMatch(/\btest|probe|pentest|penetration/)
  })
})

describe('informationalStatus', () => {
  it('reads each shape the scanner produces', () => {
    expect(informationalStatus({ observed: false, gap: null, detail: 'not captured' })).toBe('not observed')
    expect(informationalStatus({ observed: true, gap: true, detail: 'max-age=3600 is under 180 days' })).toBe('gap')
    expect(informationalStatus({ observed: true, gap: false, detail: 'not applicable — no cookies set on the homepage' }))
      .toBe('not applicable')
    expect(informationalStatus({ observed: true, gap: false, detail: 'NEL sent' })).toBe('observed')
    expect(informationalStatus({ observed: true, gap: false, detail: null })).toBe('observed')
  })

  it('never calls a row "in place" — an informational signal is not a strength', () => {
    const all = [
      informationalStatus({ observed: true, gap: false, detail: 'nosniff' }),
      informationalStatus({ observed: true, gap: false, detail: 'not applicable — x' }),
    ]
    for (const s of all) expect(s).not.toMatch(/place|ok|pass|strength/i)
  })
})
