/**
 * The heartbeat loop (§2.4).
 *
 * `packages/db/test/heartbeat.test.ts` proves the row: one per worker, moved
 * every write, refused when its instants disagree. This proves the loop
 * around it — that a worker writes as soon as it has booted and then once
 * per tick, that a failing write is logged by its class and SURVIVED (a
 * worker that stops because its heartbeat table is missing is the
 * enforcement `/api/health` refuses to do), and that stop() waits for the
 * write in flight and writes nothing after it.
 *
 * The timing tests drive fake timers against a stand-in for the writer so
 * every instant is exact. The last two run the real writer against a real
 * engine, including one with the table gone — the "0018 was never applied"
 * deployment, which is the failure this loop is most likely to meet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import type { Pool } from 'pg'
import { readLatestHeartbeat, schema, writeHeartbeat, type AgencyDb } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { lastHeartbeatAt, startHeartbeat, type HeartbeatDeps, type HeartbeatInputs } from '../src/boot/heartbeat.js'
import { answerHealth } from '../src/health.js'
import type { Logger } from '../src/logger.js'

vi.mock('@agency/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agency/db')>()
  return { ...actual, writeHeartbeat: vi.fn(actual.writeHeartbeat) }
})

const write = vi.mocked(writeHeartbeat)
const BOOT = new Date('2026-09-15T12:00:00.000Z')
const TICK = 15_000

interface Line { level: string; msg: string; fields: Record<string, unknown> | undefined }

function capture(): { log: Logger; lines: Line[] } {
  const lines: Line[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields })
  }
  return { log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A driver error that carries the DSN in its message, the way real ones do. */
class DatabaseError extends Error {
  override name = 'DatabaseError'
}
const leaky = () => new DatabaseError('connect ECONNREFUSED postgres://agency:hunter2@db.internal:5432/agency')

const steady = (): HeartbeatInputs => ({
  outreach: 'send-only',
  chat: 'disabled',
  detail: { halted: false, lockHeld: true },
})

