import { NextResponse } from 'next/server'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { SHARE_LINK_TTL_DAYS, schema, shareLinkDraftEmail, shareLinkMint, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { orgIdentity } from '@/lib/org-identity'
import { bodyOf, principalFor } from '../../../../quotes/shared'

/**
 * Draft the email that carries a business's audit page or website preview
 * (2026-10-08): a fresh link, and an email awaiting approval with it.
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
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, who.user.orgId), eq(schema.companies.id, id)))
      .limit(1)
    if (!company) return NextResponse.json({ error: 'That company does not exist.' }, { status: 404 })
    const { token } = await shareLinkMint(db, {
      orgId: who.user.orgId, kind, companyId: id, createdBy: who.user.id, actor: who.user.id,
      expiresAt: new Date(Date.now() + SHARE_LINK_TTL_DAYS * 86_400_000),
    })
    const org = await orgIdentity(who.user.orgId)
    const r = await shareLinkDraftEmail(db, {
      orgId: who.user.orgId, companyId: id, kind, url: new URL(`${PATH[kind]}${token}`, env().AUTH_URL).toString(),
      agencyName: org.name, actor: who.user.id,
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: 404 })
    return NextResponse.json({ ok: true, touchId: r.touchId })
  } catch (err) {
    log.error('share email could not be drafted', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The email could not be drafted. Try again.' }, { status: 500 })
  }
}
