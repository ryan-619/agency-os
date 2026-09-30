import { NextResponse, after } from 'next/server'
import { handleInboundEmail, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { secretMatches } from '@/lib/secret'
import { notify } from '@/lib/slack'
import { replyNotification } from './notification'

/**
 * Inbound email by webhook (PROMPT.md §8.4, "or the provider webhook").
 *
 * The IMAP listener in the worker is the primary path; this is the other one,
 * for a provider (SendGrid's Inbound Parse, a Postmark inbound stream) that
 * posts each received message as JSON. Both paths call `handleInboundEmail`,
 * so what a reply MEANS — the pause, the deal, the opt-out — is decided in
 * exactly one place.
 *
 * ## The secret is not optional
 *
 * With no `INBOUND_WEBHOOK_SECRET` this route refuses everything. An
 * unauthenticated version would let anyone on the internet, by posting a
 * JSON body, mark a contact as having replied, pause their sequence, and put
 * their address on the suppression list — a denial of service against a
 * campaign, with no login. Compared in constant time, because a secret
 * compared with `===` leaks its length and then its bytes.
 *
 * ## What it accepts
 *
 * A deliberately plain shape rather than one provider's — `{from, subject,
 * text, messageId, references}` — so the mapping from a provider's payload
 * is a few lines in that provider's configuration and this route stays the
 * same for all of them. Unknown fields are ignored; a missing `from` is a
 * 400.
 *
 * ## The team hears about it — after the answer
 *
 * A recorded reply posts one Slack message when `SLACK_WEBHOOK_URL` is set:
 * ids, the company's domain and a link, never the text (`lib/slack-message.ts`).
 * It is scheduled with `after()`, so it runs once the provider has its 200,
 * and the scheduling itself sits in a try/catch: a host with no `waitUntil`
 * throws from `after()` synchronously, and that must not turn a reply that
 * is already recorded into a 500 the provider would retry. A retried
 * delivery is recognised by its Message-ID and announces nothing
 * (`./notification.ts`).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const secret = env().INBOUND_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'inbound webhook is not configured' }, { status: 503 })
  }
  const given =
    request.headers.get('x-inbound-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null
  if (!secretMatches(secret, given)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const o = (body ?? {}) as Record<string, unknown>
  const from = typeof o['from'] === 'string' ? o['from'] : null
  if (!from) return NextResponse.json({ error: 'from is required' }, { status: 400 })

  const references = Array.isArray(o['references'])
    ? (o['references'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : typeof o['inReplyTo'] === 'string'
      ? [o['inReplyTo']]
      : []

  const outcome = await handleInboundEmail(getDb() as unknown as AgencyDb, {
    from,
    subject: typeof o['subject'] === 'string' ? o['subject'] : null,
    text: typeof o['text'] === 'string' ? o['text'].slice(0, 20_000) : null,
    messageId: typeof o['messageId'] === 'string' ? o['messageId'] : null,
    references,
  })

  const event = replyNotification(outcome)
  if (event) {
    try {
      after(() => notify(event))
    } catch (err) {
      log.warn('reply notification not scheduled', { error: err instanceof Error ? err.name : 'UnknownError' })
    }
  }

  // 200 either way. "This address is not a contact" is the ANSWER to a
  // webhook delivery, not a failure of it — a 4xx would make the provider
  // retry a message that will never match.
  return NextResponse.json(
    outcome.matched === 'none'
      ? { matched: 'none', why: outcome.why }
      : { matched: outcome.matched, paused: outcome.paused, suppressed: outcome.suppressed },
  )
}
