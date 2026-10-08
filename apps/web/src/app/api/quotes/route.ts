import { NextResponse } from 'next/server'
import { z } from 'zod'
import { quoteCreate, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { bodyOf, principalFor, statusFor } from './shared'
import { itemsFrom, quoteItemsInput } from './items'

/**
 * Raise a draft quote for a company (0023): its lines prefilled from the
 * services its needs point at, unless lines or services are given.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const input = z.object({
  companyId: z.string().uuid(),
  contactId: z.string().uuid().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  intro: z.string().max(4000).nullable().optional(),
  serviceIds: z.array(z.string().uuid()).max(30).nullable().optional(),
  items: quoteItemsInput.nullable().optional(),
}).strict()

export async function POST(request: Request): Promise<NextResponse> {
  const who = await principalFor('deals:write')
  if (!who.ok) return who.response
  const read = await bodyOf(request, 64_000)
  if (!read.ok) return read.response
  const parsed = input.safeParse(read.body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, { status: 400 })
  try {
    const r = await quoteCreate(getDb() as unknown as AgencyDb, {
      orgId: who.user.orgId,
      companyId: parsed.data.companyId,
      contactId: parsed.data.contactId ?? null,
      title: parsed.data.title ?? null,
      intro: parsed.data.intro ?? null,
      serviceIds: parsed.data.serviceIds ?? null,
      items: parsed.data.items ? itemsFrom(parsed.data.items) : null,
      createdBy: who.user.id,
      actor: who.user.id,
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: statusFor(r.reason) })
    return NextResponse.json({ id: r.quote.id, number: r.quote.number })
  } catch (err) {
    log.error('quote could not be raised', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The quote could not be raised. Nothing changed; try again.' }, { status: 500 })
  }
}
