import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, auditSuppressionRemoved, removeSuppression, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Remove a suppression (PROMPT.md §2.1).
 *
 * Owner-only, and the one write in this area that is: removing a suppression
 * is deciding that somebody who asked to be left alone may be contacted
 * again. It has to be possible — a row added by mistake must come off, and a
 * list that can only grow is a list nobody trusts — and it has to be
 * accountable, which is what the audit row is for. The audit row records the
 * value, the reason it was there, which path recorded it, and who removed
 * it; nothing else in this codebase deletes an opt-out.
 *
 * Built by `auditSuppressionRemoved`. It used to put the value in
 * `subjectId`, a uuid column, so the insert was refused and swallowed —
 * and a removal is exactly the write that most needed to be on the record.
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
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'users:write')
  } catch {
    return NextResponse.json(
      { error: 'Only an owner can remove a suppression — it means contacting someone who asked not to be.' },
      { status: 403 },
    )
  }

  const { id } = await context.params
  const db = getDb() as unknown as AgencyDb
  const removed = await removeSuppression(db, user.orgId, id)
  if (!removed) return NextResponse.json({ error: 'No such suppression.' }, { status: 404 })

  await appendAudit(db, auditSuppressionRemoved({ orgId: user.orgId, actor: user.id, removed })).catch(() => {})
  return NextResponse.json({ removed: true })
}
