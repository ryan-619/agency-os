import { NextResponse } from 'next/server'
import { z } from 'zod'
import { quoteSend, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { principalFor, statusFor } from '../../shared'

/** Mark a draft quote SENT (0023) — a person's act — fixing the seller's details on it. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('deals:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    const r = await quoteSend(getDb() as unknown as AgencyDb, { orgId: who.user.orgId, quoteId: id, actor: who.user.id })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: statusFor(r.reason) })
    return NextResponse.json({ ok: true })
  } catch (err) {
    log.error('quote could not be marked sent', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The quote could not be marked sent. Nothing changed; try again.' }, { status: 500 })
  }
}
