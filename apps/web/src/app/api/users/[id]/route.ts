import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { usersRestore, usersRevoke, usersSetRole, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Change one person's access (Settings → Team). Owner only: `users:write`.
 *
 *   { action: 'role', role: 'owner' | 'member' }
 *   { action: 'revoke' }
 *   { action: 'restore' }
 *
 * There is no DELETE, and that is the design rather than a gap: a person who
 * approved something, sent something or handled a reply is named by rows that
 * must outlive their access (§2.4), and 0004 already says "offboarding is a
 * role change, not a row deletion". Revoking ends every live session now and
 * refuses the next sign-in; restoring undoes it with nothing lost.
 *
 * The last-owner and self-revoke rules are decided by the statement in
 * `packages/db/src/users.ts`, not here — a check in this route a moment
 * before the write would let two owners remove each other at once. What this
 * file adds is the sentence each refusal is shown as.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REFUSED = {
  not_found: 'Nobody with that id is on this team.',
  last_owner: 'That is the last owner. Make somebody else an owner first, or nobody could manage the team.',
  self: 'You cannot revoke your own access. Another owner can.',
} as const

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'users:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can change somebody’s access.' }, { status: 403 })
  }

  const { id } = await context.params
  // A malformed id would reach Postgres as a uuid cast error and a 500.
  if (!UUID.test(id)) return NextResponse.json({ error: REFUSED.not_found }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { action, role } = (body ?? {}) as { action?: unknown; role?: unknown }

  const db = getDb() as unknown as AgencyDb
  const refusal = (reason: keyof typeof REFUSED): NextResponse =>
    NextResponse.json({ error: REFUSED[reason] }, { status: reason === 'not_found' ? 404 : 409 })

  if (action === 'role') {
    if (role !== 'owner' && role !== 'member') {
      return NextResponse.json({ error: 'role must be owner or member' }, { status: 400 })
    }
    const r = await usersSetRole(db, { orgId: user.orgId, userId: id, role, actor: user.id })
    if (!r.ok) return refusal(r.reason)
    return NextResponse.json({ id, role })
  }

  if (action === 'revoke') {
    const r = await usersRevoke(db, { orgId: user.orgId, userId: id, actor: user.id, actorUserId: user.id })
    if (!r.ok) return refusal(r.reason)
    return NextResponse.json({ id, revoked: true, sessionsEnded: r.sessionsEnded })
  }

  if (action === 'restore') {
    const r = await usersRestore(db, { orgId: user.orgId, userId: id, actor: user.id })
    if (!r.ok) return refusal(r.reason)
    return NextResponse.json({ id, revoked: false })
  }

  return NextResponse.json({ error: 'action must be role, revoke or restore' }, { status: 400 })
}
