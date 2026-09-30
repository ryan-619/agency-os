import { redirect } from 'next/navigation'
import { can, CONNECTOR_CATALOG, parseIcpDefinition } from '@agency/core'
import {
  connectorToolsState, listConnectors, parseConnectorConfig, secretsKeyFromEnv, type AgencyDb, type ConnectorRow,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { ConnectorsPanel, type ConnectorView } from '@/components/settings/connectors'
import { browserPresets } from '@/components/settings/connector-presets'
import { getDb } from '@/lib/db'
import { agentConfigured } from '@/lib/agent'
import { icpForOrg } from '@/lib/queries'

/**
 * Settings → Connectors (PROMPT.md §6).
 *
 * The registry of MCP servers the agent builds its tool set from, on every
 * turn. §6: "This screen is what 'add more tools later' actually means."
 *
 * Everything here is read on the server and the rows are REDUCED before they
 * cross to the browser. A connector row carries a `config` blob and a
 * `secret_ref`, and neither belongs in a page's serialised props: a URL picks
 * up a token in a query string sooner or later, and `secret_ref` is a pointer
 * whose only purpose is to be dereferenced by the worker. `toView` below is
 * the boundary, and it is the reason this page holds a mapping function rather
 * than passing rows straight through.
 *
 * The catalog crosses the same way, through `browserPresets`: the fields a
 * card renders and the `config` Install posts, never a URL with a query
 * string, and the decision about whether there is an Install button at all
 * already made on this side.
 */
export const dynamic = 'force-dynamic'

export default async function ConnectorsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const rows = await listConnectors(db, user.orgId)

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

  return (
    <Shell user={user} orgName={orgLabel} current="connectors" signOut={signOutAction}>
      <h1>Connectors</h1>
      <p className="lede">
        Each of these is an MCP server. The agent builds its tool set from the enabled ones at the
        start of every message, so a server added here is usable immediately — no restart. Its tools
        are not pre-approved: a third-party tool nobody here has reviewed asks a person every time
        the agent calls it. An owner can also turn a tool off, and then it is refused without asking
        anyone.
      </p>
      <ConnectorsPanel
        connectors={rows.map(toView)}
        presets={browserPresets(CONNECTOR_CATALOG)}
        canWrite={can({ id: user.id, orgId: user.orgId, role: user.role }, 'connectors:write')}
        agentAvailable={agentConfigured()}
        secretsConfigured={secretsKeyFromEnv() !== null}
      />
    </Shell>
  )
}

/**
 * The row, reduced to what a browser may see.
 *
 * `config` and `secret_ref` do not cross. What replaces them is a one-line
 * summary built from the parts that are safe: a host without its path or
 * query, or a command without its arguments.
 */
function toView(row: ConnectorRow): ConnectorView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    hasCredential: row.secretRef !== null,
    lastOkAt: row.lastOkAt ? row.lastOkAt.toISOString() : null,
    lastError: row.lastError,
    summary: summarise(row),
    // Tool NAMES and who turned them off — derived from the row by the same
    // function the worker's gate uses, so this page cannot show a list the
    // gate is not enforcing. The config it reads never crosses.
    disabledTools: connectorToolsState(row),
  }
}

function summarise(row: ConnectorRow): string {
  const parsed = parseConnectorConfig(row.kind, row.config)
  if (!parsed.ok) return `Misconfigured — ${parsed.message}`

  if (row.kind === 'stdio') {
    const { command, args } = parsed.value as { command: string; args: string[] }
    // The command, and how many arguments — not the arguments themselves. One
    // of them is eventually a token, whatever the form says.
    return `Runs ${command}${args.length > 0 ? ` with ${args.length} argument${args.length === 1 ? '' : 's'}` : ''} on the worker host.`
  }

  const { url } = parsed.value as { url: string }
  try {
    const parsedUrl = new URL(url)
    // Origin only: a path can identify a tenant and a query string can carry a
    // credential somebody pasted into the wrong field.
    return `${row.kind.toUpperCase()} to ${parsedUrl.origin}`
  } catch {
    return `${row.kind.toUpperCase()} server`
  }
}
