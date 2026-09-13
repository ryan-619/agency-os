/**
 * A Postgres on this machine, with no Postgres on this machine.
 *
 *   npm run db:local
 *
 * PGlite is a real Postgres compiled to WebAssembly, and `@electric-sql/pglite-
 * socket` puts a TCP listener in front of it. So the apps connect with an
 * ordinary `postgres://` URL and neither of them knows the difference — which
 * is the point: nothing in `apps/` or `packages/` may contain a branch for
 * "running locally".
 *
 * This exists because the documented path is `docker compose up`, and a
 * machine without Docker had no path at all. The data is kept in `.pgdata/`
 * so a restart does not lose the seed.
 *
 * ## What this is NOT
 *
 * It is not a Postgres for anything involving two connections, and the two
 * limitations were found by probing rather than by reasoning. Both fail
 * SILENTLY (CLAUDE.md §4 has the detail):
 *
 *  - **`NOTIFY` is dropped entirely.** The bridge has no notification handling
 *    at all, so a `LISTEN`-based design hangs here and works in production.
 *    The approval waiter polls, which is why it works either way.
 *  - **Advisory locks do not isolate.** Two `pg.Client`s both get
 *    `pg_try_advisory_lock(k) => true`, because the bridge multiplexes every
 *    TCP connection onto one PGlite backend and Postgres lets a session re-take
 *    a lock it already holds. So the single-worker lock does not exclude a
 *    second worker here, and two workers really do both start.
 *
 * Neither is worked around, and nothing is allowed to depend on them: the
 * restart reconciler is scoped by boot time rather than by the lock, for
 * exactly this reason.
 *
 * PGlite 0.5.8 also embeds Postgres 18.3, not the 16 that production runs —
 * so it is a LOOSER gate, and will accept PG17/PG18-only syntax that the
 * deploy target rejects. CI's `postgres16` job is what actually proves a
 * migration.
 */
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const DATA_DIR = resolve(process.cwd(), '.pgdata')
const PORT = Number(process.env['LOCAL_DB_PORT'] ?? 5432)
const HOST = '127.0.0.1'

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })

  // UTC, for the same reason `freshDb()` pins it in the test suite: without
  // it PGlite derives an `Etc/GMT±N` zone from the host clock and truncates to
  // whole hours, so a developer at +05:30 silently runs at +05:00.
  const db = await PGlite.create({ dataDir: DATA_DIR, defaults: { timezone: 'UTC' } })
  await db.waitReady

  const server = new PGLiteSocketServer({ db, port: PORT, host: HOST })
  await server.start()

  console.log(`
  A local Postgres is listening on ${HOST}:${PORT}.

    DATABASE_URL=postgres://agency:agency@${HOST}:${PORT}/postgres

  Any user and password are accepted — this listens on loopback only and is
  for development. Data lives in .pgdata/ and survives a restart.

  Next, in another terminal:
    npm run db:migrate
    npm run db:seed
    npm run dev

  Ctrl-C to stop.
`)

  const stop = async (signal: string): Promise<void> => {
    console.log(`\n  ${signal} — closing the database cleanly.`)
    try {
      await server.stop()
      await db.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  // EADDRINUSE is the one that happens repeatedly, and the default message
  // does not say which of the two likely causes it is.
  if (message.includes('EADDRINUSE')) {
    console.error(
      `\n  Port ${PORT} is already in use — either this is already running, or something else ` +
        `is on that port.\n  Set LOCAL_DB_PORT to use a different one.\n`,
    )
    process.exit(1)
  }
  console.error(`\n  Could not start the local database: ${message}\n`)
  process.exit(1)
})
