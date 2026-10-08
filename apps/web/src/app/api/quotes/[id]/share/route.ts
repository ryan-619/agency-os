import { NextResponse } from 'next/server'
import { z } from 'zod'
import { quoteLapsed } from '@agency/core'
import { quoteRead, shareLinkMint, shareLinkRevoke, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { quoteLinkExpiry } from '@/lib/quote-load'
import { bodyOf, principalFor } from '../../shared'

/**
 * Make a link to a SENT quote for the buyer (0023), or revoke one. The link
 * opens until the quote's last valid day ends in India; the raw token is in
 * this answer and nowhere else.
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
    if (quote.status !== 'sent') {
      return NextResponse.json({ error: quote.status === 'draft' ? 'Mark the quote sent first.' : `This quote is ${quote.status}.` }, { status: 409 })
    }
    if (quoteLapsed(quote.validUntil, new Date())) {
      return NextResponse.json({ error: 'This quote’s validity has passed. Set a new "valid until" date, then send it again.' }, { status: 410 })
    }
    const { token } = await shareLinkMint(db, {
      orgId: who.user.orgId, kind: 'quote', companyId: quote.companyId, quoteId: quote.id,
      createdBy: who.user.id, actor: who.user.id, expiresAt: quoteLinkExpiry(quote.validUntil),
    })
    return NextResponse.json({ url: new URL(`/q/${token}`, env().AUTH_URL).toString() })
  } catch (err) {
    log.error('quote link could not be made', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The link could not be made. Try again.' }, { status: 500 })
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const who = await principalFor('deals:write')
  if (!who.ok) return who.response
  const read = await bodyOf(request, 1_000)
  if (!read.ok) return read.response
  const linkId = read.body['linkId']
  if (typeof linkId !== 'string' || !z.string().uuid().safeParse(linkId).success) {
    return NextResponse.json({ error: 'Which link?' }, { status: 400 })
  }
  const revoked = await shareLinkRevoke(getDb() as unknown as AgencyDb, { orgId: who.user.orgId, linkId, actor: who.user.id })
  return revoked ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'That link was already revoked.' }, { status: 409 })
}
