/**
 * Markets and size (0021): a country read as one code, a profile's targeting,
 * the firmographic disqualifiers scoring applies, and a new profile derived
 * from an existing one.
 *
 * The rule throughout is §2.2's, restated for research: what was not
 * established is not claimed. An unknown headcount or a country that cannot be
 * read is never a mismatch.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPANY_STAGES, countryCode, countryName, deriveIcp, firmographicDisqualifier, icpSlug, icpTargeting,
  parseIcpDefinition, scoreCompany, type IcpDefinition, type SiteProfile,
} from '../src/index.js'
import seed from '../../db/seed/icp-security-gap-saas.json' with { type: 'json' }

const SEED: IcpDefinition = parseIcpDefinition(seed)

/** A reachable SaaS with a login and two observed gaps. */
function profile(over: Partial<SiteProfile> = {}): SiteProfile {
  return {
    domain: 'acme.in',
    company: 'Acme',
    fetchOk: true,
    hasLoginSurface: true,
    isSecurityVendor: false,
    mentionsSecurityHiring: false,
    outdatedLibs: [],
    observations: {
      csp: { observed: true, gap: true, detail: 'header absent on homepage response' },
      hsts: { observed: true, gap: true, detail: 'header absent on homepage response' },
      tls: { observed: true, gap: false, detail: 'TLS 1.3' },
    },
    ...over,
  }
}

describe('countryCode', () => {
  it('reads codes, English names and the common aliases as one ISO code', () => {
    expect(countryCode('IN')).toBe('IN')
    expect(countryCode('in')).toBe('IN')
    expect(countryCode('India')).toBe('IN')
    expect(countryCode('  india ')).toBe('IN')
    expect(countryCode('Bharat')).toBe('IN')
    expect(countryCode('UK')).toBe('GB')
    expect(countryCode('United Kingdom')).toBe('GB')
    expect(countryCode('England')).toBe('GB')
    expect(countryCode('USA')).toBe('US')
    expect(countryCode('U.S.A.')).toBe('US')
    expect(countryCode('United States')).toBe('US')
    expect(countryCode('UAE')).toBe('AE')
    expect(countryCode('The Netherlands')).toBe('NL')
    expect(countryCode('Türkiye')).toBe('TR')
    expect(countryCode('Turkey')).toBe('TR')
    expect(countryCode("Côte d'Ivoire")).toBe('CI')
    expect(countryCode('Hong Kong')).toBe('HK')
  })

  it('never guesses: an unknown name, a non-country region and blank text are null', () => {
    for (const bad of ['Atlantis', 'Europe', 'EU', 'UN', 'ZZ', 'XX', '', '   ', null, undefined]) {
      expect(countryCode(bad as string | null | undefined), String(bad)).toBeNull()
    }
  })

  it('names a code in English for sentences', () => {
    expect(countryName('IN')).toBe('India')
    expect(countryName('GB')).toBe('United Kingdom')
  })
})

describe('icpTargeting', () => {
  it('reads the seed’s markets with UK as GB, its headcount band and its stages', () => {
    const t = icpTargeting(SEED)
    expect(t.geos).toContain('GB')
    expect(t.geos).not.toContain('UK')
    expect(t.geos).toContain('US')
    expect(t.headcountMin).toBe(15)
    expect(t.headcountMax).toBe(400)
    expect(t.stages).toEqual(['seed', 'series-a', 'series-b', 'bootstrapped-profitable'])
  })

  it('reads a profile with no firmographics as every market and any size', () => {
    const bare = { ...SEED, firmographics: undefined }
    expect(icpTargeting(bare)).toEqual({ geos: [], headcountMin: null, headcountMax: null, stages: [] })
  })
})

