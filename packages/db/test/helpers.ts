import { PGlite } from '@electric-sql/pglite'
import { pgliteDriver } from '../src/driver.js'
import { readMigrations, type MigrationDriver, type Migration } from '../src/migrator.js'
import { MIGRATIONS_DIR } from '../src/paths.js'

/**
 * A throwaway in-memory Postgres for one test.
 *
 * PGlite embeds a real Postgres build (see the version assertion in
 * migrations.test.ts), so DDL that passes here is genuinely valid Postgres —
 * unlike a SQLite stand-in. CI additionally runs this same suite against a
 * real postgres:16 container; see .github/workflows/ci.yml.
 */
export interface TestDb {
  pg: PGlite
  driver: MigrationDriver
  close(): Promise<void>
}

export async function freshDb(): Promise<TestDb> {
  const pg = await PGlite.create({
    // PGlite otherwise derives its TimeZone from the host clock as an
    // Etc/GMT±N zone, truncated to whole hours — a machine at +05:30 gets
    // +05:00, and every timestamptz assertion silently shifts. Production
    // Postgres runs UTC, so the tests must too.
    // (`startParams: ['-c','timezone=UTC']` is NOT the right knob; it throws.)
    postgresqlconf: ["timezone = 'UTC'"],
  })
  return {
    pg,
    driver: pgliteDriver(pg),
    close: () => pg.close(),
  }
}

let cached: Migration[] | null = null

/** The real migration files from packages/db/migrations. */
export function migrations(): Migration[] {
  cached ??= readMigrations(MIGRATIONS_DIR)
  return cached
}

/** Table names in the public schema, sorted. */
export async function tableNames(driver: MigrationDriver): Promise<string[]> {
  const rows = await driver.select<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )
  return rows.map((r) => r.tablename)
}

/** Column names for one table, sorted. */
export async function columnNames(driver: MigrationDriver, table: string): Promise<string[]> {
  const rows = await driver.select<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
    [table],
  )
  return rows.map((r) => r.column_name)
}

/** Index names for one table. */
export async function indexNames(driver: MigrationDriver, table: string): Promise<string[]> {
  const rows = await driver.select<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
    [table],
  )
  return rows.map((r) => r.indexname)
}

/** Assert a statement is rejected by the database, and return the message. */
export async function expectRejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('expected the database to reject this statement, but it succeeded')
}
