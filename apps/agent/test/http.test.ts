/**
 * The worker's HTTP surface, driven over a real socket.
 *
 * These tests start the actual server and talk to it with `fetch`, because the
 * things worth asserting here are protocol-level: that an unauthenticated
 * caller learns nothing, that the stream is not buffered into one delivery at
 * the end, and that a browser hanging up does not take a running turn with it.
 * None of that is visible from calling the handler directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { ChatEvent } from '@agency/core'
import { createAgentHttpServer, type AgentHttpDeps, type TurnHandle } from '../src/http/server.js'

const TOKEN = 'a-shared-secret-at-least-32-characters'
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never

function event(seq: number, over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    seq,
    sessionId: 'session-1',
    turnId: 'turn-1',
    at: '2026-09-13T00:00:00.000Z',
    kind: 'text_delta',
    blockIndex: 0,
    text: `chunk-${seq}`,
    ...over,
  } as ChatEvent
}

/** A turn that emits what it is told to, then finishes. */
function fakeTurn(events: ChatEvent[]): TurnHandle {
  return {
    turnId: 'turn-1',
    async *events() {
      for (const e of events) yield e
    },
    interrupt: () => {},
  }
}

describe('the agent HTTP surface', () => {
  let server: Server
  let base: string
  let deps: AgentHttpDeps
  const interrupted: string[] = []
  let nextTurn: TurnHandle = fakeTurn([event(1), event(2, { kind: 'turn_finished', reason: 'success', sdkSessionId: 's' } as never)])
  let startResult: Awaited<ReturnType<AgentHttpDeps['startTurn']>> | null = null

  beforeAll(async () => {
    deps = {
      port: 0,
      token: TOKEN,
      log: silent,
      startTurn: async () => startResult ?? { ok: true, turn: nextTurn },
      interrupt: (id) => {
        interrupted.push(id)
        return true
      },
      health: async (url) =>
        url === '/livez' ? { status: 200, body: { status: 'ok' } } : null,
    }
    server = createAgentHttpServer(deps)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })

  describe('authentication', () => {
    /**
     * Defence in depth, not the trust anchor: the token proves the caller is
     * the web app, and the web app is what proves who the human is.
     */
    it('refuses a caller with no token', async () => {
      const res = await post('/internal/turns', { chatSessionId: 's', userId: 'u', text: 'hi' }, null)
      expect(res.status).toBe(401)
    })

    it('refuses a wrong token, and says nothing else', async () => {
      const res = await post('/internal/turns', {}, 'not-the-token')
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    })

    it('refuses a token of a different length without throwing', async () => {
      // timingSafeEqual throws on a length mismatch, so the comparison has to
      // check length first or a short token becomes a 500.
      const res = await post('/internal/turns', {}, 'short')
      expect(res.status).toBe(401)
    })

    /**
     * An orchestrator has to reach health, and it says nothing an anonymous
     * caller could use.
     */
    it('answers health without a token', async () => {
      const res = await fetch(`${base}/livez`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'ok' })
    })
  })

  describe('starting a turn', () => {
    it('rejects a request with no text', async () => {
      const res = await post('/internal/turns', { chatSessionId: 's', userId: 'u', text: '   ' })
      expect(res.status).toBe(400)
    })

    it('rejects a body that is not the right shape', async () => {
      const res = await post('/internal/turns', { text: 'hello' })
      expect(res.status).toBe(400)
    })

    it('passes a refusal through with its status and message', async () => {
      startResult = { ok: false, status: 409, message: 'already_running' }
      const res = await post('/internal/turns', { chatSessionId: 's', userId: 'u', text: 'hi' })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'already_running' })
      startResult = null
    })

    /**
     * The headers are the difference between a token stream and one delivery
     * at the end: nginx buffers a proxied response by default.
     */
    it('streams as server-sent events, unbuffered', async () => {
      const res = await post('/internal/turns', { chatSessionId: 's', userId: 'u', text: 'hi' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('cache-control')).toContain('no-transform')
      expect(res.headers.get('x-accel-buffering')).toBe('no')
      await res.text()
    })

    it('frames each event with its sequence number and kind', async () => {
      const res = await post('/internal/turns', { chatSessionId: 's', userId: 'u', text: 'hi' })
      const body = await res.text()
      expect(body).toContain('id: 1')
      expect(body).toContain('event: text_delta')
      expect(body).toContain('"text":"chunk-1"')
      expect(body).toContain('event: turn_finished')
    })

    it('ends the stream when the turn ends', async () => {
      const res = await post('/internal/turns', { chatSessionId: 's', userId: 'u', text: 'hi' })
      // Resolving at all is the assertion: an unterminated stream hangs here.
      const body = await res.text()
      expect(body.endsWith('\n\n')).toBe(true)
    })
  })

  describe('interrupting', () => {
    it('accepts an interrupt for a running turn', async () => {
      const res = await post('/internal/turns/turn-1/interrupt', {})
      expect(res.status).toBe(202)
      expect(interrupted).toContain('turn-1')
    })

    /**
     * A turn that already finished is not an error — it is the outcome the
     * caller wanted. Answering 404 would make a racing Stop button look broken.
     */
    it('accepts an interrupt for a turn that has already finished', async () => {
      const local = createAgentHttpServer({ ...deps, interrupt: () => false })
      await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
      const port = (local.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/internal/turns/gone/interrupt`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ interrupted: false })
      await new Promise<void>((r) => local.close(() => r()))
    })
  })

  describe('a browser that goes away', () => {
    /**
     * The turn is spending money and has already committed to work. A closed
     * tab stops the writing, never the turn — which is also what makes
     * reattaching to the transcript possible.
     */
    it('does not interrupt the turn when the client hangs up', async () => {
      const interruptSpy = vi.fn()
      let released = false
      const slow: TurnHandle = {
        turnId: 'turn-slow',
        async *events() {
          yield event(1)
          await new Promise((r) => setTimeout(r, 50))
          yield event(2)
          released = true
        },
        interrupt: interruptSpy,
      }
      const local = createAgentHttpServer({ ...deps, startTurn: async () => ({ ok: true, turn: slow }) })
      await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
      const port = (local.address() as AddressInfo).port

      const ac = new AbortController()
      const res = await fetch(`http://127.0.0.1:${port}/internal/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ chatSessionId: 's', userId: 'u', text: 'hi' }),
        signal: ac.signal,
      })
      const reader = res.body!.getReader()
      await reader.read()
      ac.abort() // the tab closes

      await new Promise((r) => setTimeout(r, 200))
      expect(interruptSpy).not.toHaveBeenCalled()
      expect(released, 'the turn ran to completion with nobody reading').toBe(true)
      await new Promise<void>((r) => local.close(() => r()))
    })
  })

  it('404s an unknown path', async () => {
    const res = await post('/internal/nope', {})
    expect(res.status).toBe(404)
  })
})
