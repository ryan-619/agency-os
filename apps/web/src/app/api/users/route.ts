import { NextResponse } from 'next/server'
import { assertCan, normaliseEmail } from '@agency/core'
import { usersGrant, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Grant somebody access (Settings → Team). Owner only: `users:write`.
 *
 * Nothing is sent from here. There is no invitation mail and no signup flow
 * (§1): the row written is what lets `/signin` mail this address a link when
 * the person asks for one, and nothing before that.
 *
 * The refusals are the point of this file. `users_email_key` is global, so an
 * address held by another organisation on this deployment fails the insert
 * too — and a sentence that said so would make this form the roster oracle
 * `auth.ts` goes to some length to close (§2.3). `usersGrant` answers that
 * case, and every other one it cannot explain, with ONE sentence; this route
 * passes it through with the same 409 as a same-org repeat, and logs nothing
 * that names the address.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** RFC 5321's path limit, before any folding. Anything longer is not an address. */
const MAX_EMAIL = 320
const MAX_NAME = 120

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'users:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can give somebody access.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { email, name, role } = (body ?? {}) as { email?: unknown; name?: unknown; role?: unknown }

  if (typeof email !== 'string' || !email.trim() || email.length > MAX_EMAIL) {
    return NextResponse.json({ error: 'An email address is required.' }, { status: 400 })
  }
  // An address that cannot be read is a statement about the string, not about
  // who holds it, so it may say so — and with a 400, as every other malformed
  // field gets.
  if (!normaliseEmail(email)) {
    return NextResponse.json({ error: 'That could not be read as an email address.' }, { status: 400 })
  }
  if (role !== 'owner' && role !== 'member') {
    return NextResponse.json({ error: 'role must be owner or member' }, { status: 400 })
  }
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > MAX_NAME)) {
    return NextResponse.json({ error: `A name is text, at most ${MAX_NAME} characters.` }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const result = await usersGrant(db, {
    orgId: user.orgId,
    email,
    name: typeof name === 'string' ? name : null,
    role,
    actor: user.id,
  })
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 409 })

  // The id and role only: the browser that asked already has the address.
  return NextResponse.json({ id: result.user.id, role: result.user.role }, { status: 201 })
}
