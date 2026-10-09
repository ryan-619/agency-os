import { recordUnsubscribe, verifyUnsubscribeToken, type AgencyDb, type UnsubscribeOutcome } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { notify } from '@/lib/slack'
import { TOKEN_SHAPE, logMismatchOnce } from './mismatch'

/**
 * One-click unsubscribe (RFC 8058, §2.1). The link every outbound email
 * carries in `List-Unsubscribe` when the worker holds the secret.
 *
 * A click IS the opt-out, so this route has exactly three honest answers:
 * the suppression row is written — or provably already there, as for a
 * message whose person was erased — (200), the link is not one this
 * deployment sent (404), or the row could NOT be written — and then it is loud: the
 * audit row and the `OPT-OUT NOT RECORDED` log line are already written by
 * `recordUnsubscribe`, this route adds the Slack notification, and the
 * person is told the truth with a 500. Never a "done" over a row that is not
 * there, and never a quiet one.
 *
 * ## Who calls it
 *
 *  - **POST** — a mail client's one-click (`List-Unsubscribe=One-Click` in
 *    the body, no person present), or the button on `/unsubscribe/<token>`,
 *    which posts the same body. Both record. The body is accepted and not
 *    required: what authorises the click is the token, not the form field.
 *  - **GET** — a person who opened the header's link in a browser, or a link
 *    scanner prefetching every URL in a message. A GET NEVER records — that
 *    is the whole reason RFC 8058 exists — so it is sent to the page, which
 *    asks first.
 *
 * ## What it refuses
 *
 * Without `UNSUBSCRIBE_SECRET` everything is refused (503), like
 * `/api/inbound/email` without its secret: a token that cannot be verified
 * names nothing. A body over 1 KB is refused before it is read further. A
 * token that does not verify is a 404 with no hint of why — and one in the
 * shape a worker mints, whose MAC did not match, is logged at error once
 * per process (`mismatch.ts`): the worker holds a different secret, and
 * every click on its links is an opt-out lost. Exempt from the
 * cookie gate in `proxy.ts` — a mail client carries no session. Rate
 * limiting belongs at the reverse proxy, like the booking route's.
 *
 * Nothing from the request is ever echoed into a response, and nothing but
 * ids reaches a log line (§2.3): the token names a row, the row names the
 * address, and only the database holds that.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_BODY = 1024

const COPY = {
  done: 'Done. You will not be emailed again.',
  notRecorded: 'We could not record this. A person has been told.',
  invalid: 'This link is not valid.',
  unavailable:
    'This link cannot be used right now. Reply to the email asking to be removed, and a person will record it.',
  tooLarge: 'That request is too large.',
} as const

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params
  // Relative, so the redirect never trusts a Host header to say where it goes.
  return new Response(null, {
    status: 303,
    headers: { Location: `/unsubscribe/${encodeURIComponent(token)}`, 'Cache-Control': 'no-store' },
  })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params

  // env() throws when ANY variable fails its schema — a value for another
  // feature entirely — and outside a try that was Next's bare 500 with no
  // line saying an opt-out was lost (review round 15). The logger reads no
  // environment, so the loud line is still written; the class only.
  let secret: string | undefined
  try {
    secret = env().UNSUBSCRIBE_SECRET
  } catch (err) {
    const error = err instanceof Error ? err.name : 'UnknownError'
    if (TOKEN_SHAPE.test(token)) {
      log.error('OPT-OUT NOT RECORDED — the web app’s environment does not parse, so no unsubscribe can be verified', {
        path: 'unsubscribe',
        error,
      })
    } else {
      log.warn('unsubscribe refused: environment does not parse', { path: 'unsubscribe', error })
    }
    return page(503, 'Unsubscribe', COPY.unavailable)
  }
  if (!secret) {
    // A well-shaped token here was minted by a worker that HAS the secret,
    // so a person asked to be left alone and this deployment cannot tell
    // which message they meant. That is an opt-out not recorded, and it is
    // said at the level that means it. A probe is not.
    if (TOKEN_SHAPE.test(token)) {
      log.error('OPT-OUT NOT RECORDED — UNSUBSCRIBE_SECRET is not set on the web app', { path: 'unsubscribe' })
    } else {
      log.warn('unsubscribe refused: not configured', { path: 'unsubscribe' })
    }
    return page(503, 'Unsubscribe', COPY.unavailable)
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY) return page(413, 'Unsubscribe', COPY.tooLarge)
  const raw = await request.text().catch(() => '')
  if (raw.length > MAX_BODY) return page(413, 'Unsubscribe', COPY.tooLarge)

  const check = verifyUnsubscribeToken(secret, token)
  if (!check.ok) {
    logMismatchOnce('/api/unsubscribe', token, log)
    return page(404, 'Unsubscribe', COPY.invalid)
  }

  let outcome: UnsubscribeOutcome
  try {
    outcome = await recordUnsubscribe(getDb() as unknown as AgencyDb, {
      touchId: check.touchId,
      log: { error: (message, fields) => log.error(message, fields ? { ...fields } : undefined) },
    })
  } catch (err) {
    // `recordUnsubscribe` never throws; `getDb()` can, on a deployment with
    // no database configured. The same failure to the person who clicked.
    log.error('OPT-OUT NOT RECORDED — record it by hand', {
      path: 'unsubscribe',
      touchId: check.touchId,
      why: err instanceof Error ? err.name : 'UnknownError',
    })
    return page(500, 'Unsubscribe', COPY.notRecorded)
  }

  if (outcome.ok) {
    log.info('unsubscribed by link', {
      touchId: outcome.touchId,
      contactId: outcome.contactId,
      alreadyPresent: outcome.alreadyPresent,
      // A message whose person was erased: the erasure already kept this
      // address on the list, so the click is honoured and nothing is raised.
      erased: outcome.erased,
    })
    return page(200, 'Unsubscribed', COPY.done)
  }
  if (outcome.reason === 'not_found') return page(404, 'Unsubscribe', COPY.invalid)

  // The loudest event this product has. AWAITED rather than scheduled with
  // `after()`: this is a failure path, the person is already being told no,
  // and a host without `waitUntil` would drop a scheduled post silently —
  // the one notification that must not be lost to a platform detail.
  // `notify` is bounded (3 s) and never throws. Without an org there is
  // nothing to file it under; the log line above is then the alarm.
  if (outcome.orgId) {
    await notify({
      kind: 'opt_out_not_recorded',
      orgId: outcome.orgId,
      touchId: outcome.touchId,
      contactId: outcome.contactId,
      path: 'unsubscribe',
    })
  }
  return page(500, 'Unsubscribe', COPY.notRecorded)
}

/**
 * A whole, self-contained document: the person who clicked the button lands
 * here, and a route cannot use the app's stylesheet. Only the constants
 * above are interpolated — nothing from the request.
 */
function page(status: number, title: string, sentence: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --panel: #fff; --ink: #1a1a1a; --muted: #6b6b6b; --line: #e3e3df; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --panel: #1b1b1b; --ink: #eee; --muted: #a0a0a0; --line: #2c2c2c; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 380px; margin: 18vh auto 0; padding: 30px 28px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { color: var(--muted); margin: 0; }
</style>
</head>
<body><main><h1>${title}</h1><p>${sentence}</p></main></body>
</html>
`
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
