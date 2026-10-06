import { redirect } from 'next/navigation'
import { parseIcpDefinition } from '@agency/core'
import { secretsKeyFromEnv, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { agentConfigured } from '@/lib/agent'
import { agentMisconfiguredSentence } from '@/lib/agent-config'
import { getDb } from '@/lib/db'
import { deployment } from '@/lib/deployment'
import { env } from '@/lib/env'
import { orgIdentity } from '@/lib/org-identity'
import { icpForOrg } from '@/lib/queries'
import { workerStatus, type WorkerStatus } from '@/lib/worker-status'
import { deploymentFacts, workerLine } from './facts'

/**
 * Settings: the landing page for everything that configures the product.
 *
 * Three things, in the order somebody arriving here needs them: who this
 * organisation is (its name and public booking page), what THIS deployment
 * can and cannot do, and where each setting lives. Read only — every
 * control is on the page a card links to, behind that page's own
 * capability.
 *
 * "What this deployment can do" states configuration by variable NAME and
 * never a value (§2.3), and keeps it apart from the one observation on the
 * page: when a worker last wrote a heartbeat. /settings/deployment is the
 * same facts in full.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const AREAS: readonly { readonly href: string; readonly title: string; readonly what: string }[] = [
  { href: '/settings/connectors', title: 'Connectors', what: 'MCP servers the agent can use, and which of their tools.' },
  { href: '/settings/agents', title: 'Agents', what: 'Subagent definitions: prompt, tools, model.' },
  { href: '/settings/team', title: 'Team', what: 'Who can sign in, and as what.' },
  { href: '/settings/credentials', title: 'Credentials', what: 'Encrypted connector credentials. Never shown.' },
  { href: '/settings/icp', title: 'ICP', what: 'The profile every score is computed against. Read only.' },
  { href: '/settings/spend', title: 'Spend', what: 'What the model has cost, per day and per person.' },
  { href: '/settings/mail', title: 'Mail', what: 'SPF, DMARC and DKIM for our own sending domain.' },
  { href: '/settings/templates', title: 'Templates', what: 'The DLT-registered SMS templates every SMS is drafted from.' },
  { href: '/settings/deployment', title: 'Deployment', what: 'What is configured, the worker, the schema.' },
  { href: '/compliance', title: 'Compliance', what: 'The questions an auditor asks, as counts.' },
  { href: '/audit', title: 'Audit', what: 'Every recorded action, newest first.' },
]

export default async function SettingsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const org = await orgIdentity(user.orgId)
  const e = env()
  const flags = deployment()

  let icpLabel: string | null = null
  const icpRow = await icpForOrg(user.orgId)
  if (icpRow) {
    try {
      icpLabel = parseIcpDefinition(icpRow.definition).label
    } catch {
      icpLabel = `${icpRow.name} (its definition does not parse)`
    }
  }

  let worker: WorkerStatus | null = null
  let workerError: string | undefined
  try {
    worker = await workerStatus(getDb() as unknown as AgencyDb, new Date())
  } catch (err) {
    // The class only: a driver error can carry the DSN (§2.3).
    workerError = err instanceof Error ? err.name : 'UnknownError'
  }
  const line = workerLine(worker, workerError)

  const secretsKey = secretsKeyFromEnv() !== null ? 'valid' : e.SECRETS_KEY ? 'malformed' : 'unset'
  const facts = deploymentFacts({
    flags,
    agent: agentConfigured(),
    agentProblem: flags.agentMisconfigured ? agentMisconfiguredSentence(flags.agentMisconfigured) : undefined,
    secretsKey,
    vercelEnv: e.VERCEL_ENV,
    inboundJson: Boolean(e.INBOUND_WEBHOOK_SECRET),
    inboundResend: Boolean(e.RESEND_WEBHOOK_SECRET && e.RESEND_API_KEY),
    rescanBatchSize: e.RESCAN_BATCH_SIZE,
  })

  const bookingUrl = org.bookingSlug ? new URL(`/book/${org.bookingSlug}`, e.AUTH_URL).toString() : null

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="settings" signOut={signOutAction}>
      <h1>Settings</h1>
      <p className="lede">
        Who this organisation is, what this deployment can and cannot do, and where each setting lives.
        Nothing on this page changes anything.
      </p>

      <h2>Organisation</h2>
      <table>
        <tbody>
          <tr>
            <th style={{ width: 200 }}>Name</th>
            <td>{org.name}</td>
          </tr>
          <tr>
            <th>Public booking page</th>
            <td>
              {bookingUrl ? (
                <a href={bookingUrl}>{bookingUrl}</a>
              ) : (
                <span className="muted">None — this organisation has no booking slug, so there is no public page.</span>
              )}
            </td>
          </tr>
          <tr>
            <th>Scoring profile</th>
            <td>
              {icpLabel ? <a href="/settings/icp">{icpLabel}</a> : <span className="muted">No active ICP profile.</span>}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>What this deployment can do</h2>
      <div className={line.tone === 'warn' ? 'note note-warn' : 'note'} style={{ marginBottom: 12 }}>
        <strong>{line.text}</strong>
        {line.lastSeenAt ? (
          <span className="muted"> Last heartbeat <When iso={line.lastSeenAt.toISOString()} />.</span>
        ) : null}
      </div>
      <table>
        <tbody>
          {facts.map((f) => (
            <tr key={f.area}>
              <th style={{ width: 200 }}>{f.area}</th>
              <td style={{ width: 60 }}>
                <span className={f.on ? 'tag on' : 'tag'}>{f.on ? 'yes' : 'no'}</span>
              </td>
              <td>{f.sentence}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 13 }}>
        Each line is read from configuration by variable name; no value is shown anywhere in settings.
        The variables, the schema state and the worker in full: <a href="/settings/deployment">Deployment</a>.
      </p>

      <h2>Settings</h2>
      <div className="cards">
        {AREAS.map((a) => (
          <a key={a.href} className="card" href={a.href}>
            <div style={{ fontWeight: 600 }}>{a.title}</div>
            <div className="k">{a.what}</div>
          </a>
        ))}
      </div>
    </Shell>
  )
}
