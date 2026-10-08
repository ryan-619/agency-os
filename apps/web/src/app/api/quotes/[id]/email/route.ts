import { NextResponse } from 'next/server'
import { z } from 'zod'
import { quoteLapsed } from '@agency/core'
import { quoteDraftEmail, quoteRead, shareLinkMint, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { quoteLinkExpiry } from '@/lib/quote-load'
import { principalFor, statusFor } from '../../shared'

/**
 * Draft the email that carries a sent quote (0023): a fresh link, and an
 * email awaiting approval on /approvals with it — sent, like every email,
 * only after a person approves it and the send path checks it.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('deals:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    const db = getDb() as unknown as AgencyDb
    const quote = await quoteRead(db, who.user.orgId, id)
    if (!quote) return NextResponse.json({ error: 'That quote does not exist.' }, { status: 404 })
    if (quote.status !== 'sent') return NextResponse.json({ error: 'Mark the quote sent first.' }, { status: 409 })
    if (quoteLapsed(quote.validUntil, new Date())) {
      return NextResponse.json({ error: 'This quote’s validity has passed. Set a new "valid until" date, then send it again.' }, { status: 410 })
    }
    const { token } = await shareLinkMint(db, {
      orgId: who.user.orgId, kind: 'quote', companyId: quote.companyId, quoteId: quote.id,
      createdBy: who.user.id, actor: who.user.id, expiresAt: quoteLinkExpiry(quote.validUntil),
    })
    const url = new URL(`/q/${token}`, env().AUTH_URL).toString()
    const r = await quoteDraftEmail(db, { orgId: who.user.orgId, quoteId: quote.id, url, actor: who.user.id })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: statusFor(r.reason) })
    return NextResponse.json({ ok: true, touchId: r.touchId })
  } catch (err) {
    log.error('quote email could not be drafted', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The email could not be drafted. Try again.' }, { status: 500 })
  }
}
