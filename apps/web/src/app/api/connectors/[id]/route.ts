import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  appendAudit, deleteConnector, readConnector, setConnectorEnabled, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Enable, disable or remove a connector (PROMPT.md §6).
 *
 * Enabling is the consequential one. It is a SEPARATE action from adding, and
 * it is refused until Test connection has passed at least once: a connector
 * takes effect in the very next chat message, and nobody should be able to put
 * a server the agent will reach into that path without having seen it answer.
 *
 * Disabling is always allowed, immediately, with no conditions. It is the
 * thing a person reaches for when a connector is misbehaving, and a stop
 * button with preconditions is not a stop button.
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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 })
  }

  const row = await readConnector(db, user.orgId, id)
  if (!row) return NextResponse.json({ error: 'No such connector.' }, { status: 404 })

  if (enabled && !row.lastOkAt) {
    return NextResponse.json(
      {
        error:
          'Test the connection first. A connector takes effect in the next chat message, and ' +
          'this one has not answered yet.',
      },
      { status: 409 },
    )
  }

  const updated = await setConnectorEnabled(db, user.orgId, id, enabled)
  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: enabled ? 'connector.enabled' : 'connector.disabled',
    subjectType: 'connector',
    subjectId: id,
    detail: { name: row.name, kind: row.kind },
  }).catch(() => {})

  return NextResponse.json({ id, enabled: updated?.enabled ?? enabled })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const guard = await authorise()
  if ('error' in guard) return guard.error
  const { user, db } = guard
  const { id } = await context.params

  const row = await readConnector(db, user.orgId, id)
  if (!row) return NextResponse.json({ error: 'No such connector.' }, { status: 404 })

  await deleteConnector(db, user.orgId, id)
  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'connector.deleted',
    subjectType: 'connector',
    subjectId: id,
    detail: { name: row.name, kind: row.kind },
  }).catch(() => {})

  // The credential it pointed at is deliberately LEFT. `ON DELETE RESTRICT`
  // stopped it being removed while this row existed; now it is an orphan in
  // Settings → Credentials, where a person can see what it was for and decide.
  // Deleting it here would silently destroy a key that another connector might
  // be about to reuse.
  return NextResponse.json({ deleted: true, credentialKept: row.secretRef !== null })
}

async function authorise(): Promise<
  { user: { id: string; orgId: string; role: 'owner' | 'member' }; db: AgencyDb } | { error: NextResponse }
> {
  const session = await auth()
  const user = session?.user
  if (!user) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'connectors:write')
  } catch {
    return {
      error: NextResponse.json({ error: 'Only an owner can change a connector.' }, { status: 403 }),
    }
  }
  return { user: { id: user.id, orgId: user.orgId, role: user.role }, db: getDb() as unknown as AgencyDb }
}
