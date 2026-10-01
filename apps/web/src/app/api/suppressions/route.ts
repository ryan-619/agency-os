import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { addSuppression, appendAudit, auditSuppressionAdded, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Add to the suppression list (PROMPT.md §2.1).
 *
 * "A `suppression` table wins over everything." Any member may add to it —
 * an opt-out somebody received by phone must be recordable by whoever took
 * the call, without waiting for an owner — and the value is normalised on the
 * way in so that equality means equality when the send path looks it up.
 *
 * A value that cannot be normalised is REFUSED with a message that says what
 * the consequence would be. The alternative, storing it as typed, is an
 * opt-out that never matches: worse than the error.
 *
 * The row says it was added here — `source: 'manual'` (0018) — because
 * "how did this person come to be on the list?" is a question an auditor
 * asks, and the answer is a column, not a guess from the reason.
 *
 * The audit entry comes from `auditSuppressionAdded`. It used to be built
 * inline with the address as `subjectId`, a uuid column, so every insert was
 * refused and swallowed: no suppression added here was ever on the record.
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
  const { kind, value, reason } = (body ?? {}) as { kind?: unknown; value?: unknown; reason?: unknown }
  if (kind !== 'email' && kind !== 'domain' && kind !== 'phone' && kind !== 'linkedin') {
    return NextResponse.json({ error: 'kind must be email, domain, phone or linkedin' }, { status: 400 })
  }
  if (typeof value !== 'string' || typeof reason !== 'string') {
    return NextResponse.json({ error: 'value and reason are required' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const result = await addSuppression(db, { orgId: user.orgId, kind, value, reason, source: 'manual' })
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 })

  await appendAudit(
    db,
    auditSuppressionAdded({
      orgId: user.orgId, actor: user.id, alreadyPresent: result.alreadyPresent, kind, value: result.value, reason,
    }),
  ).catch(() => {})
  return NextResponse.json(result, { status: result.alreadyPresent ? 200 : 201 })
}
