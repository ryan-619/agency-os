/**
 * Adapters that put a real Postgres connection and an in-process PGlite
 * instance behind the same tiny interface the migrator needs.
 *
 * Production runs Postgres 16 in Docker (PROMPT.md §3). Tests run PGlite, an
 * embedded Postgres build, so `npm test` needs neither Docker nor a database
 * server. CI additionally runs the same migrations against a real postgres:16
 * service container — see .github/workflows/ci.yml — because PGlite tracks a
 * different Postgres major and passing on one is not proof of the other.
 */
import type { MigrationDriver } from './migrator.js'

/** Structural type for a node-postgres Client, so this file needs no pg import. */
interface PgLikeClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
  end?(): Promise<void>
}

/** Structural type for a PGlite instance. */
interface PgliteLike {
  exec(sql: string): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  close?(): Promise<void>
}

/**
 * Wrap a node-postgres Client.
 *
 * Must be a Client, not a Pool: the migrator issues BEGIN and COMMIT as separate
 * statements, and a Pool may hand each one to a different backend, silently
 * running migrations outside a transaction.
 */
export function pgDriver(client: PgLikeClient): MigrationDriver {
  return {
    async exec(sql) {
      // No values argument, so node-postgres uses the simple query protocol,
      // which accepts several statements separated by semicolons.
      await client.query(sql)
    },
    async select<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params)
      return res.rows as T[]
    },
  }
}

/** Wrap a PGlite instance. */
export function pgliteDriver(db: PgliteLike): MigrationDriver {
  return {
    async exec(sql) {
      await db.exec(sql)
    },
    async select<T>(sql: string, params: unknown[] = []) {
      const res = await db.query(sql, params)
      return res.rows as T[]
    },
  }
}
