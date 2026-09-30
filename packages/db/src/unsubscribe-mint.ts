/**
 * The MINT half of RFC 8058 one-click unsubscribe: `${touchId}.${hmac}` from
 * the shared secret, and the two headers that carry it.
 *
 * Exported from the package root ONLY. The worker mints — it is the process
 * that puts a message on the wire — and the web app verifies, through
 * `unsubscribe.ts`. A web bundle that could mint a token could unsubscribe
 * anyone; `queries.ts` says why the line is absent there and
 * `test/barrel.test.ts` asserts it.
 *
 * ## What the token is, and what it deliberately is not
 *
 * The touch id and an HMAC-SHA256 of it, hex. Nothing else:
 *
 *  - **No address.** A URL is logged by every proxy, mail scanner and browser
 *    history between here and the recipient. The token names the ROW; the row
 *    names the address, and only the database holds that (§2.3).
 *  - **No expiry.** A link in an email is clicked whenever the person gets
 *    round to it, and an expired one is exactly the fall-through §2.1
 *    forbids: somebody asked to be left alone and the system said no.
 *  - **No org, no contact.** The touch row carries both, and it is the only
 *    source of them a forged token cannot choose.
 *
 * The verifier computes the same MAC in `unsubscribe.ts` rather than
 * importing it from here, so the verify module has nothing to mint with.
 * `test/unsubscribe.test.ts` round-trips one through the other, so the two
 * one-line computations cannot drift apart without a red test.
 */
import { createHmac } from 'node:crypto'

/** The value of `List-Unsubscribe-Post`, fixed by RFC 8058 §3.1. */
export const UNSUBSCRIBE_ONE_CLICK = 'List-Unsubscribe=One-Click'

/** `${touchId}.${hex(HMAC-SHA256(secret, touchId))}`. */
export function unsubscribeToken(secret: string, touchId: string): string {
  return `${touchId}.${createHmac('sha256', secret).update(touchId).digest('hex')}`
}

/**
 * The two headers every outbound email carries when the deployment can
 * verify a click: the link, and the declaration that a POST to it is a
 * one-click unsubscribe (RFC 8058 §3.1). `origin` is the web app's PUBLIC
 * origin as the worker was told it — never a host the worker binds.
 *
 * The link points at the API route, not the page: a mail client POSTs to it
 * with no person present, and a person who opens it in a browser is sent to
 * the page, which asks before recording anything (a GET never records —
 * link scanners prefetch every URL in a message).
 */
export function unsubscribeHeaders(secret: string, origin: string, touchId: string): Record<string, string> {
  const base = origin.replace(/\/+$/, '')
  return {
    'List-Unsubscribe': `<${base}/api/unsubscribe/${unsubscribeToken(secret, touchId)}>`,
    'List-Unsubscribe-Post': UNSUBSCRIBE_ONE_CLICK,
  }
}
