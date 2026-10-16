import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import { contactDelete, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { bulkDeleteAnswer, parseBulkDelete, readDeleteBody } from '@/lib/delete-answer'
import { log } from '@/lib/logger'
import { BULK_MAX } from '@/lib/delete-view'

/**
 * Delete several people at once (2026-10-15) — what /contacts' "Delete
 * selected" sends, mostly to clear the people the chat agent invented before
 * 0029.
 *
 * Any member who may change contacts, as one contact's delete is; at most a
 * hundred a request. Each goes through `contactDelete` in a transaction of
 * its own, so a person kept — written to, or one who said no — keeps only
 * themselves, and the answer says per person which went and, for the rest,
 * the writer's sentence (`{ results: [{ id, ok, code?, message? }] }`).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:write')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const read = readDeleteBody(await request.text())
  if (!read.ok) return NextResponse.json(read.answer.body, { status: read.answer.status })
  const asked = parseBulkDelete(read.body, { max: BULK_MAX.contacts, confirmCount: false, noun: 'person' })
  if (!asked.ok) return NextResponse.json(asked.answer.body, { status: asked.answer.status })

  const db = getDb() as unknown as AgencyDb
  const a = await bulkDeleteAnswer(
    'contact',
    asked.ids,
    (contactId) => contactDelete(db, { orgId: user.orgId, contactId, actor: user.id }),
    log,
  )
  return NextResponse.json(a.body, { status: a.status })
}
