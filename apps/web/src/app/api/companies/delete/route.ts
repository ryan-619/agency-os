import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import { companyDelete, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { bulkDeleteAnswer, parseBulkDelete, readDeleteBody } from '@/lib/delete-answer'
import { log } from '@/lib/logger'
import { BULK_MAX } from '@/lib/delete-view'

/**
 * Delete several companies at once (2026-10-15) — what /companies' "Delete
 * selected" sends, mostly to clear what the chat agent filed before 0029.
 *
 * An owner's (`users:write`), as one company's delete is, with the number
 * chosen typed back as `confirm` in place of each domain. At most fifty a
 * request. Each goes through `companyDelete` in a transaction of its own, so
 * a company kept — something went to it, a person there must be erased —
 * keeps only itself, and the answer says per company which went and, for
 * the rest, the writer's sentence (`{ results: [{ id, ok, code?, message? }] }`).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'users:write')) {
    return NextResponse.json({ error: 'forbidden', message: 'Only an owner can delete companies.' }, { status: 403 })
  }
  const read = readDeleteBody(await request.text())
  if (!read.ok) return NextResponse.json(read.answer.body, { status: read.answer.status })
  const asked = parseBulkDelete(read.body, { max: BULK_MAX.companies, confirmCount: true, noun: 'company' })
  if (!asked.ok) return NextResponse.json(asked.answer.body, { status: asked.answer.status })

  const db = getDb() as unknown as AgencyDb
  const a = await bulkDeleteAnswer(
    'company',
    asked.ids,
    (companyId) => companyDelete(db, { orgId: user.orgId, companyId, actor: user.id }),
    log,
  )
  return NextResponse.json(a.body, { status: a.status })
}
