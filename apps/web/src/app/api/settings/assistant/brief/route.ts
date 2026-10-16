import { NextResponse } from 'next/server'
import type { AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { briefAnswer } from '../outcome'
import { ASSISTANT_MAX_REQUEST_BYTES, briefSchema, firstIssue, mayWriteAssistant } from '../rules'

/**
 * Switch the morning brief on or off, and set when it runs (0020). Owners
 * only. Switched on, it runs in the name of whoever saved it, in a thread of
 * theirs; switched off, a "Run it now" still waiting is dropped. `saveBrief`
 * refuses, with a sentence, a time that is not HH:MM or a zone this server
 * does not know.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PUT(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteAssistant({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'Only an owner can change the morning brief.' }, { status: 403 })
  }

  const raw = await request.text()
  if (raw.length > ASSISTANT_MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = briefSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 })

  const answer = await briefAnswer(
    getDb() as unknown as AgencyDb,
    { orgId: user.orgId, actor: user.id, ...parsed.data },
    log,
  )
  return NextResponse.json(answer.body, { status: answer.status })
}
