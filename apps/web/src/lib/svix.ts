import { createHmac } from 'node:crypto'
import { secretMatches } from './secret-compare'

/**
 * Verifying a Svix-signed webhook — how Resend signs every event it posts.
 *
 * In-repo rather than the `svix` package: the algorithm is one HMAC, and a
 * dependency that exists to compute one HMAC is a supply-chain surface on
 * the one route a stranger can reach with a body. The published vector
 * from Svix's own documentation is pinned in `test/svix.test.ts`, so this
 * agrees with the reference rather than with itself.
 *
 * The scheme:
 *
 *  - the endpoint secret is `whsec_` + base64; the HMAC key is the DECODED
 *    bytes, not the string;
 *  - the signed content is `${svix-id}.${svix-timestamp}.${raw body}` — the
 *    body exactly as it arrived. A body parsed and re-serialised is a
 *    different string, so this runs before anything reads the JSON;
 *  - `svix-signature` is a SPACE-separated list of `v1,<base64>` entries (a
 *    rotated secret signs with both keys for a while), and any one matching
 *    is enough. Entries in another scheme (`v1a,` is Svix's asymmetric one)
 *    are skipped rather than treated as a failure;
 *  - the timestamp must sit within the tolerance of `now` in EITHER
 *    direction. Without it a captured delivery is valid forever; the id is
 *    in the signed content, but nothing here remembers ids, so the window
 *    is what bounds a replay. (A replay inside the window is harmless
 *    anyway: `handleInboundEmail` records one Message-ID once.)
 *
 * Constant-time over the base64 text, through the same `secretMatches`
 * every other shared-secret route uses. The result says WHY and nothing
 * else — never the secret, never the expected signature, which would be a
 * valid signature for that body handed to whoever sent it.
 *
 * Pure: no environment, no logging, no clock of its own. `node:crypto`
 * makes this server-only by construction — a client component importing it
 * fails the build — and it carries no `server-only` marker so the test
 * suite can import it.
 */
export type SvixVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: 'missing' | 'stale' | 'mismatch' | 'bad_secret' }

/** Svix's own default, and what Resend documents. */
export const SVIX_TOLERANCE_SECONDS = 300

const SECRET_PREFIX = 'whsec_'
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The HMAC key, or null when the secret is not a `whsec_` secret at all. */
function keyFrom(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null
  const encoded = secret.slice(SECRET_PREFIX.length)
  if (!BASE64.test(encoded)) return null
  const key = Buffer.from(encoded, 'base64')
  return key.length > 0 ? key : null
}

export function verifySvix(args: {
  readonly secret: string
  readonly id: string | null
  readonly timestamp: string | null
  readonly signature: string | null
  /** The raw request body, before any parsing. */
  readonly body: string
  readonly now: Date
  readonly toleranceSeconds?: number
}): SvixVerdict {
  // The deployment's fault, not the caller's, and checked first so that a
  // misconfigured secret is reported as one on every delivery instead of
  // hiding behind "that signature is wrong".
  const key = keyFrom(args.secret)
  if (!key) return { ok: false, why: 'bad_secret' }

  if (!args.id || !args.timestamp || !args.signature) return { ok: false, why: 'missing' }
  // Whole seconds since the epoch, as Svix sends it. Anything else is not a
  // timestamp, and a header that is not one is as good as absent.
  if (!/^\d{1,12}$/.test(args.timestamp)) return { ok: false, why: 'missing' }

  const tolerance = args.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS
  const nowSeconds = Math.floor(args.now.getTime() / 1000)
  if (Math.abs(nowSeconds - Number(args.timestamp)) > tolerance) return { ok: false, why: 'stale' }

  const expected = createHmac('sha256', key)
    .update(`${args.id}.${args.timestamp}.${args.body}`, 'utf8')
    .digest('base64')

  // Every entry is compared — no early return on the first match — so the
  // time taken does not say which position in the list was the good one.
  let matched = false
  for (const entry of args.signature.split(' ')) {
    const comma = entry.indexOf(',')
    if (comma === -1 || entry.slice(0, comma) !== 'v1') continue
    if (secretMatches(expected, entry.slice(comma + 1))) matched = true
  }
  return matched ? { ok: true } : { ok: false, why: 'mismatch' }
}
