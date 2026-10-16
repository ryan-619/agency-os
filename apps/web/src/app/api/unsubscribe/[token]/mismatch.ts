/**
 * The one unsubscribe failure nothing used to see: a link in the right shape
 * that does not verify under this web app's `UNSUBSCRIBE_SECRET` (review
 * round 9, [2] and [7]).
 *
 * The worker mints every `List-Unsubscribe` link with ITS copy of the
 * secret, and the web verifies with its own. When the two differ — a worker
 * started with a new secret Vercel never got, or a Vercel value replaced
 * under links already mailed — every one-click unsubscribe answers 404 "This
 * link is not valid.", and a mail client's one-click shows the person
 * nothing at all. No suppression row, no audit row, no alarm, and until now
 * no log line: an opt-out lost with nothing anywhere to say so. A MISSING
 * secret was always loud (the route's 503 branch); a WRONG one was silent.
 *
 * So the first such link each surface sees in a process is logged at error,
 * by the surface's path alone — never the token, which names a message —
 * and the stranger still gets the 404 with no hint of why. Once per process
 * per surface, because anybody can send a well-shaped token made up on the
 * spot, and a line per request would bury the one that matters.
 *
 * Pure, and imported by the route and the page beside it: a test reads THIS,
 * because they reach `server-only` through `@/lib/db`.
 */

/** A token's shape, without the secret: a touch id, a dot, a hex HMAC-SHA256. */
export const TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/

/** Where a link is verified: the one-click POST, and the page a person opens. */
export type UnsubscribeSurface = '/api/unsubscribe' | '/unsubscribe'

export interface MismatchLog {
  error(message: string, fields?: Record<string, unknown>): void
}

const MISMATCH = {
  // A POST is the click itself: the person asked, and it was not recorded.
  '/api/unsubscribe':
    'OPT-OUT NOT RECORDED — a one-click unsubscribe link in the right shape did not verify under this web ' +
    "app's UNSUBSCRIBE_SECRET, so the click was refused with a 404. If the worker that mailed it holds a " +
    'different value, every unsubscribe from its mail is being refused this way: give the worker and the web ' +
    'app the same secret, and record by hand anybody who reports one did not work. Logged once per process.',
  // A GET records nothing, but the page then offers no button to press.
  '/unsubscribe':
    "The unsubscribe page refused a link in the right shape that did not verify under this web app's " +
    'UNSUBSCRIBE_SECRET, so the person who opened it could not unsubscribe. If the worker that mailed it holds ' +
    'a different value, every unsubscribe from its mail is being refused: give the worker and the web app the ' +
    'same secret. Logged once per process.',
} as const satisfies Record<UnsubscribeSurface, string>

const MISMATCHES_LOGGED = new Set<UnsubscribeSurface>()

/**
 * Called where a token did NOT verify and the secret IS set: logs once per
 * surface when the token has the shape a worker mints, which — with the
 * shape checked and a secret present — means its MAC did not match. A
 * malformed token is a probe, and says nothing.
 */
export function logMismatchOnce(
  surface: UnsubscribeSurface,
  token: string,
  log: MismatchLog,
  logged: Set<UnsubscribeSurface> = MISMATCHES_LOGGED,
): void {
  if (logged.has(surface) || typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return
  logged.add(surface)
  log.error(MISMATCH[surface], { route: surface })
}
