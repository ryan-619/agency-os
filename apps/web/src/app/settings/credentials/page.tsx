import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import {
  CURRENT_KEY_VERSION, credentialsList, listConnectors, secretsKeyFromEnv, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import {
  CredentialsPanel, type ConnectorCredentialView, type CredentialView,
} from '@/components/settings/credentials'
import { getDb } from '@/lib/db'
import { agentConfigured } from '@/lib/agent'
import { icpForOrg } from '@/lib/queries'

/**
 * Settings → Credentials (PROMPT.md §2.3).
 *
 * The page `DELETE /api/connectors/[id]` has always pointed at: removing a
 * connector LEAVES its credential, and this is where a person sees what it
 * was for and decides. It also re-enters a connector's credential, which
 * nothing else in the product could do — a key could be given to a connector
 * only on the day it was added.
 *
 * Every row is reduced here, on the server, before it crosses. The credential
 * rows never had a value to begin with (`credentialsList` does not select
 * `ciphertext`); the connector rows lose `config` and `secret_ref`, for the
 * reasons Settings → Connectors gives. Any signed-in member may look —
 * labels and dates are not credentials — and only an owner sees a control.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function CredentialsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const [stored, connectors] = await Promise.all([
    credentialsList(db, user.orgId),
    listConnectors(db, user.orgId),
  ])

  const icpRow = await icpForOrg(user.orgId)
  let orgLabel = 'Agency'
  if (icpRow) {
    try {
      orgLabel = parseIcpDefinition(icpRow.definition).label
    } catch {
      orgLabel = 'Agency'
    }
  }

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  const labels = new Map(stored.map((s) => [s.id, s.label]))
  const credentials: CredentialView[] = stored.map((s) => ({
    id: s.id,
    label: s.label,
    createdAt: s.createdAt.toISOString(),
    keyVersion: s.keyVersion,
    currentKey: s.keyVersion === CURRENT_KEY_VERSION,
    usedBy: s.usedBy.map((u) => ({ connectorId: u.connectorId, name: u.name })),
  }))
  const connectorViews: ConnectorCredentialView[] = connectors.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    enabled: c.enabled,
    hasCredential: c.secretRef !== null,
    credentialLabel: c.secretRef ? labels.get(c.secretRef) ?? null : null,
  }))

  return (
    <Shell user={user} orgName={orgLabel} current="credentials" signOut={signOutAction}>
      <h1>Credentials</h1>
      <p className="lede">
        Credentials are stored encrypted with <code>SECRETS_KEY</code>; this page never shows a value.
        Re-entering one disables the connector until you test and enable it again.
      </p>
      <CredentialsPanel
        credentials={credentials}
        connectors={connectorViews}
        canWrite={can({ id: user.id, orgId: user.orgId, role: user.role }, 'credentials:write')}
        secretsConfigured={secretsKeyFromEnv() !== null}
        agentAvailable={agentConfigured()}
      />
    </Shell>
  )
}
