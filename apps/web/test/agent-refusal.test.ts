/**
 * A refused chat turn, read from what AGENT_URL answered.
 *
 * Behind the documented ngrok static domain `fetch` never throws: a Mac that
 * is off, a worker that is down and a refused token all come back as an HTTP
 * answer, and the turn route passed each through as the worker's own words,
 * so the panel said "The agent could not start. Nothing was done." for all
 * three (review round 15). Only the worker answers in the worker's shape.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { refusalFromUpstream } from '../src/lib/agent-refusal'

const json = 'application/json; charset=utf-8'

describe('refusalFromUpstream', () => {
  it('passes the worker’s own refusal code through with its status', () => {
    expect(refusalFromUpstream({ status: 503, contentType: json, ngrokErrorCode: null, body: '{"error":"chat_disabled"}' }))
      .toEqual({ status: 503, body: { error: 'chat_disabled' } })
    expect(refusalFromUpstream({ status: 404, contentType: json, ngrokErrorCode: null, body: '{"error":"no_such_conversation"}' }))
      .toEqual({ status: 404, body: { error: 'no_such_conversation' } })
  })

  it('calls ngrok’s own error page unreachable, whatever its status — the endpoint is offline', () => {
    expect(refusalFromUpstream({
      status: 404,
      contentType: 'text/html',
      ngrokErrorCode: 'ERR_NGROK_3200',
      body: '<!DOCTYPE html><html>… is offline …</html>',
    })).toEqual({ status: 503, body: { error: 'agent_unreachable' } })
    // Even a JSON body is not the worker's when ngrok marked it as its own.
    expect(refusalFromUpstream({ status: 502, contentType: json, ngrokErrorCode: 'ERR_NGROK_8012', body: '{"error":"x"}' }))
      .toEqual({ status: 503, body: { error: 'agent_unreachable' } })
  })

  it('calls anything not in the worker’s shape unreachable: HTML, plain text, an empty body, JSON with no code', () => {
    for (const [contentType, body] of [
      ['text/html', '<html>Bad gateway</html>'],
      ['text/plain', 'upstream connect error'],
      [null, ''],
      [json, '{"message":"not ours"}'],
      [json, 'not json at all'],
      [json, `{"error":"${'x'.repeat(200)}"}`],
    ] as const) {
      expect(refusalFromUpstream({ status: 502, contentType, ngrokErrorCode: null, body }), body.slice(0, 20))
        .toEqual({ status: 503, body: { error: 'agent_unreachable' } })
    }
  })

  it('names a token the worker refused, which no retry fixes', () => {
    expect(refusalFromUpstream({ status: 401, contentType: json, ngrokErrorCode: null, body: '{"error":"unauthorized"}' }))
      .toEqual({ status: 503, body: { error: 'agent_token_refused' } })
  })

  it('never answers a success status for a refusal', () => {
    expect(refusalFromUpstream({ status: 200, contentType: json, ngrokErrorCode: null, body: '{"error":"internal"}' }).status)
      .toBe(502)
  })
})

describe('the turn route and the panel read it', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

  it('the route classifies a refused answer rather than passing its body through', () => {
    const route = src('app/api/chat/turns/route.ts')
    expect(route).toContain('refusalFromUpstream({')
    expect(route).toContain("res.headers.get('ngrok-error-code')")
    expect(route).not.toMatch(/new Response\(detail/)
  })

  it('the panel has words for every code the route can now answer', () => {
    const panel = src('components/chat/panel.tsx')
    for (const code of ['agent_not_configured', 'agent_misconfigured', 'agent_unreachable', 'agent_token_refused']) {
      expect(panel, code).toContain(`case '${code}':`)
    }
    expect(panel).toContain('the computer running it may be off or asleep, or its tunnel is down')
  })
})
