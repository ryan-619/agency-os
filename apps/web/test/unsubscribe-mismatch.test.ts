/**
 * A one-click unsubscribe link the web app cannot verify, because the worker
 * that mailed it holds a different `UNSUBSCRIBE_SECRET` (review round 9, [2]
 * and [7]).
 *
 * tools/run-worker.sh made a new secret when the operator pressed Enter, and
 * the web app answered every link minted under it with a 404 and nothing
 * else: no suppression row, no audit row, no alarm, no log line — an opt-out
 * lost with nothing anywhere to say so. The 404 stays (a stranger learns
 * nothing); what changes is that the first such link each surface sees in a
 * process is logged at error, by the surface's path alone.
 *
 * The route and the page reach `server-only` through `@/lib/db`, so this
 * drives `mismatch.ts`, which both import, against tokens the worker's own
 * minter makes, and the last block reads their source to pin the call.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { unsubscribeToken } from '@agency/db'
import { verifyUnsubscribeToken } from '@agency/db/queries'
import {
  TOKEN_SHAPE,
  logMismatchOnce,
  type UnsubscribeSurface,
} from '../src/app/api/unsubscribe/[token]/mismatch'

const WORKER_SECRET = 'w'.repeat(64)
const WEB_SECRET = 'v'.repeat(64)
const TOUCH = '0b6c1f2e-4d5a-4b7c-9e8f-1a2b3c4d5e6f'

interface Line {
  level: string
  message: string
  fields: Record<string, unknown> | undefined
}

function recorder() {
  const lines: Line[] = []
  return {
    lines,
    log: { error: (message: string, fields?: Record<string, unknown>) => lines.push({ level: 'error', message, fields }) },
    everything: () => JSON.stringify(lines),
  }
}

/** What the route and the page do with a token: verify under the web's secret, and on a refusal call the logger. */
function refuse(surface: UnsubscribeSurface, token: string, log: { error: (m: string, f?: Record<string, unknown>) => void }, logged: Set<UnsubscribeSurface>) {
  const check = verifyUnsubscribeToken(WEB_SECRET, token)
  if (!check.ok) logMismatchOnce(surface, token, log, logged)
  return check.ok
}

describe('an unsubscribe link minted under another secret', () => {
  const minted = unsubscribeToken(WORKER_SECRET, TOUCH)

  it('is the shape a worker mints, and does not verify under the web app’s secret (the control)', () => {
    expect(minted).toMatch(TOKEN_SHAPE)
    expect(verifyUnsubscribeToken(WORKER_SECRET, minted).ok).toBe(true)
    expect(verifyUnsubscribeToken(WEB_SECRET, minted).ok).toBe(false)
  })

  it('is logged at error once per surface, naming the surface and never the token', () => {
    const r = recorder()
    const logged = new Set<UnsubscribeSurface>()
    expect(refuse('/api/unsubscribe', minted, r.log, logged)).toBe(false)
    expect(refuse('/api/unsubscribe', unsubscribeToken(WORKER_SECRET, TOUCH.replace('0b6c', '1b6c')), r.log, logged)).toBe(false)
    expect(refuse('/unsubscribe', minted, r.log, logged)).toBe(false)
    expect(refuse('/unsubscribe', minted, r.log, logged)).toBe(false)

    expect(r.lines.map((l) => [l.level, l.fields])).toEqual([
      ['error', { route: '/api/unsubscribe' }],
      ['error', { route: '/unsubscribe' }],
    ])
    // The click is the opt-out: the POST's line is the alarm everybody greps for.
    expect(r.lines[0]!.message).toMatch(/^OPT-OUT NOT RECORDED — /)
    for (const l of r.lines) {
      expect(l.message).toContain('UNSUBSCRIBE_SECRET')
      expect(l.message).toContain('same secret')
      expect(l.message).toContain('Logged once per process')
    }
    // Neither half of a token — the touch id names a message, the MAC is a credential for it.
    const [touchId, mac] = minted.split('.')
    for (const never of [minted, touchId!, mac!, WORKER_SECRET, WEB_SECRET]) expect(r.everything()).not.toContain(never)
  })

  it('a malformed token is a probe, and says nothing — nor does a link that verifies', () => {
    const r = recorder()
    const logged = new Set<UnsubscribeSurface>()
    for (const probe of ['abc.def', `${TOUCH}.${'z'.repeat(64)}`, `${TOUCH}.${'a'.repeat(63)}`, TOUCH, '', `${minted}x`, minted.toUpperCase()]) {
      expect(refuse('/api/unsubscribe', probe, r.log, logged), probe).toBe(false)
    }
    expect(r.lines).toEqual([])
    // A link this deployment minted verifies, and nothing is logged for it.
    expect(refuse('/api/unsubscribe', unsubscribeToken(WEB_SECRET, TOUCH), r.log, logged)).toBe(true)
    expect(r.lines).toEqual([])
    // …and the probes did not use up the one line a real mismatch gets.
    refuse('/api/unsubscribe', minted, r.log, logged)
    expect(r.lines).toHaveLength(1)
  })

  it('remembers what it logged for the life of the process, by default', () => {
    const r = recorder()
    logMismatchOnce('/unsubscribe', minted, r.log)
    logMismatchOnce('/unsubscribe', minted, r.log)
    expect(r.lines).toHaveLength(1)
  })
})

describe('the route and the page call it where a link does not verify', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const route = read('../src/app/api/unsubscribe/[token]/route.ts')
  const page = read('../src/app/unsubscribe/[token]/page.tsx')

  it('the one-click POST logs the mismatch, then answers the same 404', () => {
    expect(route).toContain("from './mismatch'")
    expect(route).toMatch(
      /if \(!check\.ok\) \{\n\s+logMismatchOnce\('\/api\/unsubscribe', token, log\)\n\s+return page\(404, 'Unsubscribe', COPY\.invalid\)\n\s+\}/,
    )
    // One shape, shared: the unset-secret branch reads the same one.
    expect(route).not.toMatch(/const TOKEN_SHAPE =/)
    expect(route).toMatch(/if \(TOKEN_SHAPE\.test\(token\)\) \{\n\s+log\.error\('OPT-OUT NOT RECORDED — UNSUBSCRIBE_SECRET is not set/)
  })

  it('the page logs it under its own path, then renders the same "not valid"', () => {
    expect(page).toContain("from '../../api/unsubscribe/[token]/mismatch'")
    expect(page).toMatch(/if \(!check\.ok\) \{\n(?:\s*\/\/.*\n)*\s+logMismatchOnce\('\/unsubscribe', token, log\)\n\s+return <Invalid \/>\n\s+\}/)
  })

  it('neither puts the token in a log line', () => {
    for (const source of [route, page]) {
      for (const m of source.matchAll(/log\.(?:error|warn|info)\(([^)]*)\)/g)) expect(m[1]).not.toMatch(/\btoken\b/)
    }
  })
})
