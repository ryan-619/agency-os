import { NextResponse } from 'next/server'
import { z } from 'zod'
import { campaignStepsSave, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { bodyOf, principalFor } from '../../../quotes/shared'

/**
 * Set a campaign's follow-up steps (0024): another message on its channel, a
 * call or a visit, each some days after the step before. The steps replace
 * whatever was there; a person already being followed up carries on from
 * where they are. Nothing is sent here — a message step drafts for
 * /approvals, or queues where the campaign auto-sends, when its day comes.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const stepInput = z.object({
  kind: z.enum(['message', 'call', 'visit']),
  afterDays: z.number().int(),
  subject: z.string().max(400).nullable().optional(),
  body: z.string().max(8_000).nullable().optional(),
})
const input = z.object({ steps: z.array(stepInput).max(20) }).strict()

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('campaigns:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const read = await bodyOf(request, 64_000)
  if (!read.ok) return read.response
  const parsed = input.safeParse(read.body)
  if (!parsed.success) return NextResponse.json({ error: 'Each step is a message, a call or a visit, with its days.' }, { status: 400 })
  try {
    const r = await campaignStepsSave(getDb() as unknown as AgencyDb, {
      orgId: who.user.orgId,
      campaignId: id,
      actor: who.user.id,
      steps: parsed.data.steps.map((s, i) => ({
        position: i + 2,
        kind: s.kind,
        afterDays: s.afterDays,
        subject: s.kind === 'message' ? s.subject ?? null : null,
        body: s.kind === 'message' ? s.body ?? null : null,
      })),
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'not_found' ? 404 : 400 })
    return NextResponse.json({ ok: true, steps: r.steps.length })
  } catch (err) {
    log.error('campaign steps could not be saved', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The steps could not be saved. Try again.' }, { status: 500 })
  }
}
