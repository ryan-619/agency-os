/**
 * A small forward-and-backward SQL migrator.
 *
 * Why hand-rolled rather than drizzle-kit's own runner: PROMPT.md §10 requires
 * every migration to be reversible, and drizzle-kit generates `up` SQL only.
 * Migrations here are plain numbered .sql pairs — `NNNN_name.up.sql` and
 * `NNNN_name.down.sql` — which are reviewable in a diff, runnable with psql if
 * this code ever fails, and reversible by construction.
 *
 * Each migration runs inside a single transaction, so a failure leaves the
 * database exactly where it started.
 *
 * The corollary: DDL that Postgres refuses to run inside a transaction —
 * CREATE INDEX CONCURRENTLY, ALTER TYPE ... ADD VALUE on an existing type,
 * VACUUM — cannot be used in a migration file. None of it is needed today. If
 * it becomes necessary, add an explicit opt-out marker rather than removing
 * the wrapper for everything.
 *
 * §10 also says "never edit a shipped migration". This records a checksum of
 * every applied file and refuses to run if one changed underneath it.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The subset of a Postgres client this migrator needs. Both `pg` (production)
 * and PGlite (tests, no Docker required) are adapted onto it — see driver.ts.
 */
export interface MigrationDriver {
  /**
   * Run one or more statements separated by semicolons. No parameters.
   * Used for the migration files themselves and for transaction control.
   */
  exec(sql: string): Promise<void>
  /**
   * Run a single parameterised statement and return any rows.
   * MUST use the same connection as exec(), or BEGIN/COMMIT will not enclose it.
   */
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface Migration {
  /** Zero-padded numeric prefix, e.g. "0001". Ordering key and primary key. */
  version: string
  /** Human part of the filename, e.g. "foundation". */
  name: string
  upSql: string
  downSql: string
  /**
   * sha256 of BOTH files. An edited `.down.sql` is just as dangerous as an
   * edited `.up.sql`: migrateDown deletes the ledger row on the strength of
   * whatever the down script does, so a silently changed one can leave a
   * schema that no longer matches its recorded state and cannot be recovered
   * through this tool.
   */
  checksum: string
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Read every migration pair from a directory, in version order.
 * Throws if an `up` has no matching `down` — an irreversible migration is a
 * bug, not a warning.
 */
export function readMigrations(dir: string): Migration[] {
  if (!existsSync(dir)) throw new Error(`Migrations directory not found: ${dir}`)

  interface Pair { name: string; up?: string; down?: string }
  const byVersion = new Map<string, Pair>()

  for (const file of readdirSync(dir).sort()) {
    const m = FILENAME.exec(file)
    if (!m) {
      if (file.endsWith('.sql')) {
        throw new Error(
          `Migration filename "${file}" does not match NNNN_name.(up|down).sql`,
        )
      }
      continue
    }
    // The regex has three capture groups, so all three are present on a match.
    const version = m[1]!
    const name = m[2]!
    const direction = m[3]! as 'up' | 'down'

    const entry: Pair = byVersion.get(version) ?? { name }
    if (entry.name !== name) {
      throw new Error(
        `Version ${version} used by two different migrations: "${entry.name}" and "${name}"`,
      )
    }
    entry[direction] = readFileSync(join(dir, file), 'utf8')
    byVersion.set(version, entry)
  }

  return [...byVersion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([version, e]) => {
      if (e.up === undefined) throw new Error(`Migration ${version}_${e.name} has no .up.sql`)
      // Each migration is wrapped in BEGIN/COMMIT by migrateUp. A file that
      // issues its own would end that transaction early and silently void the
      // all-or-nothing guarantee the module docstring promises.
      for (const [which, sql] of [['up', e.up], ['down', e.down]] as const) {
        if (sql !== undefined && managesItsOwnTransaction(sql)) {
          throw new Error(
            `Migration ${version}_${e.name} .${which}.sql manages its own transaction. ` +
              `The migrator wraps every file in BEGIN/COMMIT; remove the statement.`,
          )
        }
      }
      if (e.down === undefined) {
        throw new Error(
          `Migration ${version}_${e.name} has no .down.sql — every migration must be reversible (PROMPT.md §10)`,
        )
      }
      return {
        version,
        name: e.name,
        upSql: e.up,
        downSql: e.down,
        checksum: sha256(`${e.up}\n--DOWN--\n${e.down}`),
      }
    })
}

/**
 * Does this SQL issue its own transaction control?
 *
 * Dollar-quoted bodies and line comments are stripped first: a plpgsql
 * function body opens with BEGIN, which is a block, not a transaction —
 * `CREATE FUNCTION ... AS $$ BEGIN ... END; $$` must not trip this.
 */
export function managesItsOwnTransaction(sql: string): boolean {
  const stripped = sql
    // $$ ... $$ and $tag$ ... $tag$ (an unmatched group backreference matches
    // the empty string, which is what makes the untagged form work). Must run
    // first: a function body may legitimately contain any of the words below.
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/--[^\n]*/g, '') // line comments
    .replace(/'(?:[^']|'')*'/g, "''") // string literals, doubled quotes included

