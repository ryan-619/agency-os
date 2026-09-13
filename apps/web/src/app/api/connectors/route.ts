import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  appendAudit, connectorNameSchema, createConnector, isReachableConnectorUrl,
  parseConnectorConfig, putSecret, secretsKeyFromEnv, type AgencyDb, type ConnectorKind,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Add an MCP server (PROMPT.md §6).
 *
 * §6 calls the connector registry "the requirement that makes the product what
 * it was asked for": new tools addable from inside the software, with no code
 * change and no redeploy. This is the write half.
 *
 * Three things this route insists on, each because of what a connector IS:
 *
 *  1. **Owner only.** A `stdio` connector runs a command on the worker host —
 *     adding one is installing software, not configuring an integration. An
 *     `http` one is a server the agent will send data to. `connectors:write`
 *     is owner-only for that reason, and this checks it rather than relying on
 *     the form being hidden.
 *  2. **The credential never lands in `config`.** It goes through `putSecret`
 *     into the encrypted `secrets` table and the row keeps only a pointer
 *     (§2.3). `config` is plain `jsonb` and a dump of it must be inert.
 *  3. **Created disabled.** Enabling is a separate, deliberate action after
 *     Test connection has passed, so a typo in a URL is never live in the next
 *     chat message.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'connectors:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can add a connector.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { name, kind, config, credential, credentialLabel } = (body ?? {}) as {
    name?: unknown
    kind?: unknown
    config?: unknown
    credential?: unknown
    credentialLabel?: unknown
  }

  const parsedName = connectorNameSchema.safeParse(name)
  if (!parsedName.success) {
    return NextResponse.json(
      { error: parsedName.error.issues[0]?.message ?? 'Invalid name.' },
      { status: 400 },
    )
  }
  if (kind !== 'stdio' && kind !== 'http' && kind !== 'sse') {
    return NextResponse.json({ error: 'Choose a transport.' }, { status: 400 })
  }

  const parsedConfig = parseConnectorConfig(kind, config)
  if (!parsedConfig.ok) {
    return NextResponse.json({ error: parsedConfig.message }, { status: 400 })
  }

  // The same check the worker makes at build time, made here so the person
  // sees it on the form rather than as a skipped connector in a log they
  // cannot read.
  if (kind !== 'stdio') {
    const url = (parsedConfig.value as { url: string }).url
    if (!isReachableConnectorUrl(url)) {
      return NextResponse.json(
        {
          error:
            'That URL points inside the network the worker runs in. A connector reached there ' +
            'would be sent its credential.',
        },
        { status: 400 },
      )
    }
  }

  const db = getDb() as unknown as AgencyDb
  let secretRef: string | null = null

  if (typeof credential === 'string' && credential.length > 0) {
    const key = secretsKeyFromEnv()
    if (!key) {
      return NextResponse.json(
        {
          error:
            'SECRETS_KEY is not set on this deployment, so a credential cannot be stored. ' +
            'Generate one with: openssl rand -base64 32',
        },
        { status: 503 },
      )
    }
    try {
      secretRef = await putSecret(
        db,
        {
          orgId: user.orgId,
          label:
            typeof credentialLabel === 'string' && credentialLabel.trim()
              ? credentialLabel.trim()
              : `${parsedName.data} credential`,
          plaintext: credential,
          createdBy: user.id,
        },
        key,
      )
    } catch {
      // Never the underlying message: it is about a value nobody may see.
      return NextResponse.json({ error: 'That credential could not be stored.' }, { status: 400 })
    }
  }

  let row
  try {
    row = await createConnector(db, {
      orgId: user.orgId,
      name: parsedName.data,
      kind: kind as ConnectorKind,
      config: parsedConfig.value,
      secretRef,
      createdBy: user.id,
    })
  } catch {
    // The unique index on (org_id, name) is the likely cause and the only one
    // worth naming — the rest are already validated above.
    return NextResponse.json(
      { error: `A connector called "${parsedName.data}" already exists.` },
      { status: 409 },
    )
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'connector.created',
    subjectType: 'connector',
    subjectId: row.id,
    // Never the config: a URL carries a token in a query string sooner or
    // later, whatever the form says.
    detail: { name: row.name, kind: row.kind, hasCredential: secretRef !== null },
  }).catch(() => {})

  return NextResponse.json({ id: row.id, name: row.name, enabled: row.enabled }, { status: 201 })
}
