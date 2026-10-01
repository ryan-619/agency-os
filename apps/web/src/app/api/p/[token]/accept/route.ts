import { NextResponse, after } from 'next/server'
import { SHARE_TOKEN_SHAPE, shareAccept, type AgencyDb, type ShareAcceptResult } from '@agency/db/queries'
import { BUYER_REFUSAL } from '@/components/pipeline/proposal-share-copy'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { notify } from '@/lib/slack'
import { shareAcceptedNotification } from './notification'

/**
 * A buyer accepts a proposal through its share link (PROMPT.md §8.6).
 *
 * The second route a stranger can write through — the booking page's is the
 * first — and it keeps that route's rules verbatim:
 *
 *  - unauthenticated by design and exempt from the cookie gate in
 *    `proxy.ts` (`/api/p`); the token is the authority, and it is checked in
 *    `shareAccept` by its sha256, compared in constant time;
 *  - the body is read as text first and refused over 2 KB before it is
 *    parsed; the one field is bounded (a name, ≤ 120);
 *  - nothing enumerable is returned: `{ ok: true }` and nothing else, never
 *    the proposal's, the share's or the org's id;
 *  - 404 for a token that is unknown or revoked, the same answer for both;
 *    410 for an expired one, and for one whose evidence has aged out, or
 *    been superseded by a newer successful scan, since it was made (§2.2) —
 *    told to the buyer as "being re-verified", never "stale".
 *
 * Accepting is `setProposalStatus(accepted)` inside `shareAccept`, the call
 * the team's button makes, so the deal closes `won` exactly as it does
 * there. One Slack message follows when `SLACK_WEBHOOK_URL` is set, from
 * `after()`, with ids and the domain — never the typed name. A failure to
 * schedule it is logged, never returned: the acceptance is committed.
 *
 * Rate limiting belongs in front of the app, as for `/api/book`: the WAF
 * rule DEPLOYING.md's "The public surface" asks for covers `/api/p` too.
 * A token is 32 random bytes, so guessing one is not what the rule is for;
 * it bounds the notifications and the database work a flood would cost.
 *
 * `force-dynamic` and the Node runtime like every route here: the answer is
 * a write, and a cached one would be a lie.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_BODY = 2 * 1024

function answer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params
  // A token that cannot be one is answered like an unknown one, before the
  // body is read or the database is asked.
  if (!SHARE_TOKEN_SHAPE.test(token)) return answer(404, { error: BUYER_REFUSAL.not_found })

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY) return answer(413, { error: BUYER_REFUSAL.too_large })
  const raw = await request.text().catch(() => null)
  if (raw === null) return answer(400, { error: BUYER_REFUSAL.invalid })
  if (raw.length > MAX_BODY) return answer(413, { error: BUYER_REFUSAL.too_large })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return answer(400, { error: BUYER_REFUSAL.invalid })
  }
  const b = (body ?? {}) as Record<string, unknown>

  let result: ShareAcceptResult
  try {
    // The name is bounded (≤ 120 characters, cut at a character) and
    // cleaned inside `shareAccept`, which refuses one that is blank.
    result = await shareAccept(getDb() as unknown as AgencyDb, { token, acceptedByName: b.name })
  } catch (err) {
    // Rolled back: nothing was half-accepted. Only the error's name is
    // logged — a driver message can carry the connection string.
    log.error('share-link acceptance failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return answer(500, { error: BUYER_REFUSAL.unavailable })
  }
  if (!result.ok) return answer(result.status, { error: BUYER_REFUSAL[result.reason] })

  log.info('proposal accepted through its share link', { proposalId: result.proposalId, shareId: result.shareId })
  const event = shareAcceptedNotification(result)
  if (event) {
    try {
      after(async () => {
        try {
          await notify(event)
        } catch (err) {
          // `notify` never throws; this is for the day it does. Caught here,
          // not left to `after()`, which prints an escaping Error whole.
          log.warn('proposal_accepted notification failed', { error: err instanceof Error ? err.name : 'UnknownError' })
        }
      })
    } catch (err) {
      log.warn('proposal_accepted notification not scheduled', { error: err instanceof Error ? err.name : 'UnknownError' })
    }
  }
  // No id of any kind: a stranger has no use for one, and an id is a thing
  // to enumerate with.
  return answer(200, { ok: true })
}