describe('firmographicDisqualifier and scoreCompany', () => {
  it('disqualifies a recorded headcount over the maximum as enterprise_scale, quoting the recorded number', () => {
    const d = firmographicDisqualifier(SEED, { headcount: 2400 })
    expect(d?.key).toBe('enterprise_scale')
    expect(d?.reason).toMatch(/headcount on record: 2,400/)
    const scored = scoreCompany(profile(), SEED, { headcount: 2400, country: 'US' })
    expect(scored.qualified).toBe(false)
    expect(scored.score).toBe(0)
    expect(scored.disqualified).toMatch(/^Over ~400 staff/)
  })

  it('never disqualifies on what is not recorded', () => {
    expect(firmographicDisqualifier(SEED, {})).toBeNull()
    expect(firmographicDisqualifier(SEED, { headcount: null, country: null })).toBeNull()
    expect(firmographicDisqualifier(SEED, undefined)).toBeNull()
    // The seed names no outside_geos, so a country outside its markets is not held against anybody.
    expect(firmographicDisqualifier(SEED, { country: 'India', headcount: 50 })).toBeNull()
  })

  it('scores exactly as before when nothing is recorded — the parity path', () => {
    expect(scoreCompany(profile(), SEED)).toEqual(scoreCompany(profile(), SEED, {}))
  })

  it('keeps unreachable first: a site nobody reached is unreachable, whatever its headcount', () => {
    const r = scoreCompany(profile({ fetchOk: false, fetchError: 'timeout' }), SEED, { headcount: 9000 })
    expect(r.disqualified).toBe('unreachable (timeout)')
  })

  it('applies too_small and outside_geos only where a profile names them', () => {
    const derived = deriveIcp(SEED, {
      label: 'Security-gap SaaS (India)',
      geos: ['India'],
      headcount: { min: 10, max: 500 },
      disqualifyOutsideGeos: true,
      disqualifyTooSmall: true,
    })
    if (!derived.ok) throw new Error(derived.message)
    const india = derived.definition
    expect(firmographicDisqualifier(india, { headcount: 4 })?.key).toBe('too_small')
    expect(firmographicDisqualifier(india, { country: 'United States', headcount: 50 })).toMatchObject({
      key: 'outside_geos',
      reason: expect.stringMatching(/country on record: United States/),
    })
    expect(firmographicDisqualifier(india, { country: 'IN', headcount: 120 })).toBeNull()
    // A country nobody can read is not outside anything.
    expect(firmographicDisqualifier(india, { country: 'Atlantis', headcount: 120 })).toBeNull()
  })
})

describe('deriveIcp', () => {
  it('derives an India profile for small and mid-size companies, keeping the base’s signals', () => {
    const r = deriveIcp(SEED, {
      label: 'Security-gap SaaS (India, 10–500 staff)',
      geos: ['India'],
      headcount: { min: 10, max: 500 },
      stages: ['seed', 'series-a', 'series-b', 'bootstrapped'],
    })
    if (!r.ok) throw new Error(r.message)
    const d = r.definition
    expect(d.label).toBe('Security-gap SaaS (India, 10–500 staff)')
    expect(d.id).toBe(icpSlug(d.label))
    expect(icpTargeting(d)).toMatchObject({ geos: ['IN'], headcountMin: 10, headcountMax: 500 })
    expect(Object.keys(d.signals).sort()).toEqual(Object.keys(SEED.signals).sort())
    expect(d.scoring).toEqual(SEED.scoring)
    // The maximum moved, so its disqualifier says the new number.
    expect(d.disqualifiers.enterprise_scale).toMatch(/^Over ~500 staff/)
    // The base is untouched.
    expect(icpTargeting(SEED).headcountMax).toBe(400)
  })

  it('takes new weights for signals the base scores, and nothing else', () => {
    const r = deriveIcp(SEED, { label: 'Compliance-led', weights: { compliance_claim: 20 } })
    expect(r.ok && r.definition.signals.compliance_claim?.weight).toBe(20)
    expect(deriveIcp(SEED, { label: 'X profile', weights: { made_up: 5 } })).toMatchObject({ ok: false })
    expect(deriveIcp(SEED, { label: 'X profile', weights: { csp: 0 } })).toMatchObject({ ok: false })
    expect(deriveIcp(SEED, { label: 'X profile', weights: { csp: 51 } })).toMatchObject({ ok: false })
  })

  it('refuses a weight named after an object’s own machinery, and touches no prototype', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const r = deriveIcp(SEED, { label: 'X profile', weights: Object.fromEntries([[key, 5]]) })
      expect(r.ok, key).toBe(false)
      if (!r.ok) expect(r.message).toMatch(/is not a signal this profile scores/)
    }
    expect(({} as { weight?: unknown }).weight).toBeUndefined()
    expect((Object as unknown as { weight?: unknown }).weight).toBeUndefined()
  })

  it('refuses, with a sentence, what it cannot store', () => {
    const refusals: [Parameters<typeof deriveIcp>[1], RegExp][] = [
      [{ label: 'ab' }, /3 to 80 characters/],
      [{ label: 'India', geos: ['Atlantis'] }, /not a country/],
      [{ label: 'India', headcount: { min: 500, max: 10 } }, /above the maximum/],
      [{ label: 'India', headcount: { min: 0 } }, /whole number of people/],
      [{ label: 'India', stages: ['unicorn'] }, /not a stage/],
      [{ label: 'India', headcount: { min: null }, disqualifyTooSmall: true }, /headcount minimum/],
      [{ label: 'India', geos: [], disqualifyOutsideGeos: true }, /markets/],
    ]
    for (const [changes, why] of refusals) {
      const r = deriveIcp(SEED, changes)
      expect(r.ok, JSON.stringify(changes)).toBe(false)
      if (!r.ok) expect(r.message).toMatch(why)
    }
  })

  it('lists the stages a company and a profile may name', () => {
    for (const s of ['seed', 'series-a', 'series-b', 'bootstrapped-profitable']) {
      expect((COMPANY_STAGES as readonly string[]).includes(s), s).toBe(true)
    }
  })
})
