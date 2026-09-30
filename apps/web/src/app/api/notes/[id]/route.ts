import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { notesDelete, notesPin, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Pin or delete one note.
 *
 * Anyone who may write to companies may pin a note — pinning changes the
 * order a page lists them in and nothing else. Deleting is narrower: the
 * person who wrote it, or an owner. That rule lives in `notesDelete`'s own
 * predicate rather than here, so there is no gap between checking who wrote
 * it and removing it.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f-]{36}$/i

type Signed = { id: string; orgId: string; role: 'owner' | 'member' }

async function signedIn(): Promise<Signed | NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'companies:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return { id: user.id, orgId: user.orgId, role: user.role }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await signedIn()
  if (user instanceof NextResponse) return user
  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such note.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { pinned } = (body ?? {}) as { pinned?: unknown }
  if (typeof pinned !== 'boolean') return NextResponse.json({ error: 'pinned must be true or false' }, { status: 400 })

  const r = await notesPin(getDb() as unknown as AgencyDb, user.orgId, id, pinned)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: 404 })
  return NextResponse.json({ id: r.note.id, pinned: r.note.pinned })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await signedIn()
  if (user instanceof NextResponse) return user
  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such note.' }, { status: 404 })

  const r = await notesDelete(getDb() as unknown as AgencyDb, {
    orgId: user.orgId,
    id,
    byUserId: user.id,
    isOwner: user.role === 'owner',
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'not_permitted' ? 403 : 404 })
  return NextResponse.json({ id, deleted: true })
}
