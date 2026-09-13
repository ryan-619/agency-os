import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, readConnector, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { agentConfigured, probeConnector } from '@/lib/agent'

/**
 * Test connection (PROMPT.md §6).
 *
 * The work happens in the worker, because the SDK lives there: it starts a
 * throwaway session with just this one server, asks what tools it exposes, and
 * writes `last_ok_at` or `last_error`. This route proves who is asking and
 * forwards the request.
 *
 * The tool list is the point, not the tick. A connector's tools each need a
 * human on every call (the risk classifier rates an unreviewed third-party
 * tool `high`), so this is the one moment anyone sees what they are about to
 * let the agent reach — before enabling it, which is a separate action that
 * this route's success unlocks.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'connectors:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can test a connector.' }, { status: 403 })
  }
  if (!agentConfigured()) {
    return NextResponse.json(
      { error: 'The agent worker is not configured, so there is nothing to test with.' },
      { status: 503 },
    )
  }

  const { id } = await context.params
  const db = getDb() as unknown as AgencyDb
  const row = await readConnector(db, user.orgId, id)
  if (!row) return NextResponse.json({ error: 'No such connector.' }, { status: 404 })

  const result = await probeConnector(user.orgId, id)
  if (!result) {
    return NextResponse.json(
      { error: 'The agent worker is not responding, so the connector could not be tested.' },
      { status: 503 },
    )
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: result.ok ? 'connector.probe_ok' : 'connector.probe_failed',
    subjectType: 'connector',
    subjectId: id,
    // The tool NAMES are worth keeping: they are what a person was shown
    // before enabling, and the audit log is where "what did this server offer
    // at the time?" gets answered. The message is already sanitised by the
    // worker; a URL never appears in either.
    detail: { name: row.name, kind: row.kind, tools: result.tools.map((t) => t.name) },
  }).catch(() => {})

  return NextResponse.json(result)
}
