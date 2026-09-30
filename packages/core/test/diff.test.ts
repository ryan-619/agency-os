/**
 * §2.2: "The app must never state a finding it did not observe."
 *
 * A diff states CHANGES, which is two findings' worth of claims at once, and
 * the dangerous one is `fixed`: a newer scan that could not see a signal looks
 * exactly like a newer scan that saw no gap, unless the diff reads `observed`
 * before it reads `gap`. Every test below that says "never" is about that.
 */
import { describe, it, expect } from 'vitest'
import { diffFindings, diffInputOf, type DiffInput, type SignalChange } from '../src/diff.js'

const gap = (signalKey: string, weight = 10, evidence: Record<string, unknown> = { header: signalKey, seen: 'absent' }): DiffInput =>
  ({ signalKey, observed: true, gap: true, detail: 'absent', evidence, weight })
const clear = (signalKey: string, evidence: Record<string, unknown> = { header: signalKey, seen: 'present' }): DiffInput =>
  ({ signalKey, observed: true, gap: false, detail: 'present', evidence, weight: 0 })
const unobserved = (signalKey: string, evidence: Record<string, unknown> = { outcome: 'timeout' }): DiffInput =>
  ({ signalKey, observed: false, gap: null, detail: 'timeout', evidence, weight: 0 })

/** The one row for `key`, and its change. */
function changeFor(older: DiffInput[], newer: DiffInput[], key: string): SignalChange {
  const row = diffFindings(older, newer).rows.find((r) => r.signalKey === key)
  expect(row, `a row for ${key}`).toBeDefined()
  return row!.change
}

describe('diffFindings — the state machine', () => {
  it('gap → clear, both observed, is fixed', () => {
    expect(changeFor([gap('csp')], [clear('csp')], 'csp')).toBe('fixed')
  })

  it('clear → gap, both observed, is regressed', () => {
    expect(changeFor([clear('hsts')], [gap('hsts')], 'hsts')).toBe('regressed')
  })

  it('observed → unobserved is not assessed this time', () => {
    expect(changeFor([gap('csp')], [unobserved('csp')], 'csp')).toBe('not_assessed_this_time')
    expect(changeFor([clear('csp')], [unobserved('csp')], 'csp')).toBe('not_assessed_this_time')
  })

  it('unobserved → observed is now observed, whichever way it came out', () => {
    expect(changeFor([unobserved('trust_page')], [gap('trust_page')], 'trust_page')).toBe('now_observed')
    expect(changeFor([unobserved('trust_page')], [clear('trust_page')], 'trust_page')).toBe('now_observed')
  })

  it('a key only in the newer scan is a new signal', () => {
    expect(changeFor([], [gap('security_txt')], 'security_txt')).toBe('new_signal')
    expect(changeFor([], [unobserved('security_txt')], 'security_txt')).toBe('new_signal')
    const row = diffFindings([], [gap('security_txt')]).rows[0]!
    expect(row.older).toBeNull()
  })

  it('the same observed answer twice is unchanged', () => {
    expect(changeFor([gap('csp')], [gap('csp')], 'csp')).toBe('unchanged')
    expect(changeFor([clear('csp')], [clear('csp')], 'csp')).toBe('unchanged')
  })

  // "Unchanged" is a comparison, and there is nothing to compare: neither
  // scan saw it. The newer scan did not assess it, and that is all that can
  // be said.
  it('unobserved twice is not assessed this time, not unchanged', () => {
    expect(changeFor([unobserved('tls')], [unobserved('tls')], 'tls')).toBe('not_assessed_this_time')
  })
})

describe('diffFindings — a blocked fetch is never a fix (§2.2)', () => {
  it('a gap the newer scan could not observe is never fixed, for any shape of the newer row', () => {
    const newerShapes: DiffInput[] = [
      unobserved('csp'),
      // The shape a careless reader would call "no gap": gap is null, not true.
      { signalKey: 'csp', observed: false, gap: null, detail: null, evidence: {}, weight: 0 },
      // Contradictory — the database cannot store it — and still not a fix.
      { signalKey: 'csp', observed: false, gap: false, detail: null, evidence: {}, weight: 0 },
      { signalKey: 'csp', observed: true, gap: null, detail: null, evidence: {}, weight: 0 },
    ]
    for (const n of newerShapes) {
      const change = changeFor([gap('csp', 20)], [n], 'csp')
      expect(change).not.toBe('fixed')
      expect(change).toBe('not_assessed_this_time')
    }
  })

  it('counts a blocked fetch as not assessed, never in the fixed total', () => {
    const { summary } = diffFindings(
      [gap('csp', 20), gap('hsts', 15), gap('tls', 10)],
      [unobserved('csp'), unobserved('hsts'), clear('tls')],
    )
    expect(summary).toEqual({ fixed: 1, regressed: 0, notAssessed: 2, nowObserved: 0 })
  })

  it('a signal that was unobserved and is now clear is not a fix either', () => {
    const { summary } = diffFindings([unobserved('csp')], [clear('csp')])
    expect(summary.fixed).toBe(0)
    expect(summary.nowObserved).toBe(1)
  })
})

