import { NextResponse, after } from 'next/server'
import { handleInboundEmail, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { receiveResendWebhook } from '@/lib/resend-inbound'
import { notify } from '@/lib/slack'
import { replyNotification } from '../email/notification'

/**
 * Replies through Resend's signed webhook — the inbound path for a
 * deployment with no worker reading a mailbox (PROMPT.md §8.4).
 *
 * Exempt from the cookie gate by the `/api/inbound` prefix in `proxy.ts`,
 * because Resend cannot carry a session; it authenticates by Svix signature
 * instead, and refuses EVERYTHING (503) unless both `RESEND_WEBHOOK_SECRET`
 * and `RESEND_API_KEY` are set. Everything between the request and the
 * answer is `receiveResendWebhook` in `lib/resend-inbound.ts` — verify over
 * the raw body, ignore every event but `email.received`, fetch the message,
 * map it, hand it to `handleInboundEmail` — so the test suite drives the
 * same code this route runs. What is left here is the environment and the
 * Slack message.
 *
 * A READER: it files a message somebody sent and can send nothing. The
 * opt-out reader runs inside `handleInboundEmail`, the same one the IMAP
 * listener and `/api/inbound/email` reach, so "stop" means the same thing
 * whichever way it arrived.
 *
 * The Slack message is the generic route's: built by that route's own
 * `replyNotification` (so a retried delivery, recognised by its Message-ID,
 * announces nothing), scheduled with `after()` once Resend has its answer,
 * and the scheduling itself in a try/catch — a host with no `waitUntil`
 * throws from `after()`, and a reply already recorded must not become a 500
 * that Resend would retry.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const e = env()
  const result = await receiveResendWebhook(request, {
    secret: e.RESEND_WEBHOOK_SECRET,
    apiKey: e.RESEND_API_KEY,
    now: new Date(),
    handle: (mail) => handleInboundEmail(getDb() as unknown as AgencyDb, mail),
  })

  const event = result.outcome ? replyNotification(result.outcome) : null
  if (event) {
    try {
      after(() => notify(event))
    } catch (err) {
      log.warn('reply notification not scheduled', { error: err instanceof Error ? err.name : 'UnknownError' })
    }
  }

  return NextResponse.json(result.body, { status: result.status })
}
