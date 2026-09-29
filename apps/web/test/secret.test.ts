/**
 * The one shared-secret comparison (§2.3), tested on the module that carries
 * no `server-only` marker — `lib/secret.ts` re-exports these two functions
 * with the marker and is what a route imports.
 */
import { describe, expect, it } from 'vitest'
import { bearerFrom, bearerFromHeader, secretMatches } from '../src/lib/secret-compare'

const SECRET = 'k'.repeat(32)

describe('secretMatches', () => {
  it('accepts the same bytes', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true)
  })

  it('refuses a different value of the same length', () => {
    expect(secretMatches(SECRET, 'k'.repeat(31) + 'x')).toBe(false)
  })

  it('refuses a different length', () => {
    expect(secretMatches(SECRET, SECRET + 'k')).toBe(false)
    expect(secretMatches(SECRET, SECRET.slice(1))).toBe(false)
  })

  it('refuses nothing at all', () => {
    expect(secretMatches(SECRET, null)).toBe(false)
    expect(secretMatches(SECRET, '')).toBe(false)
  })

  it('compares bytes, not code points, so a multibyte prefix is not a match', () => {
    expect(secretMatches('é', 'é')).toBe(true)
    expect(secretMatches('é', 'é')).toBe(false)
  })
})

describe('bearerFromHeader', () => {
  it('takes the token after Bearer, whatever the case of the scheme', () => {
    expect(bearerFromHeader('Bearer abc')).toBe('abc')
    expect(bearerFromHeader('bearer abc')).toBe('abc')
    expect(bearerFromHeader('BEARER abc')).toBe('abc')
  })

  it('tolerates surrounding whitespace and more than one space after the scheme', () => {
    expect(bearerFromHeader('  Bearer   abc  ')).toBe('abc')
  })

  it('is null for no header, another scheme, or a bare token', () => {
    expect(bearerFromHeader(null)).toBeNull()
    expect(bearerFromHeader('')).toBeNull()
    expect(bearerFromHeader('Basic abc')).toBeNull()
    expect(bearerFromHeader('abc')).toBeNull()
    expect(bearerFromHeader('Bearer')).toBeNull()
    expect(bearerFromHeader('Bearer ')).toBeNull()
  })
})

describe('bearerFrom', () => {
  it('reads the request’s own authorization header', () => {
    const req = new Request('http://app.test/api/cron/rescan', { headers: { authorization: 'bearer tok' } })
    expect(bearerFrom(req)).toBe('tok')
  })

  it('is null on a request with no authorization header', () => {
    expect(bearerFrom(new Request('http://app.test/api/cron/rescan'))).toBeNull()
  })
})
