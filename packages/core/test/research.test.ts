/**
 * Research with sources (0028): a claim is a claim and a source is a page a
 * person can open — https, on the public web, no credentials, bounded.
 */
import { describe, expect, it } from 'vitest'
import { RESEARCH_CLAIM_MAX, researchClaimProblem, researchSourceProblem } from '../src/research.js'

describe('researchSourceProblem', () => {
  it('accepts a page on the public web over https', () => {
    expect(researchSourceProblem('https://inc42.com/buzz/kumar-dental-raises/')).toBeNull()
    expect(researchSourceProblem('  https://www.linkedin.com/company/kumar-dental/about/  ')).toBeNull()
  })
  it('refuses http, credentials, an address, a private name and nonsense', () => {
    expect(researchSourceProblem('http://inc42.com/x')).toMatch(/https/)
    expect(researchSourceProblem('https://user:pw@inc42.com/x')).toMatch(/username or password/)
    expect(researchSourceProblem('https://10.0.0.5/x')).toMatch(/public web/)
    expect(researchSourceProblem('https://[::1]/x')).toMatch(/public web/)
    expect(researchSourceProblem('https://intranet/x')).toMatch(/public web/)
    expect(researchSourceProblem('https://wiki.corp/x')).toMatch(/public web/)
    expect(researchSourceProblem('https://localhost/x')).toMatch(/public web/)
    expect(researchSourceProblem('not a url')).toMatch(/browser could open/)
    expect(researchSourceProblem('')).toMatch(/address of the page/)
    expect(researchSourceProblem(`https://a.com/${'x'.repeat(3000)}`)).toMatch(/at most/)
  })
})

describe('researchClaimProblem', () => {
  it('accepts a sentence and refuses a blank, a NUL, an over-long claim and a bare address', () => {
    expect(researchClaimProblem('Raised a Series A of $4m in March 2026.')).toBeNull()
    expect(researchClaimProblem('   ')).toMatch(/in a sentence/)
    expect(researchClaimProblem('bad\u0000')).toMatch(/cannot be stored/)
    expect(researchClaimProblem('a'.repeat(RESEARCH_CLAIM_MAX + 1))).toMatch(/at most/)
    expect(researchClaimProblem('https://inc42.com/x')).toMatch(/not the page’s address/)
  })
})
