import { createServer, type Server } from 'node:http'
import type { Pool } from 'pg'
import type { Logger } from './logger.js'

/**
 * A dependency-free health endpoint on node:http.
 *
 * Started BEFORE the database connection so that an orchestrator gets an
 * answer from /livez while the worker is still coming up, rather than a
 * connection-refused it will interpret as a crash loop.
 *
 *   GET /livez   the process is running
 *   GET /readyz  the process can reach Postgres, and the gate is intact
 *
 * The worker serves this on two ports — AGENT_PORT here, and the internal API
 * port alongside the turn endpoints — and `answerHealth` below is the ONE
 * implementation both use. They used to be two, and they disagreed about the
 * thing that matters most: a halted runtime reported 503 on the API port and a
 * cheerful 200 here, on the port an orchestrator and a container healthcheck
 * actually probe. A gate that was bypassed would have gone unnoticed by
 * exactly the machinery that exists to notice.
 */
export interface HealthServer {
  server: Server
  close(): Promise<void>
}

/**
 * Everything /readyz reports, gathered at request time.
 *
 * A function rather than values because the health server starts before any of
 * it exists — the whole point of answering /livez during boot — and because
 * every one of these can change while the process runs.
 */
export interface HealthInputs {
  readonly pool: Pool | null
  /** The gate's latched halt: a tool ran that was never authorised (§2.4). */
  readonly halted: boolean
  readonly chatEnabled: boolean
  /**
   * Is the single-worker advisory lock still held? Null before it is taken.
   * False means the lock connection dropped and another worker can now start.
   */
  readonly lockHeld: boolean | null
}

export async function answerHealth(
  url: string,
  inputs: HealthInputs,
): Promise<{ status: number; body: unknown } | null> {
  if (url !== '/livez' && url !== '/readyz') return null
  if (url === '/livez') return { status: 200, body: { status: 'ok', service: 'agent' } }

  if (!inputs.pool) {
    return { status: 503, body: { status: 'starting', service: 'agent', database: 'not connected' } }
  }

  try {
    await inputs.pool.query('SELECT 1')
  } catch (err) {
    // Only the error class: a driver error can carry the DSN (§2.3).
    return {
      status: 503,
      body: {
        status: 'degraded',
        service: 'agent',
        database: 'unreachable',
        error: err instanceof Error ? err.name : 'UnknownError',
      },
    }
  }

  // A halted runtime is NOT ready. It still answers, and it says why — an
  // orchestrator restarting it is the correct response to a gate that was
  // bypassed.
  return {
    status: inputs.halted ? 503 : 200,
    body: {
      status: inputs.halted ? 'halted' : 'ok',
      service: 'agent',
      database: 'ok',
      chat: inputs.chatEnabled ? 'enabled' : 'disabled',
      // Reported rather than made fatal. The restart reconciler is scoped by
      // boot time, so a lock lost mid-run does not endanger live turns — but
      // the exclusion is gone until someone restarts, and that should be
      // visible rather than inferred.
      ...(inputs.lockHeld === false ? { workerLock: 'lost' } : {}),
    },
  }
}

export function startHealthServer(
  port: number,
  inputs: () => HealthInputs,
  log: Logger,
): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      })
      res.end(payload)
    }

    void answerHealth(req.url ?? '/', inputs())
      .then((answer) => {
        if (answer) send(answer.status, answer.body)
        else send(404, { error: 'not found' })
      })
      .catch(() => {
        send(503, { status: 'degraded', service: 'agent' })
      })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      log.info('health server listening', { port })
      resolve({
        server,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}
