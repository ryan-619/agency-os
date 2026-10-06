/**
 * The worker's view of itself reaches chat's ops tools — and is the view
 * `/readyz` and the heartbeat give, not a second one.
 *
 * `opsContextFrom` is tested by behaviour: it reads `healthInputs()` fresh on
 * every call, so the halt, the lock and the heartbeat it reports are the
 * ones `/readyz` would answer with at that moment. The scanner it carries is
 * bound to the nightly rescan's timeouts, which no caller can widen. And the
 * wiring itself — `startWorker` wrapping its logger and building the context
 * after the lock, `buildTurnRuntime` handing it to every turn's tools — is
 * pinned by reading the source, as the rest of this suite pins `worker.ts`,
 * because booting a worker needs a database and a lock.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RESCAN_SCAN_TIMEOUTS } from '@agency/db'
import { TOOL_TIME_BUDGET_MS, type OpsScan } from '@agency/tools'
import type { IcpDefinition, SiteProfile } from '@agency/core'
import { opsContextFrom, withRescanTimeouts, type ScanDomain } from '../src/ops/context.js'
import { createRecentLog } from '../src/ops/recent-log.js'
import { TOOL_TIMEOUT_MS } from '../src/mcp/agency.js'
import type { HealthInputs } from '../src/health.js'

const BOOTED = new Date('2026-10-06T05:00:00.000Z')
const definition = {} as IcpDefinition
const profile = { domain: 'acme.io' } as SiteProfile

describe('opsContextFrom', () => {
  it('reports what /readyz answers from, read fresh on every call', () => {
    let inputs: HealthInputs = {
      pool: null, halted: false, chatEnabled: true, lockHeld: true, outreach: 'send-only', heartbeatAt: null,
    }
    const ops = opsContextFrom({
      health: () => inputs, sms: 'off', bootedAt: BOOTED, version: null, recentLog: createRecentLog(),
    })
    expect(ops.health()).toEqual({
      halted: false, lockHeld: true, outreach: 'send-only', sms: 'off', chat: 'enabled',
      bootedAt: BOOTED, version: null, heartbeatWrittenAt: null,
    })

    const beat = new Date('2026-10-06T06:00:00.000Z')
    inputs = { ...inputs, halted: true, chatEnabled: false, lockHeld: false, outreach: 'disabled', heartbeatAt: beat }
    expect(ops.health()).toMatchObject({
      halted: true, chat: 'disabled', lockHeld: false, outreach: 'disabled', heartbeatWrittenAt: beat,
    })
  })

  it('carries no pool, host or credential — only the facts the ops tools say', () => {
    const ops = opsContextFrom({
      health: () => ({ pool: {} as never, halted: false, chatEnabled: true, lockHeld: null, outreach: 'disabled', heartbeatAt: null }),
      sms: 'on', bootedAt: BOOTED, version: '0.1.0', recentLog: createRecentLog(),
    })
    expect(Object.keys(ops.health()).sort()).toEqual(
      ['bootedAt', 'chat', 'halted', 'heartbeatWrittenAt', 'lockHeld', 'outreach', 'sms', 'version'],
    )
  })

  it('reads the worker’s ring live, not a copy taken at boot', () => {
    const ring = createRecentLog()
    const ops = opsContextFrom({
      health: () => ({ pool: null, halted: false, chatEnabled: true, lockHeld: true, outreach: 'disabled', heartbeatAt: null }),
      sms: 'off', bootedAt: BOOTED, version: null, recentLog: ring,
    })
    expect(ops.recentLog()).toEqual([])
    ring.record('error', 'agency tool threw', { error: 'TypeError' })
    expect(ops.recentLog().map((e) => [e.msg, e.error])).toEqual([['agency tool threw', 'TypeError']])
  })

  it('carries a scanner — the real one, bound to the nightly timeouts, unless one is handed in', async () => {
    const ring = createRecentLog()
    const health = () => ({ pool: null, halted: false, chatEnabled: true, lockHeld: true, outreach: 'disabled' as const, heartbeatAt: null })
    expect(typeof opsContextFrom({ health, sms: 'off', bootedAt: BOOTED, version: null, recentLog: ring }).scan).toBe('function')
    const fake: OpsScan = async () => ({ raw: {}, profile })
    expect(opsContextFrom({ health, sms: 'off', bootedAt: BOOTED, version: null, recentLog: ring, scan: fake }).scan).toBe(fake)
  })
})

describe('withRescanTimeouts', () => {
  it('hands the scanner the nightly rescan’s timeouts, last, so no caller can widen them', async () => {
    const seen: Array<Parameters<ScanDomain>> = []
    const scan = withRescanTimeouts(async (...args) => {
      seen.push(args)
      return { raw: {}, profile }
    })
    await scan('acme.io', definition, { company: 'Acme' })
    await scan('beta.io', definition, { company: 'Beta', homeTimeoutMs: 120_000, pathTimeoutMs: 90_000 } as never)
    expect(seen).toEqual([
      ['acme.io', definition, { company: 'Acme', homeTimeoutMs: 8_000, pathTimeoutMs: 6_000 }],
      ['beta.io', definition, { company: 'Beta', homeTimeoutMs: 8_000, pathTimeoutMs: 6_000 }],
    ])
    expect(RESCAN_SCAN_TIMEOUTS).toEqual({ homeTimeoutMs: 8_000, pathTimeoutMs: 6_000 })
  })
})

describe('the time a tool may spend', () => {
  /**
   * A call the adapter cuts off at 30 s tells the model nothing, so a tool
   * that waits on the network answers inside its own budget — with room for
   * its audit row and its words after the deadline.
   */
  it('leaves rescan_stale room to answer before the adapter’s hard limit', () => {
    expect(TOOL_TIME_BUDGET_MS).toBeGreaterThan(0)
    expect(TOOL_TIMEOUT_MS - TOOL_TIME_BUDGET_MS).toBeGreaterThanOrEqual(3_000)
  })
})

