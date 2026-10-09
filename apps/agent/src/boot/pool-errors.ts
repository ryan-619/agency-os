import type { Pool } from 'pg'
import type { Logger } from '../logger.js'
import { faultFields } from '../log-fields.js'

/**
 * Hear the pool's own 'error' event, so a dropped idle connection is a log
 * line rather than the end of the worker.
 *
 * pg-pool emits 'error' when a client sitting IDLE in the pool loses its
 * connection — the network changed under it (`read EADDRNOTAVAIL` as a laptop
 * moves between networks or wakes from sleep), or the server ended it — and
 * Node throws an 'error' event nobody listens for out of the process. On
 * 2026-10-06 that took the worker down, and chat, sending and reply-reading
 * with it. The pool has already discarded that client, and the next query
 * opens a fresh one, so saying so is all there is to do: the web app's and
 * the voice service's pools have done this all along.
 *
 * The error's class and its code — never its message, which for a server's
 * error can quote what it was given.
 */
export function watchIdleConnections(pool: Pool, log: Logger): void {
  pool.on('error', (err: Error) => {
    log.warn('an idle database connection dropped; the pool opens a new one when it is next needed', faultFields(err))
  })
}
