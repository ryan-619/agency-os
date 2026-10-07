import { NextResponse } from 'next/server'
import type { AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { playbookAnswer } from '../outcome'
import { ASSISTANT_MAX_REQUEST_BYTES, firstIssue, mayWriteAssistant, playbookSchema } from '../rules'

/**
 * Save the agency's playbook (0020) — the agency's own words, which the
 * worker appends to the AI's instructions on every turn, labelled as a
 * description and never as a rule. Owners only. An empty playbook is allowed:
 * it is how the AI stops being told anything. `savePlaybook` refuses, with a
 * sentence, one over its bound or carrying a U+0000, and audits counts only.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PUT(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteAssistant({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'Only an owner can change the playbook.' }, { status: 403 })
  }

  const raw = await request.text()
  if (raw.length > ASSISTANT_MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'That playbook is far too long.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = playbookSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 })

  const answer = await playbookAnswer(
    getDb() as unknown as AgencyDb,
    { orgId: user.orgId, actor: user.id, playbook: parsed.data.playbook },
    log,
  )
  return NextResponse.json(answer.body, { status: answer.status })
}
