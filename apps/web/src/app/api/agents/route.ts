import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { agentDefInput, appendAudit, createAgentDef, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Add a subagent (PROMPT.md §7).
 *
 * A row here becomes an entry in the SDK's `agents` option at the start of the
 * next turn. What it may set is deliberately narrow — four fields — and the
 * narrowing is enforced in the worker (`runtime/agents.ts`, frozen whitelist),
 * not here: this route could be bypassed by a direct database write, and the
 * mapper cannot be.
 *
 * Owner-only, because a subagent is an instruction set the model will follow
 * with the agency's tools in its hands.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'agents:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can add an agent.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = agentDefInput.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: `${first?.path.join('.') ?? 'input'}: ${first?.message ?? 'Invalid.'}` },
      { status: 400 },
    )
  }

  const db = getDb() as unknown as AgencyDb
  let row
  try {
    row = await createAgentDef(db, user.orgId, parsed.data)
  } catch {
    return NextResponse.json(
      { error: `An agent with the slug "${parsed.data.slug}" already exists.` },
      { status: 409 },
    )
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'agent.created',
    subjectType: 'agent_def',
    subjectId: row.id,
    // The prompt is not recorded here: it can be long, and the row IS the
    // record of it. What matters for an audit is that it happened and who.
    detail: { slug: row.slug, model: row.model, tools: row.tools },
  }).catch(() => {})

  return NextResponse.json({ id: row.id, slug: row.slug }, { status: 201 })
}
