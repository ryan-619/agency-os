import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, companiesUpdate, companyPatchInput, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

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
