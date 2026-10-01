import { timingSafeEqual } from 'node:crypto'

/**
 * Comparing a shared secret, the one way (§2.3).
 *
 * Every route that authenticates a caller by a secret rather than a session
 * — the inbound webhooks, the cron routes, the unsubscribe link — compares
 * here. A secret compared with `===` leaks its length and then its bytes,
 * one early return at a time; `timingSafeEqual` takes the same time whatever
 * differs. The length check before it is not a leak of anything a caller
 * does not already control: the caller chose the length of what it sent.
 *
 * This file carries no `server-only` marker so the test suite can import it;
 * `lib/secret.ts` re-exports it WITH the marker, and that is what a route
 * imports. Nothing here logs, throws, or reads the environment.
 */
export function secretMatches(expected: string, given: string | null): boolean {
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The token out of an `Authorization: Bearer …` header, or null when the
 * header is absent or is some other scheme. The scheme is matched without
 * regard to case: RFC 7235 says it is case-insensitive, and Vercel's cron
 * sends `Bearer` while a hand-written curl sends whatever it sends.
 *
 * Never logs the header. It is a credential.
 */
export function bearerFromHeader(authorization: string | null): string | null {
  if (!authorization) return null
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(authorization)
  return m?.[1] ?? null
}

/** `bearerFromHeader` over a request's own headers. */
export function bearerFrom(request: Request): string | null {
  return bearerFromHeader(request.headers.get('authorization'))
}
