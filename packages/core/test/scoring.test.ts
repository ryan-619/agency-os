import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  scoreCompany, rank, roundHalfToEven, parseIcpDefinition,
  type IcpDefinition, type Observation, type SiteProfile,
} from '../src/index.js'

/**
 * The same cases the Python engine asserts in tests/test_logic.py, so the two
 * suites agree about the rules and not just about the sixteen seed domains.
 */
const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(new URL('../../db/seed/icp-security-gap-saas.json', import.meta.url), 'utf8')),
)

/** Everything observed, nothing a gap; then override. */
function profile(over: Partial<SiteProfile> & { gaps?: string[]; unobserved?: string[] } = {}): SiteProfile {
  const { gaps = [], unobserved = [], ...rest } = over
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: false, detail: '' }
  }
  for (const key of gaps) observations[key] = { observed: true, gap: true, detail: '' }
  for (const key of unobserved) observations[key] = { observed: false, gap: null, detail: '' }
  return {
    domain: 'test.com', company: 'Test', title: 'Test',
    fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false,
    outdatedLibs: [], observations, ...rest,
  }
}

describe('roundHalfToEven', () => {
  // Python's round() is banker's rounding; JS Math.round is half-up. One point
  // straddles the qualifying threshold, so the difference decides who gets an
  // email.
  it('rounds a half to the EVEN neighbour, as Python does', () => {
    expect(roundHalfToEven(42.5)).toBe(42)   // Math.round would give 43
    expect(roundHalfToEven(37.5)).toBe(38)
    expect(roundHalfToEven(0.5)).toBe(0)
    expect(roundHalfToEven(1.5)).toBe(2)
    expect(roundHalfToEven(2.5)).toBe(2)
  })

  it('rounds everything else normally', () => {
    expect(roundHalfToEven(41.666)).toBe(42)
    expect(roundHalfToEven(42.4)).toBe(42)
    expect(roundHalfToEven(0)).toBe(0)
    expect(roundHalfToEven(100)).toBe(100)
  })
})

describe('disqualifiers fire before any scoring', () => {
  it('disqualifies an unreachable site, naming the error', () => {
    const r = scoreCompany(profile({ fetchOk: false, fetchError: 'timeout' }), icp)
    expect(r.disqualified).toBe('unreachable (timeout)')
    expect(r.score).toBe(0)
    expect(r.gaps).toEqual([])
  })

  it('names a reason even when the error is empty', () => {
    expect(scoreCompany(profile({ fetchOk: false, fetchError: '' }), icp).disqualified)
      .toBe('unreachable (no response)')
  })

  it('disqualifies a security vendor — the pitch is insulting', () => {
    expect(scoreCompany(profile({ isSecurityVendor: true }), icp).disqualified).toContain('insulting')
  })

  it('disqualifies a company that already has security in-house', () => {
    expect(scoreCompany(profile({ mentionsSecurityHiring: true }), icp).disqualified).toContain('displacing')
  })

  it('disqualifies a site with nothing web-facing to assess', () => {
    expect(scoreCompany(profile({ hasLoginSurface: false }), icp).disqualified).toContain('web-facing')
  })

  it('checks unreachable FIRST — nothing was observed, so nothing can be claimed', () => {
    const r = scoreCompany(profile({ fetchOk: false, fetchError: 'timeout', isSecurityVendor: true }), icp)
    expect(r.disqualified).toBe('unreachable (timeout)')
  })
})

describe('scoring', () => {
  it('scores 0 when nothing is a gap', () => {
    const r = scoreCompany(profile(), icp)
    expect(r.score).toBe(0)
    expect(r.qualified).toBe(false)
  })

  it('scores 100 when everything is a gap, landing in tier A', () => {
    const r = scoreCompany(profile({ gaps: Object.keys(icp.signals) }), icp)
    expect(r.score).toBe(100)
    expect(r.tier.startsWith('A')).toBe(true)
  })

  // The Python suite's own arithmetic: 15+14+12+12 = 53 of 108 -> 49.
  it('normalises over the observed weights', () => {
    const r = scoreCompany(profile({ gaps: ['csp', 'trust_page', 'compliance_claim', 'security_txt'] }), icp)
    expect(r.score).toBe(49)
    expect(r.qualified).toBe(true)
    expect(r.tier.startsWith('C')).toBe(true)
  })

  // §2.2 — the rule the product's credibility rests on.
  it('excludes an unobserved signal from BOTH sides of the ratio', () => {
    // csp alone is 15 of 108 -> 14. With tls (weight 8) unobserved the
    // denominator drops to 100, so the same gap is worth 15.
    expect(scoreCompany(profile({ gaps: ['csp'] }), icp).score).toBe(14)
    const r = scoreCompany(profile({ gaps: ['csp'], unobserved: ['tls'] }), icp)
    expect(r.score).toBe(15)
    expect(r.gaps.some((g) => g.key === 'tls')).toBe(false)
    expect(r.strengths.some((s) => s.key === 'tls')).toBe(false)
  })

  it('scores 0 rather than dividing by zero when nothing was observed', () => {
    expect(scoreCompany(profile({ unobserved: Object.keys(icp.signals) }), icp).score).toBe(0)
  })

  it('orders gaps by descending weight, with ICP order as the tie-break', () => {
    const r = scoreCompany(profile({ gaps: Object.keys(icp.signals) }), icp)
    const weights = r.gaps.map((g) => g.weight)
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
    // compliance_claim and security_txt both weigh 12; ICP order decides.
    const twelves = r.gaps.filter((g) => g.weight === 12).map((g) => g.key)
    expect(twelves).toEqual(['compliance_claim', 'security_txt'])
  })

  it('caps evidence at six lines', () => {
    expect(scoreCompany(profile({ gaps: Object.keys(icp.signals) }), icp).evidence).toHaveLength(6)
  })
})

