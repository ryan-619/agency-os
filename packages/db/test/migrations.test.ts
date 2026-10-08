import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshDb, migrations, tableNames, indexNames, columnNames, type TestDb } from './helpers.js'
import { migrateUp, migrateDown, migrationStatus, readMigrations, sha256 } from '../src/migrator.js'
import { MIGRATIONS_DIR } from '../src/paths.js'

/** Every table the §4 data model calls for, plus the Auth.js adapter tables. */
const BUSINESS_TABLES = [
  'agent_defs', 'approvals', 'assistant_settings', 'audit_log', 'calls', 'campaign_steps', 'campaigns', 'chat_messages',
  'chat_sessions', 'companies', 'connectors', 'consents', 'contacts', 'deals',
  'findings', 'icp_profiles', 'meetings', 'message_templates', 'notes', 'org_profiles', 'proposal_shares', 'proposals',
  'quotes', 'scans', 'scores', 'secrets', 'sequence_runs', 'services', 'share_links', 'site_audits', 'suppressions', 'tasks', 'touches',
]
const AUTH_TABLES = ['accounts', 'sessions', 'users', 'verification_tokens']
/**
 * Tables that serve the whole deployment rather than one org (0018). They
 * follow the id and timestamp conventions and deliberately carry NO org_id:
 * the worker serves every org, so "the org's worker" is not a concept.
 */
const SYSTEM_TABLES = ['worker_heartbeats']
const ALL_TABLES = [...BUSINESS_TABLES, ...AUTH_TABLES, ...SYSTEM_TABLES, 'orgs'].sort()

