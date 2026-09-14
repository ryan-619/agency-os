import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, contactInput, createContact, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Add a contact (PROMPT.md §8.4).
 *
 * A message goes to a person, and this is where a person is recorded. Two
 * things about them are what the send path will ask for later, and the form
 * says so: a timezone (without one, nothing can be sent to them — quiet hours
 * cannot be checked), and consent per channel, which is recorded separately
 * and is NOT created here. A new contact has no consent rows, which §2.1
 * reads as "no" for the opt-in channels and as "nothing recorded" for the
 * cold ones.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = contactInput.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: `${first?.path.join('.') ?? 'input'}: ${first?.message ?? 'Invalid.'}` },
      { status: 400 },
    )
  }

  const db = getDb() as unknown as AgencyDb
  const result = await createContact(db, user.orgId, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 })

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'contact.created',
    subjectType: 'contact',
    subjectId: result.contact.id,
    // Not the address (§2.3 reads a log more widely than a table). The
    // company and the source say enough.
    detail: { companyId: result.contact.companyId, source: result.contact.source, hasTimeZone: !!result.contact.timeZone },
  }).catch(() => {})
  return NextResponse.json({ id: result.contact.id }, { status: 201 })
}
