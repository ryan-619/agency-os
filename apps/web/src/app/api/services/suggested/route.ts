import { NextResponse } from 'next/server'
import { servicesAddSuggested, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { mayWriteServices } from '../rules'

/** Add the suggested starting catalogue, skipping any name already here, with no prices (0022). */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteServices({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'Only an owner can change the services catalogue.' }, { status: 403 })
  }
  const r = await servicesAddSuggested(getDb() as unknown as AgencyDb, { orgId: user.orgId, createdBy: user.id, actor: user.id })
  return NextResponse.json(r)
}
