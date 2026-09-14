import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { handleInboundEmail, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'

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
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function secretMatches(expected: string, given: string | null): boolean {
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

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

  // 200 either way. "This address is not a contact" is the ANSWER to a
  // webhook delivery, not a failure of it — a 4xx would make the provider
  // retry a message that will never match.
  return NextResponse.json(
    outcome.matched === 'none'
      ? { matched: 'none', why: outcome.why }
      : { matched: outcome.matched, paused: outcome.paused, suppressed: outcome.suppressed },
  )
}
