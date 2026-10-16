import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import { icpProfileDelete, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { deleteAnswer } from '@/lib/delete-answer'
import { log } from '@/lib/logger'

/**
 * Delete an ICP profile that is not active and never scored anything
 * (2026-10-15) — an owner's (`agents:write`), as creating and activating
 * one are. The active profile is refused (409: activate another first), and
 * so is one a stored score names (`ON DELETE RESTRICT`, 0002): it stays as
 * that number's record. A profile is never edited in place; a mistaken one
 * nothing was judged by is the only kind that goes.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'agents:write')) {
    return NextResponse.json({ error: 'forbidden', message: 'Only an owner can delete a profile.' }, { status: 403 })
  }
  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found', message: 'No such profile.' }, { status: 404 })
  const a = await deleteAnswer(
    'icp',
    () => icpProfileDelete(getDb() as unknown as AgencyDb, { orgId: user.orgId, profileId: id.toLowerCase(), actor: user.id }),
    log,
  )
  return NextResponse.json(a.body, { status: a.status })
}
