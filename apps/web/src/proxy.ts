import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Next 16 renamed the `middleware` file convention to `proxy`; this is that
 * file. Same request-time interception, new name.
 *
 * Everything except the sign-in screens, the auth endpoints and the health
 * check requires a session cookie.
 *
 * This is a cheap cookie-presence gate that keeps anonymous traffic off the
 * app; it is NOT the authorisation boundary. Every page and route
 * re-establishes the real session with `auth()` and checks capabilities with
 * `can()` from packages/core. A forged cookie gets past this and then fails.
 */
/**
 * `/api/inbound` is public here because a mail provider's webhook cannot carry
 * a session cookie. It is NOT unauthenticated: the route itself demands
 * `INBOUND_WEBHOOK_SECRET` in a header, compared in constant time, and refuses
 * everything when the secret is unset. Found by probing rather than by
 * reading — the first live POST came back as a 307 to /signin.
 */
const PUBLIC = ['/signin', '/api/auth', '/api/health', '/api/inbound']

export default function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next()
  }

  const hasSession =
    req.cookies.has('authjs.session-token') || req.cookies.has('__Secure-authjs.session-token')

  if (!hasSession) {
    const url = req.nextUrl.clone()
    url.pathname = '/signin'
    url.search = ''
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // Skip Next internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
