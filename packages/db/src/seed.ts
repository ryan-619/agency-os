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
import { parseCompanySeeds } from './csv.js'

export { parseCompanySeeds }

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
  agentsInserted: number
  createdOrg: boolean
  createdOwner: boolean
  createdIcp: boolean
}

/** One row of `agent_defs`, as the seed file carries it. */
interface AgentSeed {
  slug: string
  name: string
  description: string
  system_prompt: string
  tools: string[]
  model: string | null
  enabled: boolean
}

/**
 * A URL-safe booking slug from the org's name, or null when nothing usable
 * survives. Must satisfy 0012's `orgs_booking_slug_is_url_safe`:
 * `^[a-z0-9][a-z0-9-]{2,62}$` — so at least three characters, starting
 * alphanumeric, and at most sixty-three.
 */
export function bookingSlugFrom(orgName: string): string | null {
  const slug = orgName
    .toLowerCase()
    .normalize('NFKD')
    // Drop the combining marks NFKD just split off, so "Björk" becomes
    // "bjork" rather than "bjo-rk" — the mark is not a word boundary.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/, '')
  return /^[a-z0-9][a-z0-9-]{2,62}$/.test(slug) ? slug : null
}

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

  /**
   * The public booking link (§8.6).
   *
   * Set here, when absent, because otherwise a freshly seeded deployment
   * answers `/book/<anything>` with a 404 and the only way to fix it is a
   * hand-written UPDATE against production — which is exactly the kind of
   * step that does not happen and then gets reported as a bug.
   *
   * Only ever FILLS IN a missing value: a slug already chosen is a published
   * URL, and a seed re-run must not move somebody's booking link. The
   * `NOT EXISTS` guard keeps the UNIQUE constraint from turning a second
   * org with a similar name into a failed seed.
   */
  const slug = bookingSlugFrom(opts.orgName)
  if (slug) {
    const claimed = await driver.select<{ booking_slug: string }>(
      `UPDATE orgs SET booking_slug = $1
        WHERE id = $2
          AND booking_slug IS NULL
          AND NOT EXISTS (SELECT 1 FROM orgs WHERE booking_slug = $1)
        RETURNING booking_slug`,
      [slug, orgId],
    )
    if (claimed[0]) log(`booking link: /book/${claimed[0].booking_slug}`)
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

  // --- subagents (§7) ------------------------------------------------------
  //
  // "Agents as data": these map onto the SDK's `agents` option, which takes
  // definitions programmatically. Seeding them now means the four §7 roles
  // exist as editable rows from the first boot rather than as a later data
  // migration — Settings → Agents in Phase 3 edits these.
  //
  // Two are seeded DISABLED. `prospector` has no sourcing tool of its own — a
  // subagent is granted agency tools only, never a connector's — so it works
  // from the domains it is given, and `closer` drafts outbound messages, which
  // an owner turns on deliberately. An agent that is present but off is
  // honest about what exists; one that is on and cannot do its job teaches
  // the model a false shape of the business (§12). Each was given the
  // operator tools that fit its job on 2026-10-06; a database seeded before
  // then keeps its rows as they were, and Settings → Agents edits them.
  //
  // Left untouched if present, for the same reason as the ICP: once the team
  // edits a prompt, a re-seed must not silently revert it.
  const agentSeeds = JSON.parse(
    readFileSync(join(SEED_DIR, 'agents.json'), 'utf8'),
  ) as AgentSeed[]
  let agentsInserted = 0
  for (const a of agentSeeds) {
    const inserted = await driver.select<{ id: string }>(
      `INSERT INTO agent_defs (org_id, slug, name, description, system_prompt, tools, model, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, slug) DO NOTHING
       RETURNING id`,
      [orgId, a.slug, a.name, a.description, a.system_prompt, a.tools, a.model, a.enabled],
    )
    if (inserted.length) agentsInserted++
  }
  log(`agents: ${agentsInserted} inserted, ${agentSeeds.length - agentsInserted} already present`)

  return {
    orgId,
    ownerUserId,
    icpProfileId,
    companiesInserted,
    companiesAlreadyPresent: seeds.length - companiesInserted,
    agentsInserted,
    createdOrg,
    createdOwner,
    createdIcp,
  }
}
