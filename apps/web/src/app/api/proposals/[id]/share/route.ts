import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { shareMint, shareRevoke, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'

/**
 * Create or revoke a buyer's link to a proposal (PROMPT.md §8.6).
 *
 * `{ action: 'create' }` mints a link for a proposal a person has ALREADY
 * marked `sent` — a draft is refused, never promoted, because the human act
 * that makes a proposal outbound is that explicit decision (§2.4) — and only
 * while its evidence is fresh and still the latest successful scan (§2.2; a
 * superseded proposal is refused `superseded`, 409). The response carries the URL ONCE: the
 * database keeps only the token's sha256, so it cannot be shown again. It is
 * built from `AUTH_URL`, never the request's Host header, which a forged
 * header could otherwise point at somebody else's origin.
 *
 * `{ action: 'revoke', shareId }` withdraws one. The row stays: its views and
 * any acceptance are history.
 *
 * Nothing is sent from here. A person pastes the link into a message they
 * write (§8.4). The token and the URL are never logged; both are audited by
 * `shareMint`/`shareRevoke` as ids only.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_BODY = 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function answer(status: number, body: Record<string, unknown>): NextResponse {
  // `no-store` on every answer: the create answer is a credential.
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return answer(401, { error: 'unauthorized' })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return answer(403, { error: 'forbidden' })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return answer(404, { error: 'No such proposal.' })

  const raw = await request.text().catch(() => '')
  if (raw.length > MAX_BODY) return answer(413, { error: 'That request is too large.' })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return answer(400, { error: 'invalid_json' })
  }
  const { action, shareId } = (body ?? {}) as { action?: unknown; shareId?: unknown }
  const db = getDb() as unknown as AgencyDb

  if (action === 'create') {
    const r = await shareMint(db, { orgId: user.orgId, proposalId: id, createdBy: user.id, actor: user.id })
    if (!r.ok) {
      const status = r.reason === 'not_found' ? 404 : 409
      return answer(status, { error: r.message, reason: r.reason })
    }
    log.info('proposal share link created', { proposalId: id, shareId: r.share.id, cappedByEvidence: r.cappedByEvidence })
    return answer(201, {
      url: new URL(`/p/${r.token}`, env().AUTH_URL).toString(),
      share: { id: r.share.id, expiresAt: r.share.expiresAt.toISOString(), cappedByEvidence: r.cappedByEvidence },
    })
  }

  if (action === 'revoke') {
    if (typeof shareId !== 'string' || !UUID.test(shareId)) return answer(400, { error: 'shareId is required to revoke a link.' })
    // Scoped by org AND by the proposal in the path, so the audit row and
    // the log line name the proposal the link actually belonged to.
    const revoked = await shareRevoke(db, { orgId: user.orgId, proposalId: id, shareId, actor: user.id })
    if (!revoked) return answer(404, { error: 'No such live link — it may already have been revoked.' })
    log.info('proposal share link revoked', { proposalId: id, shareId })
    return answer(200, { ok: true })
  }

  return answer(400, { error: "action must be 'create' or 'revoke'" })
}
