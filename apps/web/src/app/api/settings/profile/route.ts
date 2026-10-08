import { NextResponse } from 'next/server'
import { orgProfileSave, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { bodyOf, principalFor } from '../../quotes/shared'

/**
 * Save the agency's business profile (0023): what quotes print about the
 * seller. Owners only — the capability that manages the team — because a
 * GSTIN and a UPI ID are where the agency's money goes.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PUT(request: Request): Promise<NextResponse> {
  const who = await principalFor('users:write')
  if (!who.ok) return who.response
  const read = await bodyOf(request, 16_000)
  if (!read.ok) return read.response
  try {
    const r = await orgProfileSave(getDb() as unknown as AgencyDb, {
      orgId: who.user.orgId, input: read.body, actor: who.user.id, updatedBy: who.user.id,
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    log.error('business profile could not be saved', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The profile could not be saved. Nothing changed; try again.' }, { status: 500 })
  }
}
