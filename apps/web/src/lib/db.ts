import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '@agency/db/schema'
import { env } from '@/lib/env'

/**
 * The database client, created on first use — never at module load.
 *
 * This laziness is load-bearing, not stylistic. `next build` evaluates route
 * modules while collecting page data, so anything this module does at import
 * time runs during the BUILD. Constructing the pool eagerly meant calling
 * env(), which throws when DATABASE_URL/AUTH_SECRET/SMTP_HOST are absent — so
 * the image build failed with "Failed to collect page data for /api/health"
 * unless production secrets were passed to `docker build`. An image build must
 * not need runtime secrets.
 *
 * The schema import is the `@agency/db/schema` subpath rather than the package
 * index: the index also exports the migrator, which resolves migration files
 * on disk via import.meta.url, and the bundler has no business tracing into it.
 */
const globalForDb = globalThis as unknown as {
  __agencyPool?: Pool
  __agencyDb?: NodePgDatabase<typeof schema>
}

function pool(): Pool {
  // One pool per process. Stashed on globalThis so Next's dev server does not
  // leak a pool on every hot reload.
  globalForDb.__agencyPool ??= new Pool({
    connectionString: env().DATABASE_URL,
    max: env().DATABASE_POOL_MAX,
  })
  return globalForDb.__agencyPool
}

/** Memoised drizzle client. Call inside a request or a callback, never at module scope. */
export function getDb(): NodePgDatabase<typeof schema> {
  globalForDb.__agencyDb ??= drizzle(pool(), { schema })
  return globalForDb.__agencyDb
}

export { schema }
