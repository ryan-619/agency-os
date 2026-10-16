import { NextResponse } from 'next/server'
import { SHARE_LINK_TOKEN_SHAPE, quoteDecide, shareLinkResolve, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { viewerIsTeam } from '@/lib/team-viewer'

/**
 * A buyer answering a quote through its link (0023): the proposal link's
 * rules, restated. A token that cannot be one is answered like an unknown
 * one before the body is read; the body is bounded; nothing enumerable is
 * returned; a fault is logged by its class alone; every answer is
 * `no-store`. A GET never decides anything — link scanners fetch every URL
 * in a message — so these are POSTs.
 */
const MAX_BODY = 2 * 1024

const REFUSAL: Readonly<Record<string, string>> = {
  not_found: 'This link is not valid any more. Please ask us for a new one.',
  too_large: 'That was too long.',
  invalid: 'That could not be read. Please try again.',
  unavailable: 'That could not be recorded just now. Please try again in a few minutes.',
  team: 'You are signed in to the team that sent this quote, so this cannot be their answer. Record it on the quote’s own page.',
}

function answer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function buyerAnswer(
  request: Request,
  token: string,
  to: 'accepted' | 'declined',
): Promise<NextResponse> {
  if (!SHARE_LINK_TOKEN_SHAPE.test(token)) return answer(404, { error: REFUSAL.not_found })
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY) return answer(413, { error: REFUSAL.too_large })
  const raw = await request.text().catch(() => null)
  if (raw === null) return answer(400, { error: REFUSAL.invalid })
  if (raw.length > MAX_BODY) return answer(413, { error: REFUSAL.too_large })
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    return answer(400, { error: REFUSAL.invalid })
  }
  try {
    const db = getDb() as unknown as AgencyDb
    const now = new Date()
    const link = await shareLinkResolve(db, token, 'quote', now)
    if (!link || !link.quoteId) return answer(404, { error: REFUSAL.not_found })
    // A teammate testing the link is not the buyer: the team's own page records an answer, in their name.
    if (await viewerIsTeam(link.orgId)) return answer(409, { error: REFUSAL.team })
    const r = await quoteDecide(db, {
      orgId: link.orgId,
      quoteId: link.quoteId,
      to,
      via: 'share_link',
      actor: 'share_link',
      acceptedByName: typeof body['name'] === 'string' ? body['name'] : null,
      reason: typeof body['reason'] === 'string' ? body['reason'] : null,
      now,
    })
    if (!r.ok) {
      const status = r.reason === 'invalid' ? 400 : r.reason === 'lapsed' ? 410 : r.reason === 'not_found' ? 404 : 409
      return answer(status, { error: r.message })
    }
    log.info(`quote ${to} through its link`, { quoteId: r.quote.id, linkId: link.id })
    return answer(200, { ok: true })
  } catch (err) {
    log.error('quote answer through its link failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return answer(500, { error: REFUSAL.unavailable })
  }
}
