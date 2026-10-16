import { NextResponse } from 'next/server'
import { nightSearchAdd, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { bodyOf, principalFor } from '../../../quotes/shared'

/** Save a search the night shift runs (0025): what and where, as a person types it into Google Maps. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const who = await principalFor('agents:write')
  if (!who.ok) return who.response
  const read = await bodyOf(request, 2_000)
  if (!read.ok) return read.response
  const { query, region, city } = read.body
  if (typeof query !== 'string') return NextResponse.json({ error: 'What should it search for?' }, { status: 400 })
  try {
    const r = await nightSearchAdd(getDb() as unknown as AgencyDb, {
      orgId: who.user.orgId, query, region: typeof region === 'string' ? region : null, city: typeof city === 'string' ? city : null,
      createdBy: who.user.id, actor: who.user.id,
    })
    return r.ok ? NextResponse.json({ ok: true, id: r.search.id }) : NextResponse.json({ error: r.message }, { status: 400 })
  } catch (err) {
    log.error('night search could not be saved', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The search could not be saved. Try again.' }, { status: 500 })
  }
}