describe('migration files', () => {
  it('every migration has both an up and a down (PROMPT.md §10)', () => {
    const all = readMigrations(MIGRATIONS_DIR)
    expect(all.length).toBeGreaterThan(0)
    for (const m of all) {
      expect(m.upSql.trim().length, `${m.version}_${m.name} up is empty`).toBeGreaterThan(0)
      expect(m.downSql.trim().length, `${m.version}_${m.name} down is empty`).toBeGreaterThan(0)
    }
  })

  // Uniqueness and ordering are structural in readMigrations (a Map keyed by
  // version, returned sorted), so asserting them proves nothing about the
  // FILES. What is worth checking is that the directory itself is sane and
  // contiguous — a skipped or misnumbered version is a real mistake.
  it('the migration files are numbered contiguously from 0001', () => {
    const versions = readMigrations(MIGRATIONS_DIR).map((m) => m.version)
    expect(versions.length).toBeGreaterThan(0)
    expect(versions).toEqual(
      versions.map((_, i) => String(i + 1).padStart(4, '0')),
    )
  })

  it('every migration name is a distinct, readable slug', () => {
    const names = readMigrations(MIGRATIONS_DIR).map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

describe('migrating from zero', () => {
  let db: TestDb
  beforeAll(async () => { db = await freshDb() })
  afterAll(async () => { await db.close() })

  it('runs on a real Postgres engine', async () => {
    const [row] = await db.driver.select<{ version: string }>('SELECT version()')
    expect(row.version).toContain('PostgreSQL')
  })

  // PGlite derives TimeZone from the host clock unless told otherwise, and
  // truncates to whole hours — a developer at +05:30 would silently test at
  // +05:00 while production runs UTC. See freshDb() in helpers.ts.
  it('runs in UTC, like production', async () => {
    const [row] = await db.driver.select<{ TimeZone: string }>('SHOW TimeZone')
    expect(row.TimeZone).toBe('UTC')
  })

  it('applies every migration cleanly against an empty database', async () => {
    const result = await migrateUp(db.driver, migrations())
    expect(result.applied).toEqual(migrations().map((m) => m.version))
    expect(result.alreadyApplied).toEqual([])
  })

  it('creates exactly the tables the data model calls for', async () => {
    const tables = (await tableNames(db.driver)).filter((t) => t !== 'schema_migrations')
    expect(tables).toEqual(ALL_TABLES)
  })

  it('records every applied migration in the ledger', async () => {
    const status = await migrationStatus(db.driver, migrations())
    expect(status.every((s) => s.applied)).toBe(true)
    expect(status).toHaveLength(migrations().length)
  })

  it('is idempotent — running up again applies nothing', async () => {
    const again = await migrateUp(db.driver, migrations())
    expect(again.applied).toEqual([])
    expect(again.alreadyApplied).toHaveLength(migrations().length)
  })
})

describe('the §4 table conventions hold everywhere', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await freshDb()
    await migrateUp(db.driver, migrations())
  })
  afterAll(async () => { await db.close() })

  it('every table has a uuid id defaulting to gen_random_uuid()', async () => {
    for (const table of [...BUSINESS_TABLES, ...SYSTEM_TABLES, 'orgs', 'users']) {
      const [row] = await db.driver.select<{ data_type: string; column_default: string | null }>(
        `SELECT data_type, column_default FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='id'`,
        [table],
      )
      expect(row, `${table} has no id column`).toBeDefined()
      expect(row.data_type, `${table}.id is not uuid`).toBe('uuid')
      expect(row.column_default ?? '', `${table}.id has no gen_random_uuid default`)
        .toContain('gen_random_uuid')
    }
  })

  it('every table has created_at not-null-default-now and a nullable updated_at', async () => {
    for (const table of [...BUSINESS_TABLES, ...SYSTEM_TABLES, 'orgs', 'users']) {
      const rows = await db.driver.select<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
        `SELECT column_name, is_nullable, column_default, data_type
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name IN ('created_at','updated_at')`,
        [table],
      )
      const created = rows.find((r) => r.column_name === 'created_at')
      const updated = rows.find((r) => r.column_name === 'updated_at')
      expect(created, `${table} has no created_at`).toBeDefined()
      expect(created!.is_nullable).toBe('NO')
      expect(created!.column_default ?? '').toContain('now()')
      expect(created!.data_type).toBe('timestamp with time zone')
      expect(updated, `${table} has no updated_at`).toBeDefined()
      expect(updated!.data_type).toBe('timestamp with time zone')
    }
  })

  // §4: "Include an org_id uuid not null on every business table even though
  // there is exactly one organization today."
  it('every business table carries a not-null org_id', async () => {
    for (const table of BUSINESS_TABLES) {
      const [row] = await db.driver.select<{ is_nullable: string; data_type: string }>(
        `SELECT is_nullable, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='org_id'`,
        [table],
      )
      expect(row, `${table} has no org_id`).toBeDefined()
      expect(row.data_type).toBe('uuid')
      expect(row.is_nullable, `${table}.org_id is nullable`).toBe('NO')
    }
  })

  it('updated_at is maintained by a trigger, not left to the caller', async () => {
    const [org] = await db.driver.select<{ id: string; updated_at: string | null }>(
      `INSERT INTO orgs (name) VALUES ('Trigger Test') RETURNING id, updated_at`,
    )
    expect(org.updated_at).toBeNull()
    const [after] = await db.driver.select<{ updated_at: string | null }>(
      `UPDATE orgs SET name = 'Trigger Test 2' WHERE id = $1 RETURNING updated_at`,
      [org.id],
    )
    expect(after.updated_at).not.toBeNull()
  })

  // §4 "Indexes that matter"
  it('creates the indexes §4 calls out by name', async () => {
    const cases: Array<[string, string[]]> = [
      ['companies', ['companies_org_domain_key']],
      ['touches', ['touches_campaign_status_scheduled_idx']],
      ['findings', ['findings_company_stale_idx']],
      ['suppressions', ['suppressions_org_kind_value_key']],
      ['approvals', ['approvals_org_status_idx']],
    ]
    for (const [table, expected] of cases) {
      const actual = await indexNames(db.driver, table)
      for (const idx of expected) {
        expect(actual, `${table} is missing index ${idx}`).toContain(idx)
      }
    }
  })

  it('findings carries the columns the evidence rules need', async () => {
    const cols = await columnNames(db.driver, 'findings')
    for (const c of ['observed', 'gap', 'evidence', 'stale', 'signal_key', 'weight', 'detail', 'scored']) {
      expect(cols, `findings.${c} missing`).toContain(c)
    }
  })
})

/**
 * 0018. A system table keeps every convention a business table keeps except
 * the one that would be a lie: `org_id`. `worker_heartbeats` is written by a
 * process that serves every org at once, and a per-org row would be N upserts
 * per tick describing one worker.
 */
