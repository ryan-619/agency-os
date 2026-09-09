/**
 * Seed the single organisation, its owner, the security-gap SaaS ICP, and the
 * 16 seed companies (PROMPT.md §11).
 *
 * Written against the same MigrationDriver interface as the migrator, so the
 * seed is exercised by the test suite on PGlite as well as run for real
 * against Postgres. Idempotent: running it twice changes nothing.
 *
 * It deliberately does NOT overwrite an existing ICP profile. Once the team
 * edits weights or the qualifying threshold in the UI, a re-seed must not
 * silently revert their tuning.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MigrationDriver } from './migrator.js'
import { SEED_DIR } from './paths.js'

export interface SeedOptions {
  orgName: string
  ownerEmail: string
  ownerName?: string
}

export interface SeedResult {
  orgId: string
  ownerUserId: string
  icpProfileId: string
  companiesInserted: number
  companiesAlreadyPresent: number
  createdOrg: boolean
  createdOwner: boolean
  createdIcp: boolean
}

/** A hostname: labels of letters/digits/hyphens, at least one dot, no scheme or path. */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/**
 * Parse the `domain,name` seed list, ignoring blank lines and comments.
 *
 * De-duplicates on domain so the caller's inserted/already-present counts add
 * up: `ON CONFLICT DO NOTHING` collapses a repeated domain into one insert, so
 * counting the raw line total would over-report "already present".
 */
export function parseCompanySeeds(csv: string): Array<{ domain: string; name: string }> {
  const out: Array<{ domain: string; name: string }> = []
  const seen = new Set<string>()

  for (const raw of csv.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [domain = '', ...rest] = line.split(',')
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!d || d === 'domain') continue // header
    if (!DOMAIN.test(d)) {
      throw new Error(`Seed list contains something that is not a domain: "${domain.trim()}"`)
    }
    if (seen.has(d)) continue
    seen.add(d)
    // A quoted field keeps its commas; strip the surrounding quotes only.
    const name = rest.join(',').trim().replace(/^"(.*)"$/s, '$1')
    out.push({ domain: d, name })
  }
  return out
}

/**
 * Seed inside a single transaction.
 *
 * Without it a partial run leaves debris: the org is created before the owner
 * is validated, so a mismatched SEED_ORG_NAME used to create a second
 * organisation and *then* fail — leaving exactly the split-brain the check
 * exists to prevent. All or nothing.
 */
export async function seed(
  driver: MigrationDriver,
  opts: SeedOptions,
  log: (msg: string) => void = () => {},
): Promise<SeedResult> {
  await driver.exec('BEGIN')
  try {
    const result = await seedInTransaction(driver, opts, log)
    await driver.exec('COMMIT')
    return result
  } catch (err) {
    await driver.exec('ROLLBACK').catch(() => {})
    throw err
  }
}

async function seedInTransaction(
  driver: MigrationDriver,
  opts: SeedOptions,
  log: (msg: string) => void,
): Promise<SeedResult> {
  // Normalised to the one form the database accepts and the Auth.js adapter
  // looks up (users_email_is_normalised in migration 0001).
  const email = opts.ownerEmail.trim().toLowerCase()
  if (!email.includes('@')) throw new Error(`ownerEmail does not look like an address: ${email}`)

  // --- org ----------------------------------------------------------------
  let createdOrg = false
  let rows = await driver.select<{ id: string }>('SELECT id FROM orgs WHERE name = $1', [opts.orgName])
  let orgId = rows[0]?.id
  if (!orgId) {
    rows = await driver.select<{ id: string }>('INSERT INTO orgs (name) VALUES ($1) RETURNING id', [
      opts.orgName,
    ])
    orgId = rows[0]!.id
    createdOrg = true
    log(`created org "${opts.orgName}"`)
  }

  // --- owner --------------------------------------------------------------
  // There is no signup flow (§1). A person can only sign in if a row already
  // exists here, so this seed is how the first human gets access.
  let createdOwner = false
  const userRows = await driver.select<{ id: string; org_id: string }>(
    'SELECT id, org_id FROM users WHERE email = $1',
    [email],
  )
  const existing = userRows[0]
  /**
   * The owner is found globally by address, but the org was found by name. If
   * those disagree, the caller has changed SEED_ORG_NAME against a database
   * that already has this person in a different org — and silently returning a
   * SeedResult whose orgId and ownerUserId belong to different organisations
   * would strand the only account that can sign in. Fail loudly instead.
   */
  if (existing && existing.org_id !== orgId) {
    throw new Error(
      `${email} already exists in a different organisation (${existing.org_id}), but the seed ` +
        `resolved "${opts.orgName}" to ${orgId}. Point SEED_ORG_NAME at the existing ` +
        `organisation, or use a different owner address.`,
    )
  }
  let ownerUserId = existing?.id
  if (!ownerUserId) {
    const inserted = await driver.select<{ id: string }>(
      `INSERT INTO users (org_id, email, name, role) VALUES ($1, $2, $3, 'owner') RETURNING id`,
      [orgId, email, opts.ownerName ?? null],
    )
    ownerUserId = inserted[0]!.id
    createdOwner = true
    log(`created owner ${email}`)
  }

  // --- ICP profile --------------------------------------------------------
  const definition = JSON.parse(
    readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8'),
  ) as { label: string }
  const icpName = definition.label

  let createdIcp = false
  let icpRows = await driver.select<{ id: string }>(
    'SELECT id FROM icp_profiles WHERE org_id = $1 AND name = $2',
    [orgId, icpName],
  )
  let icpProfileId = icpRows[0]?.id
  if (!icpProfileId) {
    icpRows = await driver.select<{ id: string }>(
      `INSERT INTO icp_profiles (org_id, name, definition, active)
       VALUES ($1, $2, $3::jsonb, true) RETURNING id`,
      [orgId, icpName, JSON.stringify(definition)],
    )
    icpProfileId = icpRows[0]!.id
    createdIcp = true
    log(`created ICP profile "${icpName}"`)
  } else {
    log(`ICP profile "${icpName}" already exists — left untouched`)
  }

  // --- companies ----------------------------------------------------------
  const seeds = parseCompanySeeds(
    readFileSync(join(SEED_DIR, 'companies-security-gap-saas.csv'), 'utf8'),
  )
  let companiesInserted = 0
  for (const c of seeds) {
    const inserted = await driver.select<{ id: string }>(
      `INSERT INTO companies (org_id, domain, name, source)
       VALUES ($1, $2, $3, 'import')
       ON CONFLICT (org_id, domain) DO NOTHING
       RETURNING id`,
      [orgId, c.domain, c.name || null],
    )
    if (inserted.length) companiesInserted++
  }
  log(
    `companies: ${companiesInserted} inserted, ${seeds.length - companiesInserted} already present`,
  )

  return {
    orgId,
    ownerUserId,
    icpProfileId,
    companiesInserted,
    companiesAlreadyPresent: seeds.length - companiesInserted,
    createdOrg,
    createdOwner,
    createdIcp,
  }
}