describe('diffFindings — what a row carries', () => {
  it('carries BOTH evidence objects, untouched, so the claim can be checked', () => {
    const before = { header: 'content-security-policy', seen: 'absent', url: 'https://acme.test/' }
    const after = { header: 'content-security-policy', seen: "default-src 'self'", url: 'https://acme.test/' }
    const row = diffFindings([gap('csp', 20, before)], [clear('csp', after)]).rows[0]!
    expect(row.change).toBe('fixed')
    expect(row.older!.evidence).toEqual(before)
    expect(row.newer.evidence).toEqual(after)
    expect(row.older!.detail).toBe('absent')
    expect(row.newer.detail).toBe('present')
  })

  it('keeps each side\'s stamped weight, and orders by the larger of the two', () => {
    const row = diffFindings([gap('csp', 20)], [clear('csp')]).rows[0]!
    expect(row.older!.weight).toBe(20)
    expect(row.newer.weight).toBe(0)
    expect(row.weight).toBe(20)
  })

  it('takes `scored` from the newer row, defaulting to true', () => {
    const informational: DiffInput = { ...clear('cookie_flags'), scored: false }
    const rows = diffFindings([clear('cookie_flags'), gap('csp')], [informational, gap('csp')]).rows
    expect(rows.find((r) => r.signalKey === 'cookie_flags')!.scored).toBe(false)
    expect(rows.find((r) => r.signalKey === 'csp')!.scored).toBe(true)
  })

  // A signal the newer scan did not produce at all — the ICP or the scanner
  // changed between the two — has no newer observation. "Gone" or "fixed"
  // would be a statement nobody observed, so it is not a row.
  it('drops a key present only in the older scan', () => {
    const { rows, summary } = diffFindings([gap('csp', 20), gap('retired_signal', 30)], [gap('csp', 20)])
    expect(rows.map((r) => r.signalKey)).toEqual(['csp'])
    expect(summary).toEqual({ fixed: 0, regressed: 0, notAssessed: 0, nowObserved: 0 })
  })

  it('uses the first row for a repeated key rather than reporting it twice', () => {
    const rows = diffFindings([gap('csp', 20), clear('csp')], [clear('csp'), gap('csp', 20)]).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.change).toBe('fixed')
  })
})

describe('diffFindings — order', () => {
  const older = [gap('b_sig', 10), gap('a_sig', 10), clear('z_sig'), gap('heavy', 25), unobserved('m_sig')]
  const newer = [clear('b_sig'), gap('a_sig', 10), gap('z_sig', 5), unobserved('heavy'), clear('m_sig'), clear('new_one')]

  it('sorts by weight descending, then by signal key', () => {
    const keys = diffFindings(older, newer).rows.map((r) => [r.signalKey, r.weight])
    expect(keys).toEqual([
      ['heavy', 25],
      ['a_sig', 10],
      ['b_sig', 10],
      ['z_sig', 5],
      ['m_sig', 0],
      ['new_one', 0],
    ])
  })

  it('is deterministic: the input order does not change the output', () => {
    const forward = diffFindings(older, newer)
    const reversed = diffFindings([...older].reverse(), [...newer].reverse())
    expect(reversed).toEqual(forward)
  })

  it('does not depend on the locale for keys of equal weight', () => {
    // Code-unit order puts upper case before lower; a locale collation would not.
    const rows = diffFindings([], [clear('b'), clear('B'), clear('a')]).rows
    expect(rows.map((r) => r.signalKey)).toEqual(['B', 'a', 'b'])
  })
})

describe('diffInputOf', () => {
  const row = {
    signalKey: 'csp', observed: true, gap: true, detail: 'absent', weight: 20, scored: true,
    evidence: { header: 'content-security-policy', seen: 'absent' } as unknown,
  }

  it('passes a stored object through as the evidence', () => {
    expect(diffInputOf(row).evidence).toEqual({ header: 'content-security-policy', seen: 'absent' })
  })

  it('wraps a non-object rather than dropping what was stored', () => {
    expect(diffInputOf({ ...row, evidence: 'raw text' }).evidence).toEqual({ value: 'raw text' })
    expect(diffInputOf({ ...row, evidence: ['a'] }).evidence).toEqual({ value: ['a'] })
    expect(diffInputOf({ ...row, evidence: null }).evidence).toEqual({})
  })

  it('defaults `scored` to true when the row does not say', () => {
    const unsaid = { signalKey: 'csp', observed: false, gap: null, detail: null, weight: 0, evidence: {} }
    expect(diffInputOf(unsaid).scored).toBe(true)
    expect(diffInputOf({ ...row, scored: false }).scored).toBe(false)
  })
})
