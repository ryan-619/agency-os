/**
 * The agent worker's entrypoint.
 *
 * Separate from `worker.ts` so that starting the worker is something a
 * caller DOES rather than something importing the module causes. This file
 * used to BE the worker and call `main()` at module scope, so nothing could
 * import it — a test, a script — without booting a health server, a pool
 * and an advisory lock against a real database and, on failure, calling
 * `process.exit(1)` out from under whatever imported it. The voice service
 * was split the same way (`apps/voice/src/main.ts`).
 *
 * It keeps the name `index.ts` because every way the worker is started names
 * it: the image's `CMD ["node", "apps/agent/dist/index.js"]`, the package's
 * `start` and `dev` scripts, `tools/run-worker.sh` and `tools/smoke-agent.ts`.
 * Moving the entry would have meant moving all of those with it; moving the
 * worker out from under the entry moves none of them.
 *
 * What stays here is what belongs to the PROCESS: reading the environment,
 * the signals, and the exit code.
 */
import { loadEnv } from './env.js'
import { createLogger } from './logger.js'
import { startWorker } from './worker.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const log = createLogger(env.LOG_LEVEL)
  const worker = await startWorker({ env, log })

  // `stop` is memoised, so a SIGINT after a SIGTERM waits on the same stop
  // rather than exiting beside it with a message still on its way out.
  const onSignal = (signal: string): void => {
    worker.stop(signal).then(
      () => process.exit(0),
      // Already logged by the worker, with what failed.
      () => process.exit(1),
    )
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}

main().catch((err: unknown) => {
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
