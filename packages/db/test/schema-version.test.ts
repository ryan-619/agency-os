import { describe, expect, it } from 'vitest'
import { migrateUp, readMigrations } from '../src/migrator.js'
import { MIGRATIONS_DIR } from '../src/paths.js'
import {
  APPLIED_MIGRATION_SQL,
  EXPECTED_MIGRATION,
  LEDGER_TABLE,
  compareSchema,
  parseAppliedMigration,
} from '../src/schema-version.js'
import { expectRejection, freshDb, migratedDb, migrations } from './helpers.js'

/**
 * The constant in schema-version.ts is written by hand so the web bundle can
 * import it without the migrator. This is the test that makes that safe.
 */
describe('EXPECTED_MIGRATION', () => {
  const onDisk = readMigrations(MIGRATIONS_DIR)

  it('matches the highest migration in the repo', () => {
    const highest = onDisk[onDisk.length - 1]?.version
    expect(
      EXPECTED_MIGRATION,
      'Add a migration and this fails until you bump EXPECTED_MIGRATION in ' +
        'packages/db/src/schema-version.ts — in the same commit. The health ' +
        'check compares the database against it, so a stale constant makes a ' +
        'behind-schema deployment report itself healthy.',
    ).toBe(highest)
  })

  it('names a migration that exists', () => {
    expect(onDisk.map((m) => m.version)).toContain(EXPECTED_MIGRATION)
  })
})

describe('compareSchema', () => {
  it('agrees when the versions match', () => {
    expect(compareSchema(EXPECTED_MIGRATION)).toBe('ok')
  })

  it('reports behind when the database is older — the dangerous direction', () => {
    expect(compareSchema('0001')).toBe('behind')
    expect(compareSchema('0017')).toBe('behind')
  })

  it('reports ahead when a newer revision has already migrated', () => {
    expect(compareSchema('9999')).toBe('ahead')
  })

  it('reports unknown rather than guessing when the ledger cannot be read', () => {
    // An empty or absent ledger is NOT "behind": behind is a fact about a
    // database somebody migrated once. Unknown is a fact about this check.
    expect(compareSchema(null)).toBe('unknown')
  })

  it('orders by version rather than by number, which is the same thing here', () => {
    // Zero padding is what makes the string compare correct. If a migration
    // were ever named "10" instead of "0010", "10" < "0017" is false and the
    // comparison silently inverts. The migrator's filename regex requires
    // exactly four digits, which is why this holds.
    expect('0009' < '0017').toBe(true)
    expect('10' < '0017').toBe(false)
  })
})

/**
 * The health route reports the schema state to whoever can reach the URL,
 * which is what lets a deploy be verified by somebody who is not allowed to
 * hold the connection string (§2.3). These tests run the SAME statement the
 * route runs, against a real Postgres build, so "it reports ok" means the
 * query worked rather than that a mock said so.
 */
describe('reading the ledger, as the health route does', () => {
  it('reports the migration a migrated database is actually at', async () => {
    const db = await migratedDb()
    try {
      const rows = await db.driver.select<unknown>(APPLIED_MIGRATION_SQL)
      const applied = parseAppliedMigration(rows)
      expect(applied).toBe(EXPECTED_MIGRATION)
      expect(compareSchema(applied)).toBe('ok')
    } finally {
      await db.close()
    }
  })

  it('throws on a database with no ledger at all, which the route reads as unknown', async () => {
    const db = await freshDb()
    try {
      // A database nobody has ever migrated has no schema_migrations table, so
      // the statement itself fails. The route catches exactly this and reports
      // 'unknown' — not 'behind', because nothing is known.
      const message = await expectRejection(() => db.driver.select<unknown>(APPLIED_MIGRATION_SQL))
      expect(message.toLowerCase()).toContain('schema_migrations')
      expect(compareSchema(null)).toBe('unknown')
    } finally {
      await db.close()
    }
  })

  it('reads an empty ledger as unknown rather than as behind', async () => {
    const db = await freshDb()
    try {
      // The table exists but nothing has been applied. max() over no rows is
      // NULL, and a NULL version is not a version.
      await db.driver.exec(
        `CREATE TABLE ${LEDGER_TABLE} (version text PRIMARY KEY, name text NOT NULL,
         checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      )
      const rows = await db.driver.select<unknown>(APPLIED_MIGRATION_SQL)
      expect(parseAppliedMigration(rows)).toBeNull()
      expect(compareSchema(parseAppliedMigration(rows))).toBe('unknown')
    } finally {
      await db.close()
    }
  })

  it('reports behind when the database stopped one migration short', async () => {
    // The exact situation this whole mechanism exists for: production sitting
    // at 0017 while the code that needs 0018 is about to be deployed.
    const db = await freshDb()
    try {
      const upTo0017 = migrations().filter((m) => m.version < '0018')
      await migrateUp(db.driver, upTo0017)
      const applied = parseAppliedMigration(await db.driver.select<unknown>(APPLIED_MIGRATION_SQL))
      expect(applied).toBe('0017')
      expect(compareSchema(applied)).toBe('behind')
    } finally {
      await db.close()
    }
  })
})