describe('the headline finding prefers the demonstrable', () => {
  it('leads with a library you can point at, over an absent header', () => {
    const r = scoreCompany(profile({
      gaps: ['csp', 'outdated_js'],
      outdatedLibs: [{ lib: 'jquery', version: '3.4.1', note: 'known XSS advisories' }],
    }), icp)
    expect(r.headlineFinding.startsWith('jquery 3.4.1')).toBe(true)
  })

  it('falls back to a header finding when nothing concrete is present', () => {
    const r = scoreCompany(profile({ gaps: ['csp'] }), icp)
    expect(r.headlineFinding).toBe(icp.signals.csp!.why)
  })

  it('falls back to a structural finding when there is no header gap', () => {
    const r = scoreCompany(profile({ gaps: ['trust_page'] }), icp)
    expect(r.headlineFinding).toBe(icp.signals.trust_page!.why)
  })

  it('says nothing when there is nothing to say', () => {
    expect(scoreCompany(profile(), icp).headlineFinding).toBe('')
  })
})

describe('the angle', () => {
  it('sells questionnaire readiness when there is no trust page and no SOC 2', () => {
    expect(scoreCompany(profile({ gaps: ['trust_page', 'compliance_claim'] }), icp).angle)
      .toContain('questionnaire-readiness')
  })

  it('sells the pipeline when they are mid-journey', () => {
    expect(scoreCompany(profile({ gaps: ['compliance_claim'] }), icp).angle).toContain('mid-journey')
  })

  it('sells a hardening engagement when several baseline headers are missing', () => {
    expect(scoreCompany(profile({ gaps: ['csp', 'hsts', 'frame_protection'] }), icp).angle)
      .toContain('hardening engagement')
  })
})

describe('rank', () => {
  it('puts qualified first, then highest score, then domain', () => {
    const ranked = rank([
      scoreCompany(profile({ domain: 'low', gaps: ['csp'] }), icp),
      scoreCompany(profile({ domain: 'high', gaps: Object.keys(icp.signals) }), icp),
      scoreCompany(profile({ domain: 'dq', isSecurityVendor: true }), icp),
    ])
    expect(ranked[0]!.score).toBe(100)
    expect(ranked.at(-1)!.disqualified).not.toBe('')
  })
})

describe('parseIcpDefinition', () => {
  it('accepts the seeded profile', () => {
    expect(icp.label).toBe('Security-gap SaaS (US/EU)')
    expect(Object.keys(icp.signals)).toHaveLength(12)
  })

  // Zero as well as negatives since the informational signals: a weight-0
  // signal would be stamped `scored` while counting for nothing (icp.test.ts).
  it('rejects a definition with a negative or zero weight', () => {
    expect(() => parseIcpDefinition({ ...icp, signals: { csp: { weight: -1, why: 'x' } } }))
      .toThrow(/must be a positive number/)
    expect(() => parseIcpDefinition({ ...icp, signals: { csp: { weight: 0, why: 'x' } } }))
      .toThrow(/must be a positive number/)
  })

  it('rejects tiers that are not ordered highest floor first', () => {
    // The tier walk returns the first match, so a mis-ordered list would give
    // every qualifying company the lowest tier.
    expect(() => parseIcpDefinition({
      ...icp,
      scoring: { qualify_at: 45, tiers: [{ name: 'C', floor: 45 }, { name: 'A', floor: 70 }] },
    })).toThrow(/highest floor first/)
  })

  it('rejects a non-object', () => {
    expect(() => parseIcpDefinition(null)).toThrow(/not an object/)
  })
})
