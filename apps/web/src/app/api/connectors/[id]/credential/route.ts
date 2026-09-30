import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  LEGACY_AGENCY_CONNECTOR_MESSAGE, appendAudit, credentialsReplaceForConnector, isLegacyAgencyConnectorRefusal,
  secretsKeyFromEnv, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Re-enter a connector's credential (PROMPT.md §2.3), from Settings →
 * Credentials.
 *
 * The plaintext exists in this handler for exactly as long as it takes to
 * hand it to `putSecret`. It is not echoed, not logged, not written to the
 * audit row — which carries ids and the label — and not returned: the
 * response says which row now holds it and nothing about what it holds.
 *
 * The connector comes back DISABLED with its probe cleared (that is
 * `updateConnector`'s rule for any change), because the key that was tested
 * is not the key now configured. The page says so: test it and enable it
 * again.
 *
 * Owner only: `credentials:write`. 503 without `SECRETS_KEY`, checked before
 * the body is read — a credential is never stored any other way than
 * encrypted, and a person should learn that before typing one.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** A credential and a label. A PEM key fits several times over. */
const MAX_BODY = 8 * 1024

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'credentials:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can change a credential.' }, { status: 403 })
  }
  const { id } = await context.params

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

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
    return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { credential, label } = (body ?? {}) as { credential?: unknown; label?: unknown }
  if (typeof credential !== 'string' || credential.trim() === '') {
    return NextResponse.json({ error: 'Enter the new credential.' }, { status: 400 })
  }
  if (label !== undefined && label !== null && typeof label !== 'string') {
    return NextResponse.json({ error: 'label must be text.' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  let result
  try {
    result = await credentialsReplaceForConnector(
      db,
      { orgId: user.orgId, connectorId: id, plaintext: credential, label: label ?? null, createdBy: user.id },
      key,
    )
  } catch (err) {
    // A connector named `agency` from before 0018: the name CHECK refuses
    // every UPDATE of the row, so the pointer cannot move. The transaction
    // rolled the new secret back with it; nothing was stored.
    if (isLegacyAgencyConnectorRefusal(err)) {
      return NextResponse.json({ error: LEGACY_AGENCY_CONNECTOR_MESSAGE }, { status: 409 })
    }
    // The name only. A driver error quotes the statement's parameters, and
    // one of them is the ciphertext; a message about a value nobody may see
    // has no business in a log line either.
    log.error('credential re-entry failed', { connectorId: id, error: (err as Error)?.name ?? 'Error' })
    return NextResponse.json({ error: 'That credential could not be stored.' }, { status: 500 })
  }
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message },
      { status: result.reason === 'not_found' ? 404 : 400 },
    )
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'credential.rotated',
    subjectType: 'connector',
    subjectId: id,
    // Ids, the label, and whether the old row went — never the value. The
    // label cannot carry it: the replace refuses one that contains it.
    detail: {
      connectorId: id,
      secretId: result.secretId,
      label: result.label,
      previousDeleted: result.previousDeleted,
    },
  }).catch(() => {})

  return NextResponse.json({
    connectorId: id,
    secretId: result.secretId,
    previousDeleted: result.previousDeleted,
    // Always false. Said explicitly so the page can say it too.
    enabled: false,
  })
}
