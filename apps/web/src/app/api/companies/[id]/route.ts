import { NextResponse } from 'next/server'
import { assertCan, can } from '@agency/core'
import { appendAudit, companiesUpdate, companyPatchInput, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { companyDeleteAnswer, readDeleteBody } from '@/lib/delete-answer'
import { log } from '@/lib/logger'

/**
 * Edit a company's name, country or timezone (PROMPT.md §2.1).
 *
 * The timezone is the one with consequences: the send path checks quiet hours
 * in it for every contact here who has no zone of their own, and refuses to
 * send when neither has one. It is declared by a person, checked against the
 * runtime's zone database, and never derived from the country.
 *
 * The domain is not editable. Every scan, finding, score and proposal hangs
 * off it; a company that moved domains is a new company to scan.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'companies:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (body && typeof body === 'object' && 'domain' in body) {
    return NextResponse.json(
      { error: 'The domain cannot be edited — every scan and finding hangs off it. Import the new domain as a new company.' },
      { status: 400 },
    )
  }
  const parsed = companyPatchInput.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: `${first?.path.join('.') || 'input'}: ${first?.message ?? 'Invalid.'}` },
      { status: 400 },
    )
  }

  const db = getDb() as unknown as AgencyDb
  const result = await companiesUpdate(db, user.orgId, id, parsed.data)
  if (!result.ok) {
    // Another org's company is answered exactly as a missing one.
    return NextResponse.json({ error: result.message }, { status: result.reason === 'not_found' ? 404 : 400 })
  }

  if (result.changed.length > 0) {
    await appendAudit(db, {
      orgId: user.orgId,
      actor: user.id,
      action: 'company.updated',
      subjectType: 'company',
      subjectId: id,
      // The field NAMES, not the values (§2.3 reads a log more widely than a
      // table); the row itself holds what they are now.
      detail: { fields: result.changed },
    }).catch(() => {})
  }
  const c = result.company
  return NextResponse.json({
    id: c.id,
    changed: result.changed,
    company: { name: c.name, country: c.country, timeZone: c.timeZone },
  })
}

/**
 * Delete a company nothing ever went to or came from, with everything filed
 * under it (2026-10-15). An OWNER's (`users:write`), with the domain — a
 * no-website business's name — typed back as `{ confirm }`, as an erasure
 * takes the contact's id: it takes its people, deals, meetings, draft quotes
 * and proposals, scans, notes and links in one go, and a link a business was
 * sent stops opening. `companyDelete` refuses, with a sentence (409), a
 * company anything went to or came from, a person there who must be erased
 * instead, a won deal, a quote or proposal past draft, or a meeting with its
 * outcome recorded. Its `company.deleted` row keeps the night shift and the
 * assistant from filing it again.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'users:write')) {
    return NextResponse.json({ error: 'forbidden', message: 'Only an owner can delete a company.' }, { status: 403 })
  }
  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found', message: 'No such company.' }, { status: 404 })
  const read = readDeleteBody(await request.text())
  if (!read.ok) return NextResponse.json(read.answer.body, { status: read.answer.status })
  const a = await companyDeleteAnswer(
    getDb() as unknown as AgencyDb,
    { orgId: user.orgId, companyId: id.toLowerCase(), confirm: read.body.confirm, actor: user.id },
    log,
  )
  return NextResponse.json(a.body, { status: a.status })
}
