import { NextResponse } from 'next/server'
import { nightShiftSave, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { bodyOf, principalFor } from '../../quotes/shared'

/**
 * Switch the night shift on or off, and set when it runs in which zone
 * (0025). An owner's (`agents:write`): it spends the agency's Places quota
 * every night with nobody watching, as the morning brief spends its model.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PUT(request: Request): Promise<NextResponse> {
  const who = await principalFor('agents:write')
  if (!who.ok) return who.response
  const read = await bodyOf(request, 1_000)
  if (!read.ok) return read.response
  const { enabled, runAt, timeZone } = read.body
  if (typeof enabled !== 'boolean' || typeof runAt !== 'string' || typeof timeZone !== 'string') {
    return NextResponse.json({ error: 'Say whether it runs, the time and the zone.' }, { status: 400 })
  }
  try {
    const r = await nightShiftSave(getDb() as unknown as AgencyDb, { orgId: who.user.orgId, enabled, runAt, timeZone, actor: who.user.id, updatedBy: who.user.id })
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.message }, { status: 400 })
  } catch (err) {
    log.error('night shift settings could not be saved', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The settings could not be saved. Try again.' }, { status: 500 })
  }
}