  // Split on statement boundaries rather than lines: anchoring to the start of
  // a LINE misses `CREATE TABLE t (x int); COMMIT;`, and matching anywhere
  // would trip on an identifier that merely contains the word.
  return stripped
    .split(';')
    .some((statement) => /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END)\s*$/i.test(statement))
}

const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  name       text NOT NULL,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`

export interface AppliedRow {
  version: string
  name: string
  checksum: string
}

async function ensureLedger(driver: MigrationDriver): Promise<void> {
  await driver.exec(LEDGER)
}

async function applied(driver: MigrationDriver): Promise<AppliedRow[]> {
  return driver.select<AppliedRow>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  )
}

/**
 * Refuse to proceed if a migration that is already applied has been edited
 * since. Silent drift between what ran and what is in the repo is how a
 * production schema stops matching the code that assumes it.
 */
function assertNoDrift(migrations: Migration[], rows: AppliedRow[]): void {
  const onDisk = new Map(migrations.map((m) => [m.version, m]))
  for (const row of rows) {
    const m = onDisk.get(row.version)
    if (!m) {
      throw new Error(
        `Migration ${row.version}_${row.name} is applied in the database but missing from the repo. ` +
          `Restore the file; never delete a shipped migration.`,
      )
    }
    if (m.checksum !== row.checksum) {
      throw new Error(
        `Migration ${row.version}_${m.name} has been edited since it was applied ` +
          `(checksum ${row.checksum.slice(0, 12)} -> ${m.checksum.slice(0, 12)}). ` +
          `Never edit a shipped migration (PROMPT.md §10) — add a new one instead.`,
      )
    }
  }
}

export interface MigrateResult {
  applied: string[]
  alreadyApplied: string[]
}

/** Apply every pending migration, oldest first. Each runs in its own transaction. */
export async function migrateUp(
  driver: MigrationDriver,
  migrations: Migration[],
  log: (msg: string) => void = () => {},
): Promise<MigrateResult> {
  await ensureLedger(driver)
  const rows = await applied(driver)
  assertNoDrift(migrations, rows)

  const done = new Set(rows.map((r) => r.version))
  const result: MigrateResult = { applied: [], alreadyApplied: [...done] }

  for (const m of migrations) {
    if (done.has(m.version)) continue
    log(`applying   ${m.version}_${m.name}`)
    await driver.exec('BEGIN')
    try {
      await driver.exec(m.upSql)
      await driver.select(
        `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
        [m.version, m.name, m.checksum],
      )
      await driver.exec('COMMIT')
      result.applied.push(m.version)
    } catch (err) {
      await driver.exec('ROLLBACK').catch(() => {})
      throw new Error(
        `Migration ${m.version}_${m.name} failed and was rolled back: ${(err as Error).message}`,
        { cause: err },
      )
    }
  }
  return result
}

/** What the CLI calls `MigrateDownOptions.restoresRevokedAccess`; the refusal names it. */
export const RESTORES_REVOKED_ACCESS_FLAG = '--restores-revoked-access'

export interface MigrateDownOptions {
  /**
   * Revert 0018 although some users have revoked access. Its down drops
   * `users.revoked_at`, and code from before 0018 has no notion of
   * revocation, so each of those people could sign in again. Off unless a
   * caller says so in so many words.
   */
  readonly restoresRevokedAccess?: boolean
}

/**
 * What a revert would silently undo that its down file cannot refuse on
 * its own — a shipped down file is never edited (§10), so the refusal lives
 * here, keyed by the version whose down does the damage. Each answers a
 * sentence when the revert must stop, or null.
 */
