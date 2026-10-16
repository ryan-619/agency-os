import { NextResponse } from 'next/server'
import { z } from 'zod'
import { nightSearchRemove, nightSearchSetActive, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { bodyOf, principalFor } from '../../../../quotes/shared'

/** Pause, resume or remove a saved night search (0025). */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('agents:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const read = await bodyOf(request, 200)
  if (!read.ok) return read.response
  if (typeof read.body['active'] !== 'boolean') return NextResponse.json({ error: 'On or off?' }, { status: 400 })
  const done = await nightSearchSetActive(getDb() as unknown as AgencyDb, { orgId: who.user.orgId, searchId: id, active: read.body['active'], actor: who.user.id })
  return done ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'That search does not exist.' }, { status: 404 })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('agents:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const done = await nightSearchRemove(getDb() as unknown as AgencyDb, { orgId: who.user.orgId, searchId: id, actor: who.user.id })
  return done ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'That search does not exist.' }, { status: 404 })
}
