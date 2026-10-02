import { NextResponse, after } from 'next/server'
import { appendAudit, pauseContactOverriding, recordInboundSms, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { notify } from '@/lib/slack'
import { authoriseDoveSoft, handleDoveSoftMo, logRefusalOnce, readDoveSoftRequest, tokenFrom } from '../webhook'

/**
 * A text a contact sent back, pushed by DoveSoft (0019).
 *
 * Authenticated by `DOVESOFT_WEBHOOK_SECRET` — the `token` query parameter or
 * `x-dovesoft-token` — and refusing everything while it is unset: an open
 * route here would let anyone on the internet pause a contact, or put a
 * number on the suppression list. GET and POST alike, because the push
 * format is not public; the fields are read from the query, a form or JSON
 * under the common names (`../webhook.ts`).
 *
 * GET is kept although it costs something, because a STOP that cannot
 * arrive is worse: Indian gateways commonly forward an inbound text by GET,
 * and DoveSoft's format is not public. But a GET push carries its fields in
 * the URL, so the SENDER'S NUMBER AND THE WORDS of every text land in the
 * platform's request log (Vercel's, and DoveSoft's own URL log), beside the
 * token — this route's own lines never carry them, and cannot stop the
 * platform logging a URL. Ask DoveSoft to push by POST, a form or JSON,
 * where it offers it; /settings/deployment says so.
 *
 * What the words MEAN is decided once, by `recordInboundSms`: a reply that
 * pauses the person and cancels what was queued, as an email reply does, and
 * a STOP that is written as a phone suppression with source `reply` — or the
 * loud `opt_out_not_recorded` path when it cannot be, whose Slack alarm is
 * awaited here — one per org where the suppression could not be written. A
 * text this route cannot read is never answered 200: it may have been a
 * STOP, so it is a 400 DoveSoft retries, an audit row and an error line,
 * with no body and no number in either.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function handle(request: Request): Promise<NextResponse> {
  const e = env()
  const auth = authoriseDoveSoft(e.DOVESOFT_WEBHOOK_SECRET, tokenFrom(request))
  if (!auth.ok) {
    logRefusalOnce('sms', auth, log)
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const req = await readDoveSoftRequest(request)

  const db = getDb() as unknown as AgencyDb
  const answer = await handleDoveSoftMo(req.read, req.shape, new Date(), {
    orgId: e.DOVESOFT_ORG_ID ?? null,
    audit: (entry) => appendAudit(db, entry),
    log,
    record: (args) => recordInboundSms(db, args),
    // AWAITED, never `after()`: the one notice that must not be lost to a
    // host without `waitUntil`. `notify` is bounded (3 s) and never throws.
    alarm: (event) => notify(event),
    later: (event) => after(() => notify(event)),
    // A STOP whose recording threw, once the recorder said whose it was.
    pause: (p) => pauseContactOverriding(db, p.orgId, p.contactId, p.reason, p.now),
  })
  return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request)
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request)
}
