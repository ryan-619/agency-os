import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, credentialsDelete, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Delete a stored credential (PROMPT.md §2.3), from Settings → Credentials.
 *
 * Only an orphan can go. Removing a connector deliberately leaves its
 * credential behind, and this is where a person decides it is not coming
 * back. A credential a connector still points at is refused by the database
 * — `ON DELETE RESTRICT` — rather than by a check made here first, so there is
 * no window in which the answer changes between the check and the delete;
 * the refusal comes back as a 409 with a sentence naming the connector.
 *
 * Needs no `SECRETS_KEY`: deleting a row decrypts nothing.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'credentials:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can delete a credential.' }, { status: 403 })
  }
  const { id } = await context.params

  const db = getDb() as unknown as AgencyDb
  const result = await credentialsDelete(db, user.orgId, id)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message },
      { status: result.reason === 'referenced' ? 409 : 404 },
    )
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'credential.deleted',
    subjectType: 'secret',
    subjectId: id,
    // The label is the only thing that says what this was once the row is
    // gone. Never a value: the row held only ciphertext, and it was not read.
    detail: { label: result.label },
  }).catch(() => {})

  return NextResponse.json({ deleted: true })
}