describe('the wiring', () => {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

  it('startWorker logs through the recording wrapper from its first line, and nowhere around it', () => {
    const worker = read('worker.ts')
    const body = worker.slice(worker.indexOf('export async function startWorker'))
    const wrapped = body.indexOf('const log = recordingLogger(deps.log, recentLog)')
    expect(wrapped).toBeGreaterThan(-1)
    // Nothing logs before the wrapper exists, and nothing reaches past it.
    expect(body.slice(0, wrapped)).not.toMatch(/\blog\.(debug|info|warn|error)\(/)
    expect(worker.match(/deps\.log\b/g)).toHaveLength(1)
  })

  it('startWorker builds the context after the lock, from healthInputs, and hands it to every turn', () => {
    const worker = read('worker.ts')
    const built = worker.indexOf('opsContextFrom({')
    expect(built).toBeGreaterThan(worker.indexOf('const bootAt = new Date()'))
    expect(built).toBeGreaterThan(worker.indexOf('acquireWorkerLock('))
    expect(built).toBeLessThan(worker.indexOf('createAgentHttpServer('))
    const call = worker.slice(built, worker.indexOf('})', built))
    expect(call).toMatch(/health: healthInputs/)
    expect(call).toMatch(/bootedAt: bootAt/)
    expect(call).toMatch(/sms: senders\.sms/)
    expect(call).toMatch(/recentLog/)
    expect(worker).toMatch(/beginTurn\(\{[^}]*\bops\b[^}]*\}\)/)
    const runtime = worker.slice(worker.indexOf('await buildTurnRuntime('))
    expect(runtime.slice(0, runtime.indexOf('},'))).toMatch(/\bops,/)
  })

  it('buildTurnRuntime puts the worker’s view in every tool context, from its deps and never from an argument', () => {
    const session = read('runtime/session.ts')
    const context = session.slice(session.indexOf('const toolContext = (): ToolContext => ({'))
    const body = context.slice(0, context.indexOf('createAgencyMcpServer('))
    expect(body).toMatch(/\.\.\.\(deps\.ops \? \{ ops: deps\.ops \} : \{\}\)/)
    expect(body).toMatch(/orgId: args\.orgId/)
    expect(session).not.toMatch(/args\.ops/)
  })
})
