import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '@agency/db/schema'
import { pgConnectionString } from '@agency/db/queries'
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
    // `sslmode=require` spelled as the `verify-full` pg already treats it as.
    connectionString: pgConnectionString(env().DATABASE_URL),
    max: env().DATABASE_POOL_MAX,
    /**
     * pg-pool treats an unset `connectionTimeoutMillis` as "wait forever". On
     * one long-lived server that is survivable — the wait ends when a client
     * is returned. On a serverless host it is not: every instance keeps its
     * own pool, they collectively exhaust the database's connection limit,
     * and each new request then hangs until the platform kills the function.
     * The user sees a timeout and the log says nothing at all about why.
     *
     * Ten seconds turns that into a real error with a real message, which is
     * the difference between an incident someone can diagnose and one they
     * cannot. It does NOT fix the exhaustion — that needs a small
     * DATABASE_POOL_MAX and a pooled connection string (see .env.example).
     */
    connectionTimeoutMillis: 10_000,
    /**
     * Release idle connections rather than holding one per instance forever.
     * Serverless instances are frozen between invocations and may never be
     * reused, so a connection held open is one the database counts and
     * nobody uses.
     */
    idleTimeoutMillis: 10_000,
  })

  /**
   * An idle connection dying is NORMAL against a managed database, and
   * without this line it arrives as an uncaught exception.
   *
   * pg-pool re-attaches an idle listener to every client it checks back in
   * (`_release` → `makeIdleListener`), and that listener ends in
   * `pool.emit('error', …)`. A managed Postgres closes idle connections on
   * its own schedule — Neon suspends the compute, PgBouncer reaps idle
   * servers — and pg turns the peer's clean FIN into `Connection terminated
   * unexpectedly`. Emitting `'error'` on an EventEmitter with no listener
   * THROWS, out of a socket callback, where no request can catch it.
   *
   * Review reproduced exactly that against a real Postgres wire connection
   * closed mid-idle, and then established that it does not kill this
   * deployment: Next installs a process-level `uncaughtException` handler
   * whose own comment is "we definitely shouldn't crash the entire process",
   * and the pool has already removed the dead client by the time it emits,
   * so the next request gets a fresh connection.
   *
   * This is here anyway. Relying on a framework's catch-all to swallow an
   * exception the code could simply handle means the log fills with
   * unexplained stack traces for an event that is not an error in the first
   * place — and it would become a real outage the day that handler changes.
   */
  globalForDb.__agencyPool.on('error', (err) => {
    // Not `console.error`: this is expected, and logging it as an error
    // trains people to ignore real ones. The pool has already dropped the
    // client; there is nothing to do but say so.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'idle database connection closed by the server',
        service: 'web',
        // The class only. A driver error can carry the DSN (§2.3).
        error: err instanceof Error ? err.name : 'UnknownError',
      }),
    )
  })

  return globalForDb.__agencyPool
}

/** Memoised drizzle client. Call inside a request or a callback, never at module scope. */
export function getDb(): NodePgDatabase<typeof schema> {
  globalForDb.__agencyDb ??= drizzle(pool(), { schema })
  return globalForDb.__agencyDb
}

export { schema }
