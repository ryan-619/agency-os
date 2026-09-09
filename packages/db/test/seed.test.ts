import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'
import { seed, parseCompanySeeds } from '../src/seed.js'

const OPTS = { orgName: 'Agency', ownerEmail: 'Owner@Example.com', ownerName: 'Owner' }

describe('parseCompanySeeds', () => {
  it('skips the header, blanks and comments, and lower-cases domains', () => {
    const rows = parseCompanySeeds(
      ['domain,name', '', '# a comment', 'Rentman.IO,Rentman', 'solo.dev'].join('\n'),
    )
    expect(rows).toEqual([
      { domain: 'rentman.io', name: 'Rentman' },
      { domain: 'solo.dev', name: '' },
    ])
  })

  it('keeps commas that belong to the company name', () => {
    expect(parseCompanySeeds('acme.com,Acme, Inc.')).toEqual([
      { domain: 'acme.com', name: 'Acme, Inc.' },
    ])
  })

  it('unwraps a quoted name', () => {
    expect(parseCompanySeeds('acme.com,"Acme, Inc."')).toEqual([
      { domain: 'acme.com', name: 'Acme, Inc.' },
    ])
  })

  it('strips a scheme or path someone pasted in', () => {
    expect(parseCompanySeeds('https://acme.com/pricing,Acme')).toEqual([
      { domain: 'acme.com', name: 'Acme' },
    ])
  })

  it('tolerates CRLF and a byte-order mark', () => {
    expect(parseCompanySeeds('\uFEFFdomain,name\r\nacme.com,Acme\r\n')).toEqual([
      { domain: 'acme.com', name: 'Acme' },
    ])
  })

  // ON CONFLICT DO NOTHING collapses a repeated domain into one insert, so a
  // raw line count would over-report "already present" on the next run.
  it('de-duplicates a repeated domain so the caller’s counts add up', () => {
    expect(parseCompanySeeds('acme.com,Acme\nACME.com,Acme Again')).toEqual([
      { domain: 'acme.com', name: 'Acme' },
    ])
  })

  it('rejects a line that is not a domain rather than importing garbage', () => {
    expect(() => parseCompanySeeds('not a domain at all,Nope')).toThrow(/not a domain/)
    expect(() => parseCompanySeeds('localhost,Local')).toThrow(/not a domain/)
  })
})