const DOWN_GUARDS: readonly {
  readonly version: string
  readonly allowedBy: keyof MigrateDownOptions
  readonly check: (driver: MigrationDriver, m: Migration, reverting: readonly Migration[]) => Promise<string | null>
}[] = [
  {
    version: '0018',
    allowedBy: 'restoresRevokedAccess',
    check: async (driver, m, reverting) => {
      // A revert that goes on to 0001 drops the users table itself: nobody
      // is let back in, because nobody is left. (Each migration is its own
      // transaction, so a down that fails part way is a broken database the
      // operator is already looking at, with the failing step named.)
      if (reverting.some((r) => r.version === '0001')) return null
      const [row] = await driver.select<{ n: number }>(
        'SELECT count(*)::int AS n FROM users WHERE revoked_at IS NOT NULL',
      )
      const n = row?.n ?? 0
      if (n === 0) return null
      return (
        `Reverting ${m.version}_${m.name} drops users.revoked_at, and ${n} ${n === 1 ? 'user has' : 'users have'} ` +
        `revoked access. Code from before ${m.version} has no notion of revocation, so ${n === 1 ? 'they' : 'each of them'} ` +
        `could request a sign-in link and sign in again. Older code keeps out only an address with no users row, so ` +
        `remove or re-address ${n === 1 ? 'that row' : 'those rows'} first, or pass ${RESTORES_REVOKED_ACCESS_FLAG} ` +
        `to revert anyway. Nothing was reverted.`
      )
    },
  },
]

/**
 * Roll back the most recent `steps` migrations, newest first.
 * `steps: 'all'` unwinds to an empty schema.
 *
 * Every guard on the way down is asked BEFORE anything is reverted, so a
 * refusal leaves the database exactly where it was rather than half way.
 */
export async function migrateDown(
  driver: MigrationDriver,
  migrations: Migration[],
  steps: number | 'all' = 1,
  log: (msg: string) => void = () => {},
  options: MigrateDownOptions = {},
): Promise<string[]> {
  await ensureLedger(driver)
  const rows = await applied(driver)
  assertNoDrift(migrations, rows)

  if (steps !== 'all' && (!Number.isInteger(steps) || steps < 1)) {
    // Array.slice treats a negative end index as an offset from the end, so an
    // unvalidated -1 would revert everything EXCEPT the newest migration.
    throw new Error(`migrateDown expects a positive integer or 'all', got ${String(steps)}`)
  }

  const byVersion = new Map(migrations.map((m) => [m.version, m]))
  const toUndo = rows
    .map((r) => {
      const m = byVersion.get(r.version)
      // assertNoDrift already rejects this, but the map lookup is what would
      // otherwise throw a bare TypeError three lines later.
      if (!m) throw new Error(`Migration ${r.version}_${r.name} is applied but missing from the repo`)
      return m
    })
    .sort((a, b) => b.version.localeCompare(a.version))
    .slice(0, steps === 'all' ? undefined : steps)

  for (const m of toUndo) {
    for (const guard of DOWN_GUARDS) {
      if (guard.version !== m.version || options[guard.allowedBy] === true) continue
      const refusal = await guard.check(driver, m, toUndo)
      if (refusal !== null) throw new Error(refusal)
    }
  }

  const undone: string[] = []
  for (const m of toUndo) {
    log(`reverting  ${m.version}_${m.name}`)
    await driver.exec('BEGIN')
    try {
      await driver.exec(m.downSql)
      await driver.select(`DELETE FROM schema_migrations WHERE version = $1`, [m.version])
      await driver.exec('COMMIT')
      undone.push(m.version)
    } catch (err) {
      await driver.exec('ROLLBACK').catch(() => {})
      throw new Error(
        `Rollback of ${m.version}_${m.name} failed and was itself rolled back: ${(err as Error).message}`,
        { cause: err },
      )
    }
  }
  return undone
}

export interface StatusRow {
  version: string
  name: string
  applied: boolean
}

export async function migrationStatus(
  driver: MigrationDriver,
  migrations: Migration[],
): Promise<StatusRow[]> {
  await ensureLedger(driver)
  const done = new Set((await applied(driver)).map((r) => r.version))
  return migrations.map((m) => ({ version: m.version, name: m.name, applied: done.has(m.version) }))
}
