import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { researchDelete, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/** Remove one research claim (0028): the recorder's, an owner's, or anybody's for one the agent recorded. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'companies:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such research claim.' }, { status: 404 })
  const db = getDb() as unknown as AgencyDb
  const r = await researchDelete(db, { orgId: user.orgId, id, byUserId: user.id, isOwner: user.role === 'owner' })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'not_found' ? 404 : 403 })
  return NextResponse.json({ ok: true })
}
