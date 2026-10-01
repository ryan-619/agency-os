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
/**
 * `/api/inbound/dovesoft/dlr` and `/api/inbound/dovesoft/sms` — DoveSoft's SMS
 * delivery reports and the texts a contact sends back (0019) — are under that
 * same `/api/inbound` entry, deliberately not a second one: an operator's
 * push carries no cookie either. Each route demands `DOVESOFT_WEBHOOK_SECRET`
 * (a `token` query parameter or `x-dovesoft-token`), in constant time, and
 * answers 503 to everything while it is unset.
 */
/**
 * `/book` and `/api/book` are the public booking page (§8.6): an inbound lead
 * has no account and never will. The route validates everything it is given,
 * creates rows only under the org whose slug is in the URL, and writes an
 * audit row — see packages/db/src/booking.ts for what it refuses to guess.
 */
/**
 * `/api/cron` is Vercel's scheduler calling in, which has no session and no
 * browser. Each route authenticates itself with `CRON_SECRET` as a bearer,
 * compared in constant time, refuses everything when the secret is unset,
 * and refuses to run anywhere but the production deployment — see
 * `lib/cron-auth.ts` for the four outcomes.
 */
/**
 * `/api/unsubscribe` and `/unsubscribe` are the one-click unsubscribe link
 * (RFC 8058, §2.1). A recipient clicking it is not signed in and must never
 * have to be: the link has to work from a mail client in one click, or it
 * is not an unsubscribe. The token in the path is signed with
 * `UNSUBSCRIBE_SECRET` and names the touch it was minted for; the route
 * verifies it, writes the suppression row, and answers 503 with no secret.
 */
/**
 * `/p` and `/api/p` are a proposal's share link: a buyer reading the document
 * has no account and never will. The token in the path is the credential —
 * long, random, stored hashed — and the route reads exactly one proposal
 * for it. `/p` is matched as a whole segment, so `/pipeline` and
 * `/proposals` stay behind the gate.
 */
const PUBLIC = [
  '/signin',
  '/api/auth',
  '/api/health',
  '/api/inbound',
  '/book',
  '/api/book',
  '/api/cron',
  '/api/unsubscribe',
  '/unsubscribe',
  '/p',
  '/api/p',
]

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
