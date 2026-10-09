import { NextResponse } from 'next/server'
import { nightShiftRequest, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { principalFor } from '../../../quotes/shared'

/** "Run it now" (0025): the worker runs the night shift at its next look, whatever the clock says. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(): Promise<NextResponse> {
  const who = await principalFor('agents:write')
  if (!who.ok) return who.response
  const r = await nightShiftRequest(getDb() as unknown as AgencyDb, { orgId: who.user.orgId, actor: who.user.id })
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.message }, { status: 409 })
}
