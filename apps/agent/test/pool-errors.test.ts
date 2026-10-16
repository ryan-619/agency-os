/**
 * A dropped idle database connection is a log line, not the end of the worker.
 *
 * On 2026-10-06 the worker died with `read EADDRNOTAVAIL`, "Emitted 'error'
 * event on BoundPool instance": the Mac's network changed under a client
 * sitting idle in the pool, pg-pool emitted 'error', nothing listened, and
 * Node threw it out of the process — chat, sending and reply-reading with it.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { watchIdleConnections } from '../src/boot/pool-errors.js'
import { NETWORK_HINT } from '../src/log-fields.js'
import type { Logger } from '../src/logger.js'

function captureLog(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...fields })
  }
  return { log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

/** What pg-pool emits for an idle client whose socket failed. Nothing connects: a Pool opens no socket until asked. */
const idleDrop = (): Error =>
  Object.assign(new Error('read EADDRNOTAVAIL'), { errno: -49, code: 'EADDRNOTAVAIL', syscall: 'read' })
const pool = (): Pool => new Pool({ connectionString: 'postgres://nobody:not-a-secret@127.0.0.1:1/none', max: 1 })

describe('watchIdleConnections', () => {
  it('the premise: a pool nobody listens to throws the event out of whatever emitted it', async () => {
    const bare = pool()
    expect(() => bare.emit('error', idleDrop())).toThrow('read EADDRNOTAVAIL')
    await bare.end()
  })

  it('logs the dropped connection by class and code, says it was the network, and throws nothing', async () => {
    const watched = pool()
    const { log, lines } = captureLog()
    watchIdleConnections(watched, log)
    expect(() => watched.emit('error', idleDrop())).not.toThrow()
    expect(lines).toEqual([
      {
        level: 'warn',
        msg: 'an idle database connection dropped; the pool opens a new one when it is next needed',
        error: 'Error',
        code: 'EADDRNOTAVAIL',
        hint: NETWORK_HINT,
      },
    ])
    await watched.end()
  })

  it('never logs the message, and drops a code that is not a bare token', async () => {
    const watched = pool()
    const { log, lines } = captureLog()
    watchIdleConnections(watched, log)
    watched.emit('error', Object.assign(new Error('server said: password authentication failed for user x'), { code: 'not a token' }))
    expect(lines).toEqual([expect.not.objectContaining({ code: expect.anything() })])
    expect(JSON.stringify(lines)).not.toContain('password')
    await watched.end()
  })

  it('is wired where the worker builds its pool', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/worker.ts'), 'utf8')
    expect(source).toMatch(/pool = new Pool\([^)]*\)\n\s*watchIdleConnections\(pool, log\)/)
  })
})
