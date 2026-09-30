import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  LEGACY_AGENCY_CONNECTOR_MESSAGE, appendAudit, connectorToolsCheck, connectorToolsSetDisabled, connectorToolsState,
  deleteConnector, isLegacyAgencyConnectorRefusal, readConnector, setConnectorEnabled, type AgencyDb,
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
 *
 * `{ disabledTools: [...] }` is the finer stop button: the tools on this
 * server the gate refuses outright, before anyone is asked. It changes that
 * one list and NOTHING else — not `enabled`, not `last_ok_at` — because
 * narrowing what a server may do is not a change to where it points, and a
 * write that switched the connector off would punish the person making it
 * safer. It can only ever refuse more or refuse less; nothing sent here
 * makes any tool run without a person.
 *
 * A connector named `agency` from before 0018 can do neither — the name
 * CHECK is evaluated on every UPDATE — and gets a 409 saying to delete it
 * and add it again (`LEGACY_AGENCY_CONNECTOR_MESSAGE`). It is inert
 * meanwhile: the product's own server takes its place in every turn. DELETE
 * is unaffected.
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
  const patch = (body && typeof body === 'object' ? body : {}) as { enabled?: unknown; disabledTools?: unknown }
  if ('disabledTools' in patch) {
    if ('enabled' in patch) {
      return NextResponse.json({ error: 'Send enabled or disabledTools, not both.' }, { status: 400 })
    }
    return setDisabledTools(db, user, id, patch.disabledTools)
  }

  const enabled = patch.enabled
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

  let updated
  try {
    updated = await setConnectorEnabled(db, user.orgId, id, enabled)
  } catch (err) {
    if (isLegacyAgencyConnectorRefusal(err)) {
      return NextResponse.json({ error: LEGACY_AGENCY_CONNECTOR_MESSAGE }, { status: 409 })
    }
    throw err
  }
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

/**
 * Store the tools an owner turned off on this server.
 *
 * Validated as the config the write leaves behind, by the schema the worker
 * reads it with — so a list that saves is a list the next turn can use, and
 * never one that makes the worker skip the whole server. Tool NAMES go in
 * the audit row: they are what somebody will want to know about later, and
 * a name is not a credential.
 */
async function setDisabledTools(
  db: AgencyDb,
  user: { id: string; orgId: string },
  id: string,
  tools: unknown,
): Promise<NextResponse> {
  const row = await readConnector(db, user.orgId, id)
  if (!row) return NextResponse.json({ error: 'No such connector.' }, { status: 404 })

  const checked = connectorToolsCheck(row, tools)
  if (!checked.ok) return NextResponse.json({ error: checked.message }, { status: 400 })

  const before = connectorToolsState(row)
  let updated
  try {
    updated = await connectorToolsSetDisabled(db, user.orgId, id, checked.value)
  } catch (err) {
    if (isLegacyAgencyConnectorRefusal(err)) {
      return NextResponse.json({ error: LEGACY_AGENCY_CONNECTOR_MESSAGE }, { status: 409 })
    }
    throw err
  }
  if (!updated) return NextResponse.json({ error: 'No such connector.' }, { status: 404 })

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'connector.tools_disabled',
    subjectType: 'connector',
    subjectId: id,
    detail: {
      name: row.name,
      tools: checked.value,
      // What it replaced: an earlier list, the catalog's default, or nothing.
      before: { source: before.source, tools: before.tools, everyTool: before.everyTool },
    },
  }).catch(() => {})

  return NextResponse.json({ id, enabled: updated.enabled, disabledTools: connectorToolsState(updated) })
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
