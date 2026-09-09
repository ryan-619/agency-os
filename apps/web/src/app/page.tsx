import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { auth, signOut } from '@/auth'
import { db, schema } from '@/lib/db'
import { can } from '@agency/core'

export const dynamic = 'force-dynamic'

/** One round trip for every counter on the dashboard. */
async function counts(orgId: string) {
  const result = await db.execute<{
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

  const [org] = await db
    .select({ name: schema.orgs.name })
    .from(schema.orgs)
    .where(sql`${schema.orgs.id} = ${user.orgId}`)
    .limit(1)

  const [icp] = await db
    .select({ name: schema.icpProfiles.name })
    .from(schema.icpProfiles)
    .where(sql`${schema.icpProfiles.orgId} = ${user.orgId} AND ${schema.icpProfiles.active}`)
    .limit(1)

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Agency OS</div>
        <div className="brand-sub">{org?.name ?? 'Agency'}</div>

        <nav className="nav">
          <a href="/">Dashboard</a>
          <span>Companies <em className="phase-tag">phase 1</em></span>
          <span>Chat <em className="phase-tag">phase 2</em></span>
          <span>Connectors <em className="phase-tag">phase 3</em></span>
          <span>Campaigns <em className="phase-tag">phase 4</em></span>
          <span>Pipeline <em className="phase-tag">phase 5</em></span>
        </nav>

        <div className="who">
          <div>{user.email}</div>
          <div style={{ marginTop: 5 }}>
            <span className="role">{user.role}</span>
            {can(user, 'connectors:write') ? null : (
              <span style={{ marginLeft: 6 }}>read-only settings</span>
            )}
          </div>
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/signin' })
            }}
          >
            <button style={{ marginTop: 12, padding: '5px 10px', fontSize: 12.5 }}>Sign out</button>
          </form>
        </div>
      </aside>

      <main className="main">
        <h1>Dashboard</h1>
        <p className="lede">
          Phase 0 — foundation. The schema, auth and seed are in place; the funnel is not built yet.
        </p>

        <div className="cards">
          <div className="card"><div className="n">{c.companies}</div><div className="k">Companies</div></div>
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
              <td className="mono">45 / 100</td>
              <td className="mono">email, linkedin</td>
              <td className="mono">25</td>
            </tr>
          </tbody>
        </table>

        <h2>What is not built yet</h2>
        <div className="note">
          <strong>Phase 0 ends here, deliberately.</strong>
          <ul>
            <li>The {c.companies} seeded companies have never been scanned — no findings exist, and none are invented.</li>
            <li>Scanning, scoring and the company detail page arrive in Phase 1.</li>
            <li>The agent chat panel, the approval queue and audit logging arrive in Phase 2.</li>
            <li>Nothing in this system can send a message yet. The send path lands in Phase 4.</li>
          </ul>
        </div>
      </main>
    </div>
  )
}
