import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  appendAudit, contactInput, createContact, linkedinIsReadable, linkedinUnreadable, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { addressSourceKind, personAddressSources } from '@/lib/address-source'
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
 *
 * Each address a person types here is recorded as theirs (0029): `person`
 * beside an email or a phone that was given, from the session and never the
 * body (`personAddressSources`). A body that names a source of its own —
 * "seen on a page", "the assistant was shown it" — is overridden, because
 * the screens that show where an address came from would otherwise show
 * whatever a request claimed.
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

  // A LinkedIn URL is stored only when it can be read as a profile, as an
  // edit requires: one that cannot gives no suppression key, so an opt-out
  // recorded against the person's profile would never match them.
  if (parsed.data.linkedinUrl && !linkedinIsReadable(parsed.data.linkedinUrl)) {
    return NextResponse.json({ error: linkedinUnreadable(parsed.data.linkedinUrl) }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const result = await createContact(db, user.orgId, { ...parsed.data, ...personAddressSources(parsed.data) })
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 })

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'contact.created',
    subjectType: 'contact',
    subjectId: result.contact.id,
    // Not the address (§2.3 reads a log more widely than a table). The
    // company and the source say enough — and where each address came from
    // as a KIND word (0029), `person` or null, never the source itself.
    detail: {
      companyId: result.contact.companyId,
      source: result.contact.source,
      hasTimeZone: !!result.contact.timeZone,
      emailSourceKind: addressSourceKind(result.contact.emailSource),
      phoneSourceKind: addressSourceKind(result.contact.phoneSource),
    },
  }).catch(() => {})
  return NextResponse.json({ id: result.contact.id }, { status: 201 })
}