describe('the heartbeat loop', () => {
  let log: Logger
  let lines: Line[]
  const stops: (() => Promise<void>)[] = []

  const start = (over: Partial<HeartbeatDeps> = {}) => {
    const stop = startHeartbeat({
      db: {} as AgencyDb,
      log,
      intervalMs: TICK,
      workerId: 'test-host:42',
      bootedAt: BOOT,
      inputs: steady,
      ...over,
    })
    stops.push(stop)
    return stop
  }
  const at = (ms: number) => new Date(BOOT.getTime() + ms)
  const written = () => write.mock.calls.map((c) => c[1])

  beforeEach(() => {
    vi.useFakeTimers({ now: BOOT })
    write.mockReset()
    write.mockResolvedValue(undefined)
    ;({ log, lines } = capture())
  })

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((s) => s()))
    vi.useRealTimers()
  })

  it('writes as soon as it starts, then once per tick', async () => {
    start()
    expect(write).toHaveBeenCalledTimes(1)
    expect(written()[0]).toEqual({
      workerId: 'test-host:42',
      bootedAt: BOOT,
      lastTickAt: BOOT,
      outreach: 'send-only',
      chat: 'disabled',
      detail: expect.objectContaining({ halted: false, lockHeld: true, intervalMs: TICK }),
    })
    // Present even when null: a row that says nothing about its version is
    // a different fact from one that says it does not know.
    expect(written()[0]!.detail).toHaveProperty('version')

    await vi.advanceTimersByTimeAsync(TICK)
    expect(write).toHaveBeenCalledTimes(2)
    expect(written()[1]!.lastTickAt).toEqual(at(TICK))
    expect(lastHeartbeatAt()).toEqual(at(TICK))

    await vi.advanceTimersByTimeAsync(2 * TICK)
    expect(write).toHaveBeenCalledTimes(4)
    expect(lastHeartbeatAt()).toEqual(at(3 * TICK))
  })

  it('reads the inputs fresh at every write, so the row cannot lag /readyz', async () => {
    let halted = false
    start({ inputs: () => ({ ...steady(), chat: halted ? 'disabled' : 'enabled', detail: { halted, lockHeld: true } }) })
    halted = true
    await vi.advanceTimersByTimeAsync(TICK)
    expect(written()[0]).toMatchObject({ chat: 'enabled', detail: { halted: false } })
    expect(written()[1]).toMatchObject({ chat: 'disabled', detail: { halted: true } })
  })

  it('does not let the inputs overwrite the interval it reports', () => {
    start({ inputs: () => ({ ...steady(), detail: { intervalMs: 1 } }) })
    expect(written()[0]!.detail).toMatchObject({ intervalMs: TICK })
  })

  it('logs a failing write by its class alone, and keeps going', async () => {
    const before = lastHeartbeatAt()
    write.mockRejectedValueOnce(leaky()).mockRejectedValueOnce(leaky())
    start()
    await vi.advanceTimersByTimeAsync(0)

    // Failed: logged by name, and /readyz's time did not move.
    expect(lastHeartbeatAt()).toEqual(before)
    const warned = lines.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]!.fields).toEqual({ workerId: 'test-host:42', error: 'DatabaseError' })
    expect(JSON.stringify(lines)).not.toContain('hunter2')
    expect(JSON.stringify(lines)).not.toContain('ECONNREFUSED')

    // The loop continued. The same failure again is counted, not re-logged.
    await vi.advanceTimersByTimeAsync(TICK)
    expect(write).toHaveBeenCalledTimes(2)
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)

    // And it recovers, saying so once, with how many writes were lost.
    await vi.advanceTimersByTimeAsync(TICK)
    expect(write).toHaveBeenCalledTimes(3)
    expect(lastHeartbeatAt()).toEqual(at(2 * TICK))
    expect(lines.filter((l) => l.msg === 'heartbeat written again')).toEqual([
      { level: 'info', msg: 'heartbeat written again', fields: { workerId: 'test-host:42', failedWrites: 2 } },
    ])
  })

  it('logs again when the cause of a failure streak changes', async () => {
    class CheckViolation extends Error {
      override name = 'CheckViolation'
    }
    write.mockRejectedValueOnce(leaky()).mockRejectedValueOnce(new CheckViolation('x'))
    start()
    await vi.advanceTimersByTimeAsync(TICK)
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.fields?.['error'])).toEqual([
      'DatabaseError',
      'CheckViolation',
    ])
  })

  it('survives inputs that throw, as a failed write', async () => {
    start({
      inputs: () => {
        throw new TypeError('no')
      },
    })
    await vi.advanceTimersByTimeAsync(TICK)
    expect(write).not.toHaveBeenCalled()
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.fields?.['error'])).toEqual(['TypeError'])
  })

  it('never overlaps or stacks writes behind a slow one', async () => {
    const slow = deferred()
    write.mockImplementationOnce(() => slow.promise)
    start()
    await vi.advanceTimersByTimeAsync(3 * TICK)
    expect(write).toHaveBeenCalledTimes(1)

    slow.resolve()
    await vi.advanceTimersByTimeAsync(0)
    // No burst on recovery: the skipped ticks stay skipped.
    expect(write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TICK)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('stop() waits for the write in flight, and nothing is written after it', async () => {
    const slow = deferred()
    write.mockImplementationOnce(() => slow.promise)
    const stop = start()

    let stopped = false
    const done = stop().then(() => {
      stopped = true
    })
    // Memoised: a second caller waits on the same shutdown.
    expect(stop()).toBe(stop())

    await vi.advanceTimersByTimeAsync(4 * TICK)
    expect(stopped).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)

    slow.resolve()
    await done
    expect(stopped).toBe(true)
    // The write that stop() waited for DID land, and says so.
    expect(lastHeartbeatAt()).toEqual(BOOT)

    await vi.advanceTimersByTimeAsync(10 * TICK)
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('the heartbeat against a real engine', () => {
  let test: TestDb
  let db: AgencyDb

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@agency/db')>('@agency/db')
    write.mockReset()
    write.mockImplementation(actual.writeHeartbeat)
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const run = (log: Logger, bootedAt = new Date(Date.now() - 1000)) =>
    startHeartbeat({
      db,
      log,
      // Long enough that only the write on start happens inside the test.
      intervalMs: 60 * 60_000,
      workerId: 'real-host:7',
      bootedAt,
      inputs: steady,
    })

  it('writes the row the web reads, and /readyz reports the same instant', async () => {
    const { log, lines } = capture()
    await run(log)()

    const row = await readLatestHeartbeat(db)
    expect(row).toMatchObject({ workerId: 'real-host:7', outreach: 'send-only', chat: 'disabled' })
    expect(row!.detail).toMatchObject({ halted: false, lockHeld: true, intervalMs: 60 * 60_000 })
    expect(lastHeartbeatAt()).toEqual(row!.lastTickAt)
    expect(lines.filter((l) => l.level === 'warn')).toEqual([])

    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const ready = await answerHealth('/readyz', {
      pool, halted: false, chatEnabled: false, lockHeld: true, outreach: 'send-only', heartbeatAt: lastHeartbeatAt(),
    })
    expect(ready).toMatchObject({ status: 200, body: { heartbeatWrittenAt: row!.lastTickAt.toISOString() } })
  })

  /**
   * The deployment that pulled new code and never ran the migration. The
   * sender and the inbox work without this table; the worker must too.
   */
  it('carries on without the table, and says so by class', async () => {
    await run(capture().log)()
    const before = lastHeartbeatAt()
    await test.pg.exec('ALTER TABLE worker_heartbeats RENAME TO worker_heartbeats_away')

    const { log, lines } = capture()
    await expect(run(log)()).resolves.toBeUndefined()
    expect(lastHeartbeatAt()).toEqual(before)
    const warned = lines.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(typeof warned[0]!.fields?.['error']).toBe('string')
    expect(JSON.stringify(warned)).not.toContain('worker_heartbeats')
  })
})
