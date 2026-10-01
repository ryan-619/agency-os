import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { scoreCompany, parseIcpDefinition, type IcpDefinition } from '@agency/core'
import { ADDITIVE_SIGNAL_KEYS } from '../src/additive.js'
import { extractProfile } from '../src/extract.js'
import { fixtureNames, loadFixture, loadGoldens } from './fixtures.js'

/**
 * PROMPT.md §9, Phase 1 Definition of Done:
 *
 *   "importing the 16 seed domains from ~/Documents/lead-engine/seeds/ produces
 *    scored companies whose findings match what the Python engine produces for
 *    the same domains. Write that comparison as a test."
 *
 * This is that test. Both engines are fed the SAME recorded bytes
 * (packages/scanner/fixtures/*.json.gz), so any disagreement is a disagreement
 * between the engines rather than between two moments on the internet.
 *
 * Regenerate with:
 *   npm run fixtures:capture     re-record the sites (a deliberate act)
 *   npm run fixtures:golden      re-run the Python engine over the recordings
 */

/**
 * The ICP the goldens were computed against, FROZEN here rather than read
 * from the seed. The seed is editable product data: promoting an
 * informational signal into it (adding the key with a weight) is exactly how
 * one starts to count, and it would move every score below while the Python
 * goldens stayed where they were. This file is today's seed, verbatim; it
 * changes only when the goldens are regenerated against a new one.
 */
const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(new URL('./icp-parity.json', import.meta.url), 'utf8')),
)

const domains = fixtureNames()
const goldens = loadGoldens()

describe('the port agrees with the Python engine it came from', () => {
  it('has a fixture and a golden for all 16 seed domains', () => {
    expect(domains.length, 'run `npm run fixtures:capture`').toBe(16)
    expect(Object.keys(goldens).length, 'run `npm run fixtures:golden`').toBe(16)
    expect(Object.keys(goldens).sort()).toEqual(domains)
  })

  describe.each(domains)('%s', (domain) => {
    const fixture = loadFixture(domain)
    const golden = goldens[domain]!
    const profile = extractProfile(fixture, fixture.company)
    const result = scoreCompany(profile, icp)

    it('agrees on whether the site was reachable and what it is', () => {
      expect(profile.fetchOk).toBe(golden.profile.fetch_ok)
      expect(profile.title).toBe(golden.profile.title)
      expect(profile.hasLoginSurface).toBe(golden.profile.has_login_surface)
      expect(profile.isSecurityVendor).toBe(golden.profile.is_security_vendor)
      expect(profile.mentionsSecurityHiring).toBe(golden.profile.mentions_security_hiring)
    })

    it('agrees on every signal: observed, gap and detail', () => {
      const mine = Object.fromEntries(
        Object.entries(profile.observations).map(([k, o]) => [k, { observed: o.observed, gap: o.gap, detail: o.detail }]),
      )
      const theirs = Object.fromEntries(
        Object.entries(golden.profile.observations).map(([k, o]) => [k, { observed: o.observed, gap: o.gap, detail: o.detail }]),
      )
      // Every key the reference produced, and nothing beyond it but the
      // informational signals, which the reference does not have and which
      // score nothing. "No extra keys" became "no UNEXPECTED keys": a key
      // that is in neither list is still a failure.
      for (const key of Object.keys(theirs)) expect(mine, `signal "${key}" is missing`).toHaveProperty(key)
      const extra = Object.keys(mine).filter((k) => !(k in theirs))
      expect(extra.filter((k) => !(ADDITIVE_SIGNAL_KEYS as readonly string[]).includes(k))).toEqual([])
      for (const key of Object.keys(theirs)) {
        expect(mine[key], `signal "${key}"`).toEqual(theirs[key])
      }
    })

    it('agrees on the outdated libraries served in production', () => {
      expect(profile.outdatedLibs.map((l) => `${l.lib} ${l.version}`))
        .toEqual(golden.profile.outdated_libs.map((l) => `${l.lib} ${l.version}`))
    })

    // The number that decides whether this company is worth an email.
    it('agrees on the score, the tier and whether it qualifies', () => {
      expect(result.score).toBe(golden.result.score)
      expect(result.tier).toBe(golden.result.tier)
      expect(result.qualified).toBe(golden.result.qualified)
      expect(result.disqualified).toBe(golden.result.disqualified)
    })

    it('agrees on the gaps, in the same order, with the same weights', () => {
      expect(result.gaps.map((g) => ({ key: g.key, weight: g.weight, detail: g.detail })))
        .toEqual(golden.result.gaps.map((g) => ({ key: g.key, weight: g.weight, detail: g.detail })))
      expect(result.strengths.map((s) => s.key)).toEqual(golden.result.strengths.map((s) => s.key))
    })

    it('agrees on the headline finding, the angle and the evidence', () => {
      expect(result.headlineFinding).toBe(golden.result.headline_finding)
      expect(result.angle).toBe(golden.result.angle)
      expect(result.evidence.map((e) => ({ claim: e.claim, observed: e.observed })))
        .toEqual(golden.result.evidence.map((e) => ({ claim: e.claim, observed: e.observed })))
    })
  })
})
