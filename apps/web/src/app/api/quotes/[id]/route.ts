import { NextResponse } from 'next/server'
import { z } from 'zod'
import { quoteDelete, quoteUpdate, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { bodyOf, principalFor, statusFor } from '../shared'
import { itemsFrom, quoteItemsInput } from '../items'
import { deleteAnswer } from '@/lib/delete-answer'

/**
 * Change a quote (0023): a draft, or a sent one — which returns to a draft
 * with its links revoked. Lands only over the version the editor loaded.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const input = z.object({
  title: z.string().max(200).optional(),
  intro: z.string().max(4000).nullable().optional(),
  items: quoteItemsInput.optional(),
  contactId: z.string().uuid().nullable().optional(),
  advancePercent: z.number().optional(),
  validUntil: z.string().max(10).optional(),
  terms: z.string().max(4000).nullable().optional(),
  expectedUpdatedAt: z.string().max(40).nullable().optional(),
}).strict()

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('deals:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const read = await bodyOf(request, 64_000)
  if (!read.ok) return read.response
  const parsed = input.safeParse(read.body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, { status: 400 })
  const { expectedUpdatedAt, items, ...rest } = parsed.data
  try {
    const r = await quoteUpdate(getDb() as unknown as AgencyDb, {
      orgId: who.user.orgId,
      quoteId: id,
      patch: { ...rest, ...(items ? { items: itemsFrom(items) } : {}) },
      expectedUpdatedAt: expectedUpdatedAt ?? null,
      actor: who.user.id,
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: statusFor(r.reason) })
    return NextResponse.json({ ok: true, revised: r.revised ?? false, updatedAt: (r.quote.updatedAt ?? r.quote.createdAt).toISOString() })
  } catch (err) {
    log.error('quote could not be saved', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The quote could not be saved. Nothing changed; try again.' }, { status: 500 })
  }
}

/**
 * Delete a draft quote (2026-10-15) — `deals:write`, as editing one is. A
 * sent quote is refused (409): it is withdrawn instead, and stays. The next
 * quote raised this year may take a deleted draft's number.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('deals:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found', message: 'No such quote.' }, { status: 404 })
  const a = await deleteAnswer(
    'quote',
    () => quoteDelete(getDb() as unknown as AgencyDb, { orgId: who.user.orgId, quoteId: id.toLowerCase(), actor: who.user.id }),
    log,
  )
  return NextResponse.json(a.body, { status: a.status })
}
