import { Pool } from 'pg'
import { loadEnv } from './env.js'
import { createLogger } from './logger.js'
import { startHealthServer } from './health.js'

/**
 * The agent worker.
 *
 * PROMPT.md §3 keeps this a separate long-running process so the web app never
 * blocks on an agent turn. In Phase 0 it does exactly three things: validate
 * its configuration, prove it can reach Postgres, and answer health checks.
 *
 * The `query()` loop from @anthropic-ai/claude-agent-sdk, the in-process
 * `agency` MCP server, the canUseTool approval gate and SSE streaming all land
 * in Phase 2. They are deliberately absent rather than stubbed: a stub that
 * looks like an agent is worse than an honest empty process.
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const log = createLogger(env.LOG_LEVEL)

  let pool: Pool | null = null
  // Health first, so /livez answers while Postgres is still connecting.
  const health = await startHealthServer(env.AGENT_PORT, () => pool, log)

  pool = new Pool({ connectionString: env.DATABASE_URL, max: 4 })

  try {
    const { rows } = await pool.query<{ n: number }>('SELECT 1 AS n')
    log.info('database reachable', { probe: rows[0]?.n })
  } catch (err) {
    log.error('database unreachable at startup', {
      error: err instanceof Error ? err.name : 'UnknownError',
    })
    // Not fatal: /readyz reports the truth and the orchestrator decides.
  }

  if (!env.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY is not set — the agent runtime lands in Phase 2')
  }

  log.info('agent worker started', { nodeEnv: env.NODE_ENV, port: env.AGENT_PORT })

  // --- graceful shutdown ---------------------------------------------------
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal })
    try {
      await health.close()
      await pool?.end()
      log.info('shutdown complete')
      process.exit(0)
    } catch (err) {
      log.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) })
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  // Startup failure. Print the message only; env errors name variables, not values.
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'agent',
      msg: 'failed to start',
      error: err instanceof Error ? err.message : String(err),
      time: new Date().toISOString(),
    }),
  )
  process.exit(1)
})
