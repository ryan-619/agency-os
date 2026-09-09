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
 *   GET /readyz  the process can reach Postgres
 */
export interface HealthServer {
  server: Server
  close(): Promise<void>
}

export function startHealthServer(
  port: number,
  pool: () => Pool | null,
  log: Logger,
): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      })
      res.end(payload)
    }

    if (url === '/livez') return send(200, { status: 'ok', service: 'agent' })

    if (url === '/readyz') {
      const p = pool()
      if (!p) return send(503, { status: 'starting', service: 'agent', database: 'not connected' })
      void p
        .query('SELECT 1')
        .then(() => send(200, { status: 'ok', service: 'agent', database: 'ok' }))
        .catch((err: unknown) =>
          // Only the error class — a driver error can carry the DSN (§2.3).
          send(503, {
            status: 'degraded',
            service: 'agent',
            database: 'unreachable',
            error: err instanceof Error ? err.name : 'UnknownError',
          }),
        )
      return
    }

    send(404, { error: 'not found' })
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
