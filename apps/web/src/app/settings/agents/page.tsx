import { redirect } from 'next/navigation'
import { AGENCY_TOOL_NAMES, can, parseIcpDefinition } from '@agency/core'
import { enabledConnectors, listAgentDefs, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { AgentsPanel } from '@/components/settings/agents'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'

/**
 * Settings → Agents (PROMPT.md §7).
 *
 * `agent_defs` rows become the SDK's `agents` option at the start of every
 * turn, so an agent edited here is live in the next message — the same promise
 * §6 makes for connectors.
 *
 * The tool list offered on the form is built from what actually exists right
 * now: the app's own tools plus every ENABLED connector's namespace. Offering
 * a tool that is not there produces a subagent that silently cannot do its
 * job, and the failure surfaces as a confusing answer rather than an error.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function AgentsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const [rows, connectors] = await Promise.all([
    listAgentDefs(db, user.orgId),
    enabledConnectors(db, user.orgId),
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

  /**
   * The app's own tools, then a wildcard per enabled connector.
   *
   * A connector's individual tool names are only knowable by connecting to it,
   * and that is Test connection's job rather than this page's — so a subagent
   * is granted a connector wholesale. Note what this wildcard is and is not:
   * it is an entry in a subagent's `tools` (which NARROWS what that agent may
   * reach) and never an entry in `allowedTools` (which would auto-approve
   * before the gate is consulted). Every call still reaches `canUseTool`.
   */
  const availableTools = [
    // From `@agency/core`, not `@agency/tools`. The tools package depends on
    // `@agency/db`'s root export, which reaches `paths.ts` and from there the
    // migrations directory — and pulling that into the Next module graph fails
    // the build outright (CLAUDE.md §4 records the same trap for the db
    // package itself). `AGENCY_TOOL_NAMES` is derived from the same registry
    // the risk classifier uses, so it cannot drift from what actually ships.
    ...AGENCY_TOOL_NAMES.map((name) => `mcp__agency__${name}`),
    ...connectors.map((c) => `mcp__${c.name}__*`),
  ]

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={orgLabel} current="agents" signOut={signOutAction}>
      <h1>Agents</h1>
      <p className="lede">
        Subagents the main agent can hand work to. Each has its own instructions and its own tools,
        and the main agent decides when to use one by reading its description. Delegating is not
        free: a subagent runs its own turns against the same budget.
      </p>
      <AgentsPanel
        agents={rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          systemPrompt: r.systemPrompt,
          tools: r.tools,
          model: r.model,
          enabled: r.enabled,
        }))}
        availableTools={availableTools}
        canWrite={can({ id: user.id, orgId: user.orgId, role: user.role }, 'agents:write')}
      />
    </Shell>
  )
}
