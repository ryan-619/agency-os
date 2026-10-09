/**
 * The worker's ring of recent warnings and errors, which chat's
 * `recent_errors` reads in place of a terminal (§12).
 *
 * What it keeps reaches a model's context, so the rule is pinned here rather
 * than argued: a kind — message, level, count, first and last instant — and
 * an `error` field only when it is an error class or an upper-case code.
 * Never another field, never another value (§2.3). Bounded, and a repeat is a
 * count, not a row.
 */
import { describe, it, expect } from 'vitest'
import { createRecentLog, keptError, recordingLogger, RECENT_LOG_CAPACITY } from '../src/ops/recent-log.js'
import type { Logger } from '../src/logger.js'

/** A clock the test moves by hand. */
function clock(start = Date.parse('2026-10-06T09:00:00.000Z')) {
  let t = start
  return { now: () => new Date(t), tick: (ms = 1_000) => { t += ms } }
}

describe('the recent log', () => {
  it('collapses repeats of one level, message and error into one entry with a count and both instants', () => {
    const c = clock()
    const ring = createRecentLog({ now: c.now })
    ring.record('warn', 'heartbeat not written; the worker carries on', { error: 'ConnectionError', workerId: 'w:1' })
    c.tick(60_000)
    ring.record('warn', 'heartbeat not written; the worker carries on', { error: 'ConnectionError', workerId: 'w:1' })
    c.tick(60_000)
    ring.record('warn', 'heartbeat not written; the worker carries on', { error: 'ConnectionError' })

    expect(ring.entries()).toEqual([
      {
        level: 'warn',
        msg: 'heartbeat not written; the worker carries on',
        count: 3,
        firstAt: new Date('2026-10-06T09:00:00.000Z'),
        lastAt: new Date('2026-10-06T09:02:00.000Z'),
        error: 'ConnectionError',
      },
    ])
  })

  it('keeps one kind apart from another by level and by error class', () => {
    const ring = createRecentLog()
    ring.record('warn', 'sender could not read the queue', { error: 'ConnectionError' })
    ring.record('warn', 'sender could not read the queue', { error: 'TimeoutError' })
    ring.record('error', 'sender could not read the queue', { error: 'TimeoutError' })
    expect(ring.entries()).toHaveLength(3)
  })

  it('keeps an error field only as a class or a code, and drops every other field and value', () => {
    const ring = createRecentLog()
    ring.record('error', 'agency tool threw', {
      tool: 'scan_company',
      error: 'TypeError',
      touchIds: ['5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a'],
      email: 'jane@prospect.example',
      host: 'imap.secret-mail.example',
      reason: 'authentication_failed',
    })
    ring.record('warn', 'imap reconnecting', { error: 'ENOTFOUND', hint: 'check IMAP_HOST' })
    ring.record('warn', 'database unreachable at startup', { error: 'connect ECONNREFUSED 10.1.2.3:5432' })
    ring.record('warn', 'SECRETS_KEY is set but unusable', { error: 'key must be 32 bytes, got 31' })
    ring.record('warn', 'error was an object', { error: new Error('postgres://user:pw@db.internal/x') })

    const entries = ring.entries()
    const byMsg = new Map(entries.map((e) => [e.msg, e]))
    expect(byMsg.get('agency tool threw')?.error).toBe('TypeError')
    expect(byMsg.get('imap reconnecting')?.error).toBe('ENOTFOUND')
    for (const msg of ['database unreachable at startup', 'SECRETS_KEY is set but unusable', 'error was an object']) {
      expect(byMsg.get(msg), msg).toBeDefined()
      expect('error' in byMsg.get(msg)!, msg).toBe(false)
    }
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(
        e.error === undefined ? ['count', 'firstAt', 'lastAt', 'level', 'msg'] : ['count', 'error', 'firstAt', 'lastAt', 'level', 'msg'],
      )
    }
    const all = JSON.stringify(entries)
    for (const value of [
      'scan_company', '5d4c3b2a', 'jane@prospect.example', 'imap.secret-mail', 'authentication_failed',
      'IMAP_HOST', '10.1.2.3', '32 bytes', 'postgres://',
    ]) {
      expect(all).not.toContain(value)
    }
  })

  it('reads the error field by the two shapes and nothing else', () => {
    expect(keptError('TypeError')).toBe('TypeError')
    expect(keptError('DoveSoftUnreachableError')).toBe('DoveSoftUnreachableError')
    expect(keptError('UnreadableInboundMessageException')).toBe('UnreadableInboundMessageException')
    expect(keptError('ECONNREFUSED')).toBe('ECONNREFUSED')
    expect(keptError('ERR_SOCKET_TIMEOUT')).toBe('ERR_SOCKET_TIMEOUT')
    for (const refused of [
      'Error: boom', 'connect ECONNREFUSED 10.0.0.1:443', 'jane@prospect.example', 'typeError', 'E', '',
      'A'.repeat(42), 'TypeError ', 42, null, undefined, { name: 'TypeError' },
    ]) {
      expect(keptError(refused), String(refused)).toBeUndefined()
    }
  })

  it('keeps nothing at info or debug', () => {
    const ring = createRecentLog()
    ring.record('info', 'agent worker started', { workerId: 'w:1' })
    ring.record('debug', 'tick', {})
    expect(ring.entries()).toEqual([])
  })

  it('is bounded: past its capacity the kind seen least recently goes, and a repeat counts as seen', () => {
    const c = clock()
    const ring = createRecentLog({ capacity: 3, now: c.now })
    for (const m of ['a', 'b', 'c']) {
      ring.record('warn', m)
      c.tick()
    }
    ring.record('warn', 'a') // seen again: now the most recent
    c.tick()
    ring.record('warn', 'd') // full: 'b', the least recently seen, goes
    expect(ring.entries().map((e) => e.msg)).toEqual(['d', 'a', 'c'])
    expect(ring.entries().find((e) => e.msg === 'a')?.count).toBe(2)

    const big = createRecentLog()
    for (let i = 0; i < RECENT_LOG_CAPACITY + 50; i++) big.record('error', `distinct failure ${i}`)
    expect(big.entries()).toHaveLength(RECENT_LOG_CAPACITY)
    expect(big.entries()[0]!.msg).toBe(`distinct failure ${RECENT_LOG_CAPACITY + 49}`)
  })

  it('bounds a message by code points, so a cut never leaves half a character', () => {
    const ring = createRecentLog()
    ring.record('warn', '😀'.repeat(500))
    const [e] = ring.entries()
    expect(Array.from(e!.msg)).toHaveLength(200)
    expect(e!.msg.endsWith('…')).toBe(true)
    expect(e!.msg).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('hands out copies: nothing a reader does changes the ring', () => {
    const ring = createRecentLog()
    ring.record('error', 'agency tool threw', { error: 'TypeError' })
    const [e] = ring.entries() as unknown as Array<{ count: number; lastAt: Date }>
    e!.count = 99
    e!.lastAt.setTime(0)
    expect(ring.entries()[0]!.count).toBe(1)
    expect(ring.entries()[0]!.lastAt.getTime()).not.toBe(0)
  })
})

describe('recordingLogger', () => {
  const capture = () => {
    const calls: Array<[string, string, unknown]> = []
    const inner: Logger = {
      debug: (m, f) => calls.push(['debug', m, f]),
      info: (m, f) => calls.push(['info', m, f]),
      warn: (m, f) => calls.push(['warn', m, f]),
      error: (m, f) => calls.push(['error', m, f]),
    }
    return { calls, inner }
  }

  it('hands every line to the logger it wraps exactly as it was made, and notes only warn and error', () => {
    const { calls, inner } = capture()
    const ring = createRecentLog()
    const log = recordingLogger(inner, ring)
    const fields = { touchIds: ['t1'], error: 'DoveSoftHttpError' }
    log.debug('tick', { n: 1 })
    log.info('agent worker started', { workerId: 'host:1' })
    log.warn('sms rows waiting: no provider', fields)
    log.error('agency tool threw', { tool: 'x', error: 'TypeError' })
    log.warn('no fields at all')

    expect(calls).toEqual([
      ['debug', 'tick', { n: 1 }],
      ['info', 'agent worker started', { workerId: 'host:1' }],
      ['warn', 'sms rows waiting: no provider', fields],
      ['error', 'agency tool threw', { tool: 'x', error: 'TypeError' }],
      ['warn', 'no fields at all', undefined],
    ])
    expect(calls[2]![2]).toBe(fields)
    expect(ring.entries().map((e) => [e.level, e.msg, e.error])).toEqual([
      ['warn', 'no fields at all', undefined],
      ['error', 'agency tool threw', 'TypeError'],
      ['warn', 'sms rows waiting: no provider', 'DoveSoftHttpError'],
    ])
  })

  it('never costs a log line when the ring throws', () => {
    const { calls, inner } = capture()
    const broken = { record: () => { throw new Error('ring broke') }, entries: () => [] }
    const log = recordingLogger(inner, broken)
    expect(() => log.error('agency tool threw', { error: 'TypeError' })).not.toThrow()
    expect(calls).toEqual([['error', 'agency tool threw', { error: 'TypeError' }]])
  })
})

describe('a fault whose class is plain Error', () => {
  it('is kept by its code, the faultFields shape', () => {
    const ring = createRecentLog()
    ring.record('warn', 'sender could not read the queue', { error: 'Error', code: 'ETIMEDOUT', hint: 'the network…' })
    ring.record('warn', 'sender could not read the queue', { error: 'Error', code: 'ETIMEDOUT' })
    ring.record('warn', 'sender could not read the queue', { error: 'Error', code: '57P01' })
    const kinds = ring.entries()
    expect(kinds.map((k) => [k.error ?? null, k.count])).toEqual([
      [null, 1],
      ['ETIMEDOUT', 2],
    ])
  })
})
