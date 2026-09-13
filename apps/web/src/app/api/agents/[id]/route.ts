import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  agentDefInput, appendAudit, deleteAgentDef, readAgentDef, setAgentDefEnabled, updateAgentDef,
  type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Edit, enable, disable or remove a subagent (PROMPT.md §7).
 *
 * A PATCH with only `enabled` toggles it; a PATCH with a full body replaces
 * the definition. The slug is NOT editable: it is how the model names the
 * agent, how `agents` is keyed, and what every audit row about a delegation
 * refers to. Renaming it would silently orphan that history.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const guard = await authorise()
  if ('error' in guard) return guard.error
  const { user, db } = guard
  const { id } = await context.params

  const row = await readAgentDef(db, user.orgId, id)
  if (!row) return NextResponse.json({ error: 'No such agent.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const keys = Object.keys((body ?? {}) as Record<string, unknown>)
  if (keys.length === 1 && keys[0] === 'enabled') {
    const enabled = (body as { enabled: unknown }).enabled
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 })
    }
    await setAgentDefEnabled(db, user.orgId, id, enabled)
    await audit(db, user, id, enabled ? 'agent.enabled' : 'agent.disabled', { slug: row.slug })
    return NextResponse.json({ id, enabled })
  }

  // A full replacement. The slug comes from the ROW, never the body.
  const parsed = agentDefInput.safeParse({ ...(body as object), slug: row.slug })
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: `${first?.path.join('.') ?? 'input'}: ${first?.message ?? 'Invalid.'}` },
      { status: 400 },
    )
  }

  const updated = await updateAgentDef(db, user.orgId, id, parsed.data)
  await audit(db, user, id, 'agent.updated', {
    slug: row.slug,
    model: parsed.data.model ?? null,
    tools: parsed.data.tools,
  })
  return NextResponse.json({ id, enabled: updated?.enabled ?? false })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const guard = await authorise()
  if ('error' in guard) return guard.error
  const { user, db } = guard
  const { id } = await context.params

  const row = await readAgentDef(db, user.orgId, id)
  if (!row) return NextResponse.json({ error: 'No such agent.' }, { status: 404 })

  await deleteAgentDef(db, user.orgId, id)
  await audit(db, user, id, 'agent.deleted', { slug: row.slug })
  return NextResponse.json({ deleted: true })
}

type Who = { id: string; orgId: string; role: 'owner' | 'member' }

async function authorise(): Promise<{ user: Who; db: AgencyDb } | { error: NextResponse }> {
  const session = await auth()
  const user = session?.user
  if (!user) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'agents:write')
  } catch {
    return { error: NextResponse.json({ error: 'Only an owner can change an agent.' }, { status: 403 }) }
  }
  return { user: { id: user.id, orgId: user.orgId, role: user.role }, db: getDb() as unknown as AgencyDb }
}

async function audit(
  db: AgencyDb,
  user: Who,
  id: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action,
    subjectType: 'agent_def',
    subjectId: id,
    detail,
  }).catch(() => {})
}
