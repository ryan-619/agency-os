/**
 * The migration this revision of the code expects the database to be at, and
 * the pieces needed to ask a live database whether it agrees.
 *
 * This module imports NOTHING, deliberately. Its only consumer that matters is
 * the web app's health route, running on Vercel, and
 * `apps/web/src/lib/db.ts` already documents that importing @agency/db's index
 * drags in the migrator — which resolves migration files through
 * `import.meta.url` — and that the bundler has no business tracing into it.
 * Nothing here touches the filesystem, a driver, or an environment variable.
 */

/**
 * The highest migration in packages/db/migrations, written by hand.
 *
 * The obvious implementation — read the directory and take the maximum —
 * cannot be used by the thing that needs it most, for the reason above: a
 * readiness check that only works when the .sql files happen to sit next to
 * the bundle is a readiness check that reports "fine" in the one environment
 * it was written for.
 *
 * So the number is written down, and `test/schema-version.test.ts` fails if it
 * stops matching the directory. It can be wrong for exactly as long as it
 * takes to run the suite.
 *
 * Adding a migration? Bump this in the same commit.
 */
export const EXPECTED_MIGRATION = '0024'

/** The ledger table `migrateUp` writes to. */
export const LEDGER_TABLE = 'schema_migrations'

/**
 * What the database admits to having applied.
 *
 * A constant rather than an interpolated identifier: the table name is ours,
 * it never comes from a caller, and a fixed string is both simpler to read and
 * simpler to be sure about than a quoting helper. Anything that can run a
 * SELECT can run this — node-postgres, PGlite, psql — which is what lets the
 * test exercise the same statement the route does.
 *
 * `max()` over a text column is lexicographic, which IS version order here
 * because every version is four zero-padded digits. The migrator's filename
 * regex (`^(\d{4})_`) rejects anything else, so that cannot quietly stop
 * being true.
 */
export const APPLIED_MIGRATION_SQL = `SELECT max(version) AS version FROM ${LEDGER_TABLE}`

/**
 * Pull the version out of whatever the driver handed back.
 *
 * Every branch here is a real answer rather than an error:
 *   - no rows, or a NULL version, is an EMPTY ledger — a database whose table
 *     exists because something created it but which has never had a migration
 *     applied.
 *   - a missing table throws in the caller, which reports 'unknown' too.
 * Both mean "nothing is known about this database's schema", which is
 * different from "this database is behind", and the difference matters: one
 * asks you to run the migration, the other tells you the check is blind.
 */
export function parseAppliedMigration(rows: readonly unknown[]): string | null {
  const row = rows[0]
  if (row === undefined || row === null || typeof row !== 'object') return null
  const value = (row as Record<string, unknown>)['version']
  return typeof value === 'string' && value.length > 0 ? value : null
}

export type SchemaAgreement =
  /** The database is at exactly the migration this code was written against. */
  | 'ok'
  /**
   * The database is BEHIND. The dangerous direction, and the quiet one:
   * migrations here only ADD, so this code boots fine and serves fine, then
   * throws `column ... does not exist` the first time somebody reaches the
   * feature that needed the new column.
   */
  | 'behind'
  /**
   * The database is AHEAD — a newer revision migrated it and this one is still
   * serving. Usually benign for the same additive reason, and every rollout
   * passes through it. Worth reporting, not worth refusing.
   */
  | 'ahead'
  /** The ledger could not be read, or is empty. Nothing is known. */
  | 'unknown'

/**
 * Compare what the database has applied against what this code needs.
 * Pure, so every interesting case is tested without a database.
 */
export function compareSchema(applied: string | null): SchemaAgreement {
  if (applied === null) return 'unknown'
  if (applied === EXPECTED_MIGRATION) return 'ok'
  return applied < EXPECTED_MIGRATION ? 'behind' : 'ahead'
}
