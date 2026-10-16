import { NextResponse } from 'next/server'
import type { AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { briefRunAnswer } from '../../outcome'
import { mayWriteAssistant } from '../../rules'

/**
 * "Run it now" (0020): ask the worker for a brief at its next look, whatever
 * the clock says. Owners only, and only while the brief is on and the person
 * it runs as still has access. Nothing runs here — the web app has no model —
 * so the answer is 202: the worker starts it within a minute, where a worker
 * with chat on is running, and the brief lands in that person's chat threads.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteAssistant({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'Only an owner can run the morning brief.' }, { status: 403 })
  }
  const answer = await briefRunAnswer(getDb() as unknown as AgencyDb, { orgId: user.orgId, actor: user.id }, log)
  return NextResponse.json(answer.body, { status: answer.status })
}
