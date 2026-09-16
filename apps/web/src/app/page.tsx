import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { auth, signOut } from '@/auth'
import { getDb, schema } from '@/lib/db'
import { Shell } from '@/components/shell'
import { deployment } from '@/lib/deployment'

export const dynamic = 'force-dynamic'

/** One round trip for every counter on the dashboard. */
async function counts(orgId: string) {
  const result = await getDb().execute<{
    companies: string
    contacts: string
    findings: string
    deals: string
    campaigns: string
    approvals: string
    connectors: string
  }>(sql`
    SELECT
      (SELECT count(*) FROM ${schema.companies}  WHERE org_id = ${orgId}) AS companies,
      (SELECT count(*) FROM ${schema.contacts}   WHERE org_id = ${orgId}) AS contacts,
      (SELECT count(*) FROM ${schema.findings}   WHERE org_id = ${orgId}) AS findings,
      (SELECT count(*) FROM ${schema.deals}      WHERE org_id = ${orgId}) AS deals,
      (SELECT count(*) FROM ${schema.campaigns}  WHERE org_id = ${orgId}) AS campaigns,
      (SELECT count(*) FROM ${schema.approvals}  WHERE org_id = ${orgId} AND status = 'pending') AS approvals,
      (SELECT count(*) FROM ${schema.connectors} WHERE org_id = ${orgId} AND enabled) AS connectors
  `)
  // node-postgres returns a QueryResult; the rows are on .rows, not the result.
  const row = result.rows[0]
  return {
    companies: Number(row?.companies ?? 0),
    contacts: Number(row?.contacts ?? 0),
    findings: Number(row?.findings ?? 0),
    deals: Number(row?.deals ?? 0),
    campaigns: Number(row?.campaigns ?? 0),
    approvals: Number(row?.approvals ?? 0),
    connectors: Number(row?.connectors ?? 0),
  }
}

export default async function Dashboard() {
  const session = await auth()
  if (!session?.user) redirect('/signin')

  const user = session.user
  const c = await counts(user.orgId)
  const live = deployment()

  const [org] = await getDb()
    .select({ name: schema.orgs.name })
    .from(schema.orgs)
    .where(sql`${schema.orgs.id} = ${user.orgId}`)
    .limit(1)

  const [icp] = await getDb()
    .select({ name: schema.icpProfiles.name, definition: schema.icpProfiles.definition })
    .from(schema.icpProfiles)
    .where(sql`${schema.icpProfiles.orgId} = ${user.orgId} AND ${schema.icpProfiles.active}`)
    .limit(1)

  // Read from the stored definition rather than repeating §11's numbers as
  // literals. The ICP is editable (Phase 1 puts it in the UI), and a dashboard
  // that displays a threshold the engine is not using is the same class of
  // mistake as a finding nobody observed.
  const def = icp?.definition as
    | { scoring?: { qualify_at?: number }; outreach?: { channels?: string[]; max_per_day?: number } }
    | undefined
  const qualifyAt = def?.scoring?.qualify_at
  const channels = def?.outreach?.channels
  const dailyCap = def?.outreach?.max_per_day

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={org?.name ?? 'Agency'} current="dashboard" signOut={signOutAction}>
        <h1>Dashboard</h1>
        <p className="lede">
          Companies are found, scanned from the outside and scored; the agent researches and drafts
          under a human gate; outreach goes out through one send path; the pipeline runs from reply to
          proposal. Nothing sends, calls or texts without a person or a recorded consent.
        </p>

        <div className="cards">
          <a className="card" href="/companies"><div className="n">{c.companies}</div><div className="k">Companies</div></a>
          <div className="card"><div className="n">{c.contacts}</div><div className="k">Contacts</div></div>
          <div className="card"><div className="n">{c.findings}</div><div className="k">Findings</div></div>
          <div className="card"><div className="n">{c.deals}</div><div className="k">Deals</div></div>
          <div className="card"><div className="n">{c.campaigns}</div><div className="k">Campaigns</div></div>
          <div className="card"><div className="n">{c.approvals}</div><div className="k">Pending approvals</div></div>
          <div className="card"><div className="n">{c.connectors}</div><div className="k">Enabled connectors</div></div>
        </div>

        <h2>Active ICP</h2>
        <table>
          <thead><tr><th>Profile</th><th>Qualify at</th><th>Channels</th><th>Daily cap</th></tr></thead>
          <tbody>
            <tr>
              <td>{icp?.name ?? '— none seeded —'}</td>
              <td className="mono">{qualifyAt === undefined ? '—' : `${qualifyAt} / 100`}</td>
              <td className="mono">{channels?.join(', ') ?? '—'}</td>
              <td className="mono">{dailyCap ?? '—'}</td>
            </tr>
          </tbody>
        </table>

        <h2>What this instance can and cannot do</h2>
        <div className={live.worker ? 'note' : 'note note-warn'}>
          <strong>
            {live.worker
              ? 'Phases 0–5 are built. Three things are deliberately not.'
              : 'The CRM half of this deployment is live. The half that reaches people is not.'}
          </strong>
          <ul>
            {live.worker ? null : (
              <li>
                <strong>No agent worker is connected.</strong> Chat, sending, and reply detection all run in a
                separate long-lived process that is not part of this deployment. Drafts can be written and
                approved and will sit in the queue; nothing will send them, and no replies are being read.
              </li>
            )}
            <li>Voice and SMS (Phase 6) — inbound only, and only after A2P 10DLC registration clears. Nothing here can place a call or send a text.</li>
            <li>Nothing sources new companies on its own; import a CSV, add them by hand, or let the agent search a connector and put what it finds on the board through the gate.</li>
            <li>Calendar invitations are not sent from here — a meeting recorded here moves the deal, and the invite goes from your calendar or the calendar connector.</li>
          </ul>
        </div>
    </Shell>
  )
}
