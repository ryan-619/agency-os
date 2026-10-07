import { NextResponse } from 'next/server'
import { serviceDelete, serviceUpdate, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { SERVICE_MAX_REQUEST_BYTES, mayWriteServices } from '../rules'

/** Change or remove one service (0022) — an owner's act, audited. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteServices({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'Only an owner can change the services catalogue.' }, { status: 403 })
  }
  const { id } = await context.params
  const raw = await request.text()
  if (raw.length > SERVICE_MAX_REQUEST_BYTES) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    const r = await serviceUpdate(getDb() as unknown as AgencyDb, { orgId: user.orgId, id, input: body, actor: user.id })
    if (!r.ok) {
      const status = r.reason === 'not_found' ? 404 : r.reason === 'name_taken' ? 409 : 400
      return NextResponse.json({ error: r.message, reason: r.reason }, { status })
    }
    return NextResponse.json({ service: r.service })
  } catch (err) {
    log.error('service update failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The change could not be saved. Nothing changed; try again.' }, { status: 500 })
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteServices({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'Only an owner can change the services catalogue.' }, { status: 403 })
  }
  const { id } = await context.params
  const r = await serviceDelete(getDb() as unknown as AgencyDb, { orgId: user.orgId, id, actor: user.id })
  if (!r.ok) return NextResponse.json({ error: 'No such service.' }, { status: 404 })
  return NextResponse.json({ deleted: true })
}
