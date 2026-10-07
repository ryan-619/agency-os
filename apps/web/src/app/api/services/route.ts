import { NextResponse } from 'next/server'
import { serviceCreate, servicesList, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { SERVICE_MAX_REQUEST_BYTES, mayReadServices, mayWriteServices } from './rules'

/**
 * The services catalogue (0022): GET lists it, POST adds a service — an
 * owner's act, audited `service.created`. A taken name is a 409 with a
 * sentence; a fault is a 500 logged by class only.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayReadServices({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const services = await servicesList(getDb() as unknown as AgencyDb, user.orgId)
  return NextResponse.json({ services })
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteServices({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'Only an owner can change the services catalogue.' }, { status: 403 })
  }
  const raw = await request.text()
  if (raw.length > SERVICE_MAX_REQUEST_BYTES) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    const r = await serviceCreate(getDb() as unknown as AgencyDb, { orgId: user.orgId, input: body, createdBy: user.id, actor: user.id })
    if (!r.ok) return NextResponse.json({ error: r.message, reason: r.reason }, { status: r.reason === 'name_taken' ? 409 : 400 })
    return NextResponse.json({ service: r.service }, { status: 201 })
  } catch (err) {
    log.error('service create failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The service could not be saved. Nothing changed; try again.' }, { status: 500 })
  }
}
