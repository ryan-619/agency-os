import { NextResponse } from 'next/server'
import { appendAudit, recordSmsDelivery, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { authoriseDoveSoft, handleDoveSoftDlr, logRefusalOnce, readDoveSoftRequest, tokenFrom } from '../webhook'

/**
 * DoveSoft's SMS delivery reports (0019): what the operator said about
 * delivering an SMS this system sent.
 *
 * Authenticated by `DOVESOFT_WEBHOOK_SECRET` — the `token` query parameter or
 * `x-dovesoft-token` — and refusing everything while it is unset. GET and POST
 * alike, because how DoveSoft pushes a report is not public; the fields are
 * read from the query, a form or JSON (`../webhook.ts`). A report pushed by
 * GET puts its fields in the platform's request log — a message id and a
 * status, and the token; the inbound-text route's note says what a GET text
 * costs.
 *
 * A report never changes `status`, which stays the send path's word, and a
 * failed delivery is evidence about one attempt to one number — never an
 * opt-out (`recordSmsDelivery`). Answered 200 for anything read, matched or
 * not; 400 for a report this route cannot read, so DoveSoft retries it and
 * the error log says which field was missing.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function handle(request: Request): Promise<NextResponse> {
  const e = env()
  const auth = authoriseDoveSoft(e.DOVESOFT_WEBHOOK_SECRET, tokenFrom(request))
  if (!auth.ok) {
    logRefusalOnce('dlr', auth, log)
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const req = await readDoveSoftRequest(request)

  const db = getDb() as unknown as AgencyDb
  const answer = await handleDoveSoftDlr(req.read, req.shape, {
    orgId: e.DOVESOFT_ORG_ID ?? null,
    audit: (entry) => appendAudit(db, entry),
    log,
    record: (args) => recordSmsDelivery(db, args),
  })
  return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request)
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request)
}
