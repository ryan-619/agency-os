/**
 * The voice service's entrypoint.
 *
 * Separate from `index.ts` so that starting the service is something a
 * caller DOES rather than something importing the module causes. It used
 * to run `main()` at module scope, which meant nothing could import
 * `index.ts` — a test, a script, a healthcheck — without booting a real
 * server against a real pool and, on failure, calling `process.exit(1)`
 * out from under whatever imported it. `apps/voice/test/service.test.ts`
 * is what the split is for.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { schema, type AgencyDb } from '@agency/db'
import { loadEnv } from './env.js'
import { createLogger } from './logger.js'
import { llmFromEnv, startVoiceService } from './index.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const log = createLogger(env.LOG_LEVEL)

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 10_000,
  })
  // Same reasoning as the web app's pool: an idle connection closed by a
  // managed database emits 'error' on the pool, and an emit with no
  // listener throws out of a socket callback.
  pool.on('error', (err) => log.warn('idle database connection closed', { error: err.name }))
  const db = drizzle(pool, { schema }) as unknown as AgencyDb

  const service = await startVoiceService({
    env, db, log, ping: () => pool.query('SELECT 1'), llm: llmFromEnv(env, log),
  })

  const stop = (signal: string): void => {
    log.info('shutting down', { signal })
    void service.close().then(() => pool.end()).finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

main().catch((err: unknown) => {
  // Never the message: a driver or config error can carry a credential (§2.3).
  console.error(JSON.stringify({
    level: 'error', msg: 'voice service failed to start', service: 'voice',
    error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'UnknownError',
  }))
  process.exit(1)
})
