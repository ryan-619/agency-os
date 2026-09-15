/**
 * The cookie gate in front of the app.
 *
 * It is a cheap presence check, not the authorisation boundary — every page
 * and route re-establishes the session with `auth()` and checks `can()`. So
 * the things worth testing are the EXEMPTIONS, because each one is a route
 * that anonymous traffic can reach, and the list is the whole security
 * argument for why that is fine:
 *
 *   /signin       has to be reachable to sign in
 *   /api/auth     Auth.js's own endpoints
 *   /api/health   an orchestrator has to reach it
 *   /api/inbound  a mail provider's webhook cannot carry a session cookie;
 *                 the route demands a shared secret and fails closed
 *
 * The last one was found by probing: the first live POST to the webhook came
 * back as a 307 to /signin, because nothing had exempted it.
 */
import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import proxy from '../src/proxy'

const request = (path: string, cookie?: string): NextRequest =>
  new NextRequest(new URL(`http://app.test${path}`), {
    headers: cookie ? { cookie } : {},
  })

describe('the cookie gate', () => {
  it.each([
    '/signin', '/signin/check-email', '/api/auth/session', '/api/auth/callback/nodemailer', '/api/health',
    // The booking page (§8.6): an inbound lead has no account.
    '/book/agency-intro', '/api/book/agency-intro',
  ])(
    'lets anonymous traffic reach %s',
    (path) => {
      const res = proxy(request(path))
      expect(res.status).toBe(200)
      expect(res.headers.get('location')).toBeNull()
    },
  )

  /**
   * A provider posting a received email has no session and never will. The
   * route authenticates the request itself, with a secret, in constant time —
   * and refuses everything when the secret is unset.
   */
  it('lets a mail provider reach the inbound webhook', () => {
    const res = proxy(request('/api/inbound/email'))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it.each(['/', '/companies', '/chat', '/approvals', '/campaigns', '/suppressions', '/api/chat/turns', '/api/touches/x/decide'])(
    'sends anonymous traffic on %s to /signin',
    (path) => {
      const res = proxy(request(path))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/signin')
    },
  )

  it('drops the query string from the redirect, so nothing in it is replayed', () => {
    const res = proxy(request('/companies?token=secret'))
    expect(new URL(res.headers.get('location')!).search).toBe('')
  })

  it.each(['authjs.session-token=abc', '__Secure-authjs.session-token=abc'])(
    'lets a request through with the cookie %s',
    (cookie) => {
      expect(proxy(request('/companies', cookie)).status).toBe(200)
    },
  )

  /**
   * A prefix is not an exemption. `/signinx` and `/api/healthcheck-ish` are
   * not the public routes, and a startsWith without the slash would let them
   * through.
   */
  it.each(['/signinx', '/api/healthz', '/api/inboundish', '/booking', '/api/bookings'])('does not exempt the lookalike %s', (path) => {
    expect(proxy(request(path)).status).toBe(307)
  })
})
