import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '@agency/db/schema'
import { env } from '@/lib/env'

/**
 * Note the import above is the `@agency/db/schema` subpath, not the package
 * index. The index also exports the migrator, which reaches for migration
 * files on disk via import.meta.url — server tooling the web bundle has no
 * business tracing into.
 *
 * One pool per process. Next's dev server re-evaluates modules on change, so
 * the pool is stashed on globalThis to avoid leaking a connection pool per
 * hot reload — the standard Next + node-postgres arrangement.
 */
const globalForDb = globalThis as unknown as { __agencyPool?: Pool }

function pool(): Pool {
  globalForDb.__agencyPool ??= new Pool({
    connectionString: env().DATABASE_URL,
    max: 10,
  })
  return globalForDb.__agencyPool
}

export const db = drizzle(pool(), { schema })
export { schema }
