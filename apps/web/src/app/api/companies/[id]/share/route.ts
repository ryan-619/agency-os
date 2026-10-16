import { NextResponse } from 'next/server'
import { z } from 'zod'
import { schema, shareLinkMint, shareLinkRevoke, SHARE_LINK_TTL_DAYS, type AgencyDb } from '@agency/db/queries'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { bodyOf, principalFor } from '../../../quotes/shared'

/**
 * Make a link to a business's own audit page or website preview
 * (2026-10-08), or revoke one. A link is not a send: a person puts it in a
 * message they write, or in an email that waits on /approvals. It opens for
 * 30 days; the raw token is in this answer and nowhere else.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PATH: Readonly<Record<'report' | 'preview', string>> = { report: '/r/', preview: '/w/' }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const who = await principalFor('companies:write')
  if (!who.ok) return who.response
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const read = await bodyOf(request, 1_000)
  if (!read.ok) return read.response
  const kind = read.body['kind']
  if (kind !== 'report' && kind !== 'preview') return NextResponse.json({ error: 'Which page: report or preview?' }, { status: 400 })
  try {
    const db = getDb() as unknown as AgencyDb
    const [company] = await db
      .select({ id: schema.companies.id, listingCheckedAt: schema.companies.listingCheckedAt })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, who.user.orgId), eq(schema.companies.id, id)))
      .limit(1)
    if (!company) return NextResponse.json({ error: 'That company does not exist.' }, { status: 404 })
    if (kind === 'preview' && company.listingCheckedAt === null) {
      return NextResponse.json({ error: 'A preview is built from its Google listing, and none is on record. Find it on the map in Chat first.' }, { status: 409 })
    }
    const { token } = await shareLinkMint(db, {
      orgId: who.user.orgId, kind, companyId: id, createdBy: who.user.id, actor: who.user.id,
      expiresAt: new Date(Date.now() + SHARE_LINK_TTL_DAYS * 86_400_000),
    })
    return NextResponse.json({ url: new URL(`${PATH[kind]}${token}`, env().AUTH_URL).toString() })
  } catch (err) {
    log.error('share link could not be made', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The link could not be made. Try again.' }, { status: 500 })
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const who = await principalFor('companies:write')
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