describe('system tables', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await freshDb()
    await migrateUp(db.driver, migrations())
  })
  afterAll(async () => { await db.close() })

  it('every system table has a uuid id defaulting to gen_random_uuid()', async () => {
    for (const table of SYSTEM_TABLES) {
      const [row] = await db.driver.select<{ data_type: string; column_default: string | null }>(
        `SELECT data_type, column_default FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='id'`,
        [table],
      )
      expect(row, `${table} has no id column`).toBeDefined()
      expect(row.data_type).toBe('uuid')
      expect(row.column_default ?? '').toContain('gen_random_uuid')
    }
  })

  it('every system table has created_at not-null-default-now and a nullable updated_at', async () => {
    for (const table of SYSTEM_TABLES) {
      const rows = await db.driver.select<{ column_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name IN ('created_at','updated_at')`,
        [table],
      )
      const created = rows.find((r) => r.column_name === 'created_at')
      const updated = rows.find((r) => r.column_name === 'updated_at')
      expect(created, `${table} has no created_at`).toBeDefined()
      expect(created!.is_nullable).toBe('NO')
      expect(created!.column_default ?? '').toContain('now()')
      expect(updated, `${table} has no updated_at`).toBeDefined()
      expect(updated!.is_nullable).toBe('YES')
    }
  })

  it('maintains updated_at by trigger', async () => {
    const [row] = await db.driver.select<{ id: string; updated_at: string | null }>(
      `INSERT INTO worker_heartbeats (worker_id, booted_at, last_tick_at, outreach, chat)
       VALUES ('w-trigger', now(), now(), 'disabled', 'disabled') RETURNING id, updated_at`,
    )
    expect(row.updated_at).toBeNull()
    const [after] = await db.driver.select<{ updated_at: string | null }>(
      `UPDATE worker_heartbeats SET last_tick_at = now() WHERE id = $1 RETURNING updated_at`,
      [row.id],
    )
    expect(after.updated_at).not.toBeNull()
  })

  it('carries no org_id — the worker serves every org', async () => {
    for (const table of SYSTEM_TABLES) {
      const cols = await columnNames(db.driver, table)
      expect(cols, `${table} must not be org-scoped`).not.toContain('org_id')
    }
  })
})

describe('rolling back', () => {
  let db: TestDb
  beforeAll(async () => { db = await freshDb() })
  afterAll(async () => { await db.close() })

  it('unwinds to a completely empty schema', async () => {
    await migrateUp(db.driver, migrations())
    const undone = await migrateDown(db.driver, migrations(), 'all')
    expect(undone).toEqual([...migrations()].reverse().map((m) => m.version))

    const left = (await tableNames(db.driver)).filter((t) => t !== 'schema_migrations')
    expect(left, `these tables survived the rollback: ${left.join(', ')}`).toEqual([])
  })

  it('leaves no orphaned functions or triggers behind', async () => {
    const fns = await db.driver.select<{ proname: string }>(
      `SELECT proname FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'`,
    )
    expect(fns.map((f) => f.proname)).not.toContain('set_updated_at')
  })

  it('re-applies cleanly afterwards, proving down is a true inverse', async () => {
    const result = await migrateUp(db.driver, migrations())
    expect(result.applied).toEqual(migrations().map((m) => m.version))
    const tables = (await tableNames(db.driver)).filter((t) => t !== 'schema_migrations')
    expect(tables).toEqual(ALL_TABLES)
  })

  it('reverts one step at a time', async () => {
    const undone = await migrateDown(db.driver, migrations(), 1)
    expect(undone).toHaveLength(1)
    expect(undone[0]).toBe(migrations().at(-1)!.version)
    const status = await migrationStatus(db.driver, migrations())
    expect(status.filter((s) => !s.applied)).toHaveLength(1)
  })
})

describe('the migrator refuses to run on a drifted history', () => {
  it('detects a shipped migration that was edited after it was applied (§10)', async () => {
    const db = await freshDb()
    try {
      await migrateUp(db.driver, migrations())
      const tampered = migrations().map((m, i) =>
        i === 0 ? { ...m, upSql: `${m.upSql}\n-- sneaky edit`, checksum: sha256(`${m.upSql}\n-- sneaky edit`) } : m,
      )
      await expect(migrateUp(db.driver, tampered)).rejects.toThrow(/edited since it was applied/)
    } finally {
      await db.close()
    }
  })

  it('detects a migration applied in the database but missing from the repo', async () => {
    const db = await freshDb()
    try {
      await migrateUp(db.driver, migrations())
      const missing = migrations().slice(0, -1)
      await expect(migrateUp(db.driver, missing)).rejects.toThrow(/missing from the repo/)
    } finally {
      await db.close()
    }
  })
})

describe('a failing migration rolls back completely', () => {
  it('leaves no partial table and records nothing in the ledger', async () => {
    const db = await freshDb()
    try {
      const bad = [
        {
          version: '9001',
          name: 'broken',
          upSql: `CREATE TABLE will_not_survive (id int);\nTHIS IS NOT SQL;`,
          downSql: 'DROP TABLE IF EXISTS will_not_survive;',
          checksum: 'x',
        },
      ]
      await expect(migrateUp(db.driver, bad)).rejects.toThrow(/failed and was rolled back/)
      const tables = await tableNames(db.driver)
      expect(tables).not.toContain('will_not_survive')
      const status = await migrationStatus(db.driver, bad)
      expect(status[0].applied).toBe(false)
    } finally {
      await db.close()
    }
  })
})
