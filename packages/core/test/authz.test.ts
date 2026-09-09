import { describe, it, expect } from 'vitest'
import {
  can,
  assertCan,
  sameOrg,
  NotPermittedError,
  ROLES,
  type Capability,
  type Principal,
} from '../src/index.js'

const owner: Principal = { id: 'u-owner', orgId: 'org-1', role: 'owner' }
const member: Principal = { id: 'u-member', orgId: 'org-1', role: 'member' }

/** Every capability the type allows, listed so the tests can sweep all of them. */
const ALL_CAPABILITIES: Capability[] = [
  'connectors:write',
  'credentials:write',
  'agents:write',
  'users:write',
  'campaigns:set_auto_send',
  'connectors:read',
  'agents:read',
  'companies:read',
  'companies:write',
  'contacts:read',
  'contacts:write',
  'campaigns:read',
  'campaigns:write',
  'deals:read',
  'deals:write',
  'approvals:decide',
  'chat:use',
  'audit:read',
]

const OWNER_ONLY: Capability[] = [
  'connectors:write',
  'credentials:write',
  'agents:write',
  'users:write',
  'campaigns:set_auto_send',
]

describe('can()', () => {
  it('grants the owner every capability', () => {
    for (const c of ALL_CAPABILITIES) {
      expect(can(owner, c), `owner should have ${c}`).toBe(true)
    }
  })

  it('denies a member the owner-only capabilities', () => {
    for (const c of OWNER_ONLY) {
      expect(can(member, c), `member must not have ${c}`).toBe(false)
    }
  })

  it('grants a member every capability that is not owner-only', () => {
    for (const c of ALL_CAPABILITIES.filter((c) => !OWNER_ONLY.includes(c))) {
      expect(can(member, c), `member should have ${c}`).toBe(true)
    }
  })

  // §4: "only owner can edit connectors and credentials" — stated explicitly
  // because it is the rule that keeps a member from wiring a new MCP server
  // or reading a third-party key.
  it('gates connector and credential editing on the owner role', () => {
    expect(can(member, 'connectors:write')).toBe(false)
    expect(can(member, 'credentials:write')).toBe(false)
    expect(can(owner, 'connectors:write')).toBe(true)
    expect(can(owner, 'credentials:write')).toBe(true)
    // A member can still SEE which connectors exist — they just cannot change them.
    expect(can(member, 'connectors:read')).toBe(true)
  })

  // §2.4: auto_send is the switch that lets mail leave the building without a
  // per-message human decision. Only the owner may flip it.
  it('gates the campaign auto-send switch on the owner role', () => {
    expect(can(member, 'campaigns:set_auto_send')).toBe(false)
    expect(can(owner, 'campaigns:set_auto_send')).toBe(true)
    // ...while ordinary campaign editing stays open to the team.
    expect(can(member, 'campaigns:write')).toBe(true)
  })

  it('fails closed on a missing principal', () => {
    for (const c of ALL_CAPABILITIES) {
      expect(can(null, c)).toBe(false)
      expect(can(undefined, c)).toBe(false)
    }
  })

  it('fails closed on an unknown role', () => {
    const rogue = { id: 'x', orgId: 'org-1', role: 'admin' } as unknown as Principal
    for (const c of ALL_CAPABILITIES) {
      expect(can(rogue, c), `unknown role must not have ${c}`).toBe(false)
    }
  })

  it('fails closed on an unknown capability', () => {
    const bogus = 'connectors:destroy' as Capability
    expect(can(owner, bogus)).toBe(false)
    expect(can(member, bogus)).toBe(false)
  })

  it('exposes exactly the two roles the schema allows', () => {
    expect([...ROLES]).toEqual(['owner', 'member'])
  })
})

describe('assertCan()', () => {
  it('returns quietly when permitted', () => {
    expect(() => assertCan(owner, 'connectors:write')).not.toThrow()
  })

  it('throws NotPermittedError naming the capability when denied', () => {
    expect(() => assertCan(member, 'connectors:write')).toThrow(NotPermittedError)
    try {
      assertCan(member, 'credentials:write')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NotPermittedError)
      expect((e as NotPermittedError).capability).toBe('credentials:write')
    }
  })

  it('throws on a missing principal rather than treating it as anonymous-allowed', () => {
    expect(() => assertCan(null, 'chat:use')).toThrow(NotPermittedError)
  })
})

describe('sameOrg()', () => {
  it('is true only within the principal’s own org', () => {
    expect(sameOrg(owner, 'org-1')).toBe(true)
    expect(sameOrg(owner, 'org-2')).toBe(false)
    expect(sameOrg(null, 'org-1')).toBe(false)
  })
})
