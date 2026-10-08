import { NextResponse } from 'next/server'
import { z } from 'zod'
import { quoteDecide, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { bodyOf, principalFor, statusFor } from '../../shared'

/**
 * Record a buyer's answer to a SENT quote by hand (0023) — they said yes on
 * the phone — or withdraw it. Accepting closes the deal won.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const input = z.object({
  to: z.enum(['accepted', 'declined', 'withdrawn']),
  name: z.string().max(120).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
}).strict()

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('deals:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const read = await bodyOf(request, 4_000)
  if (!read.ok) return read.response
  const parsed = input.safeParse(read.body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, { status: 400 })
  try {
    const r = await quoteDecide(getDb() as unknown as AgencyDb, {
      orgId: who.user.orgId,
      quoteId: id,
      to: parsed.data.to,
      via: 'person',
      acceptedByName: parsed.data.name ?? null,
      reason: parsed.data.reason ?? null,
      actor: who.user.id,
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: statusFor(r.reason) })
    return NextResponse.json({ ok: true })
  } catch (err) {
    log.error('quote decision could not be recorded', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'That could not be recorded. Nothing changed; try again.' }, { status: 500 })
  }
}
