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
  INFORMATIONAL_SIGNALS, informationalSection, informationalStatus, isInformationalSignal, parseIcpDefinition,
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

/**
 * The company page's section, decided with a fixed clock. Nothing quotes
 * these rows, but they are statements about somebody's site: one read off a
 * scan that aged out is shown as aged out, from the scan's `ran_at` — the
 * same rule as the scored table above it, not the `findings.stale` cache.
 */
describe('informationalSection', () => {
  const RAN = new Date('2026-09-01T08:00:00.000Z')
  const findings = [
    { signalKey: 'reporting_endpoints', observed: true, gap: false, detail: 'NEL sent', evidence: { url: 'u', nel: 'x' } },
    { signalKey: 'cookie_flags', observed: false, gap: null, detail: 'not captured', evidence: { url: 'u', reason: 'r' } },
    { signalKey: 'hsts_quality', observed: true, gap: true, detail: 'max-age=3600 is under 180 days', evidence: { url: 'u', maxAge: 3600 } },
    { signalKey: 'csp_quality', observed: true, gap: false, detail: 'not applicable — no enforced Content-Security-Policy to judge', evidence: { url: 'u' } },
    { signalKey: 'csp_report_only', observed: true, gap: true, detail: 'report-only policy with no enforced policy', evidence: { url: 'u' } },
  ]

  it('is fresh inside the threshold and stale past it, measured from the scan', () => {
    const fresh = informationalSection({ scan: { ranAt: RAN }, findings, staleAfterDays: 14, now: new Date('2026-09-10T08:00:00.000Z') })
    expect(fresh.stale).toBe(false)
    const aged = informationalSection({ scan: { ranAt: RAN }, findings, staleAfterDays: 14, now: new Date('2026-09-20T08:00:00.000Z') })
    expect(aged.stale).toBe(true)
  })

  it('puts what was flagged first, then the catalogue order, with the catalogue’s words', () => {
    const { rows } = informationalSection({ scan: { ranAt: RAN }, findings, staleAfterDays: 14, now: RAN })
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['csp_report_only', 'gap'],
      ['hsts_quality', 'gap'],
      ['reporting_endpoints', 'observed'],
      ['csp_quality', 'not applicable'],
      ['cookie_flags', 'not observed'],
    ])
    expect(rows[1]).toMatchObject({ label: 'HSTS max-age', evidence: { maxAge: 3600 } })
    expect(rows[1]!.why).toBe(INFORMATIONAL_SIGNALS.hsts_quality!.why)
  })

  it('shows a key the catalogue does not know by name rather than dropping it', () => {
    const { rows } = informationalSection({
      scan: { ranAt: RAN },
      findings: [{ signalKey: 'something_new', observed: true, gap: false, detail: 'x', evidence: null }],
      staleAfterDays: 14,
      now: RAN,
    })
    expect(rows).toEqual([{ key: 'something_new', label: 'something_new', why: null, status: 'observed', detail: 'x', evidence: {} }])
  })
})
