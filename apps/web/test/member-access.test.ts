import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { memberMayAccess } from '../src/lib/member-access'

/**
 * Revoking access keeps the `users` row (§2.4), so "has a row" is no longer
 * the same question as "may sign in". These pin the rule, and pin that
 * `auth.ts` — which cannot be loaded here, it needs Next — actually asks it
 * on every leg rather than the membership check it used to make.
 */
describe('memberMayAccess', () => {
  it('lets a live member in', () => {
    expect(memberMayAccess({ revokedAt: null })).toBe(true)
  })

  it('refuses a revoked member, whenever they were revoked', () => {
    expect(memberMayAccess({ revokedAt: new Date('2026-09-30T12:00:00Z') })).toBe(false)
    expect(memberMayAccess({ revokedAt: new Date(0) })).toBe(false)
    // Revoked in the future is still revoked: nothing schedules a revocation,
    // so a stamp ahead of the clock is clock skew, not a grace period.
    expect(memberMayAccess({ revokedAt: new Date(Date.now() + 86_400_000) })).toBe(false)
  })

  it('refuses nobody-found exactly as it refuses a revoked member', () => {
    expect(memberMayAccess(null)).toBe(false)
    expect(memberMayAccess(undefined)).toBe(false)
  })
})

describe('auth.ts asks memberMayAccess on every leg', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/auth.ts', import.meta.url)), 'utf8')
    // Comments may mention anything; only code counts.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('imports the rule rather than restating it', () => {
    expect(src).toMatch(/from '@\/lib\/member-access'/)
  })

  /**
   * The magic-link request, the magic-link callback, and the session read on
   * every request. Missing the third is the race where a link completed a
   * moment before the revocation mints a session a moment after it.
   */
  it('checks the request leg, the callback leg and the session', () => {
    expect(src.match(/memberMayAccess\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(src.match(/revokedAt: schema\.users\.revokedAt/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})

describe('member-access.ts loads outside Next', () => {
  it('carries no server-only and no @/ import', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/lib/member-access.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/^import .*['"]server-only['"]/m)
    expect(src).not.toMatch(/from ['"]@\//)
  })
})