describe('seeding a fresh database', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await freshDb()
    await migrateUp(db.driver, migrations())
  })
  afterAll(async () => { await db.close() })

  it('creates the org, the owner, the ICP profile and the 16 seed companies (§11)', async () => {
    const r = await seed(db.driver, OPTS)
    expect(r.createdOrg).toBe(true)
    expect(r.createdOwner).toBe(true)
    expect(r.createdIcp).toBe(true)
    expect(r.companiesInserted).toBe(16)
    expect(r.companiesAlreadyPresent).toBe(0)
  })

  it('makes the seeded user an owner, so somebody can edit connectors (§4)', async () => {
    const [u] = await db.driver.select<{ role: string; email: string; org_id: string }>(
      `SELECT role, email, org_id FROM users WHERE lower(email) = 'owner@example.com'`,
    )
    expect(u.role).toBe('owner')
    // Stored lower-cased so the magic-link lookup is case-insensitive.
    expect(u.email).toBe('owner@example.com')
  })

  it('stores the ICP definition with the §11 weights intact', async () => {
    const [row] = await db.driver.select<{ definition: Record<string, unknown> }>(
      `SELECT definition FROM icp_profiles WHERE active = true`,
    )
    const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition
    const signals = def.signals as Record<string, { weight: number }>

    expect(Object.keys(signals)).toHaveLength(12)
    // The exact weights from §11 / the Python engine's ICP file.
    expect(signals.csp.weight).toBe(15)
    expect(signals.trust_page.weight).toBe(14)
    expect(signals.compliance_claim.weight).toBe(12)
    expect(signals.security_txt.weight).toBe(12)
    expect(signals.hsts.weight).toBe(10)
    expect(signals.outdated_js.weight).toBe(10)
    expect(signals.frame_protection.weight).toBe(8)
    expect(signals.tls.weight).toBe(8)
    expect(signals.server_banner.weight).toBe(7)
    expect(signals.content_type_options.weight).toBe(5)
    expect(signals.referrer_policy.weight).toBe(4)
    expect(signals.permissions_policy.weight).toBe(3)

    // The Python engine's own test asserts 15+14+12+12 = 53 of 108 -> 49.
    // Total weight must therefore be 108 or Phase 1's port will not match.
    const total = Object.values(signals).reduce((a, s) => a + s.weight, 0)
    expect(total).toBe(108)

    expect((def.scoring as { qualify_at: number }).qualify_at).toBe(45)
    expect((def.scoring as { tiers: Array<{ floor: number }> }).tiers.map((t) => t.floor))
      .toEqual([70, 55, 45])
    expect((def.freshness as { stale_after_days: number }).stale_after_days).toBe(14)
  })

  it('records outreach channels as email and LinkedIn only — never cold voice or SMS (§2.1)', async () => {
    const [row] = await db.driver.select<{ definition: Record<string, unknown> }>(
      `SELECT definition FROM icp_profiles WHERE active = true`,
    )
    const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition
    const outreach = def.outreach as { channels: string[]; max_per_day: number; auto_send: boolean }
    expect(outreach.channels).toEqual(['email', 'linkedin'])
    expect(outreach.channels).not.toContain('voice')
    expect(outreach.channels).not.toContain('sms')
    expect(outreach.max_per_day).toBe(25)
    expect(outreach.auto_send).toBe(false)
  })

  it('imports the seed companies against the seeded org with source=import', async () => {
    const rows = await db.driver.select<{ domain: string; source: string }>(
      `SELECT domain, source FROM companies ORDER BY domain`,
    )
    expect(rows).toHaveLength(16)
    expect(rows.every((r) => r.source === 'import')).toBe(true)
    expect(rows.map((r) => r.domain)).toContain('rentman.io')
    expect(rows.map((r) => r.domain)).toContain('arcol.io')
  })

  it('is idempotent — a second run inserts nothing and creates nothing', async () => {
    const r = await seed(db.driver, OPTS)
    expect(r.createdOrg).toBe(false)
    expect(r.createdOwner).toBe(false)
    expect(r.createdIcp).toBe(false)
    expect(r.companiesInserted).toBe(0)
    expect(r.companiesAlreadyPresent).toBe(16)

    const [{ count }] = await db.driver.select<{ count: string }>(`SELECT count(*) FROM companies`)
    expect(Number(count)).toBe(16)
    const [{ count: orgs }] = await db.driver.select<{ count: string }>(`SELECT count(*) FROM orgs`)
    expect(Number(orgs)).toBe(1)
  })

  it('does not clobber an ICP the team has since tuned', async () => {
    await db.driver.select(
      `UPDATE icp_profiles SET definition = jsonb_set(definition, '{scoring,qualify_at}', '55')`,
    )
    await seed(db.driver, OPTS)
    const [row] = await db.driver.select<{ definition: Record<string, unknown> }>(
      `SELECT definition FROM icp_profiles WHERE active = true`,
    )
    const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition
    expect((def.scoring as { qualify_at: number }).qualify_at).toBe(55)
  })

  // orgs.name is unique and the seed resolves the org by name, so changing
  // SEED_ORG_NAME against an existing database must not quietly produce a
  // second org with the owner stranded in the first.
  it('refuses to strand the owner when SEED_ORG_NAME changes', async () => {
    await expect(seed(db.driver, { ...OPTS, orgName: 'A Different Agency' })).rejects.toThrow(
      /already exists in a different organisation/,
    )
  })

  it('never creates a second organisation', async () => {
    const [{ count }] = await db.driver.select<{ count: string }>(`SELECT count(*) FROM orgs`)
    expect(Number(count)).toBe(1)
  })

  it('rejects an owner email that is not an address', async () => {
    await expect(seed(db.driver, { ...OPTS, ownerEmail: 'not-an-email' })).rejects.toThrow(
      /does not look like an address/,
    )
  })
})
