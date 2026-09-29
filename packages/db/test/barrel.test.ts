/**
 * The two barrels split on purpose (§2.3).
 *
 * `queries.ts` is what the web bundle imports. A web bundle that could write
 * a heartbeat is a fake-liveness oracle — `/api/health` would report a
 * worker that the bundle itself invented — and a bundle that could mint an
 * unsubscribe token could unsubscribe anyone. Both writers are exported from
 * the package root, which only the CLIs and the worker import.
 *
 * Asserted from the SOURCE and from the runtime, because the source check
 * would pass on a stub that exported nothing and the runtime check alone
 * would not say which line to fix.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as q from '../src/queries.js'
import * as all from '../src/index.js'

const src = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', name), 'utf8')

describe('the barrels', () => {
  it('keep the heartbeat writer and the unsubscribe minter out of the web bundle', () => {
    const queries = src('queries.ts')
    const index = src('index.ts')
    // The export LINE, not the module name: queries.ts names both modules in
    // the comment that says why they are absent.
    expect(queries).not.toContain("export * from './heartbeat.js'")
    expect(queries).not.toContain("export * from './unsubscribe-mint.js'")
    expect(index).toContain("export * from './heartbeat.js'")
    expect(index).toContain("export * from './unsubscribe-mint.js'")
  })

  it('export the writers from the root and not from queries, at runtime', () => {
    expect('writeHeartbeat' in all).toBe(true)
    expect('writeHeartbeat' in q).toBe(false)
    expect('unsubscribeToken' in all).toBe(true)
    expect('unsubscribeToken' in q).toBe(false)
  })

  it('export the readers and the verifier from both', () => {
    const queries = src('queries.ts')
    for (const mod of ['heartbeat-read', 'unsubscribe', 'send-preview', 'pg-errors']) {
      expect(queries, mod).toContain(`export * from './${mod}.js'`)
      expect(src('index.ts'), mod).toContain(`export * from './${mod}.js'`)
    }
    expect('previewSend' in q && 'previewSend' in all).toBe(true)
    expect('isUniqueViolation' in q && 'isUniqueViolation' in all).toBe(true)
  })

  it('keep the mail transport out of the web bundle, as before', () => {
    expect(src('queries.ts')).not.toContain("export * from './smtp.js'")
    expect('createSmtpProvider' in q).toBe(false)
    expect('createSmtpProvider' in all).toBe(true)
  })

  /**
   * Every module the registry names is exported from queries.ts, so a later
   * feature replaces its stub and adds no line to either barrel.
   */
  it('already export every planned module', () => {
    const queries = src('queries.ts')
    for (const mod of [
      'contacts-ledger', 'contacts-import', 'companies', 'evidence', 'rescan', 'audit', 'credentials',
      'heartbeat-read', 'inbox', 'enrolment', 'search', 'analytics', 'chat-threads', 'exports', 'users',
      'compliance', 'notes', 'tasks', 'unsubscribe', 'icp-profiles', 'spend', 'digest', 'linkedin-step',
      'proposal-shares', 'erasure', 'connector-tools',
    ]) {
      expect(queries, mod).toContain(`export * from './${mod}.js'`)
    }
  })
})
