import { redirect } from 'next/navigation'
import { parseIcpDefinition } from '@agency/core'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { listCompaniesForOrg, icpForOrg } from '@/lib/queries'

export const dynamic = 'force-dynamic'

function tierClass(tier: string | null, qualified: boolean): string {
  if (!tier) return 'pill'
  if (tier.startsWith('A')) return 'pill pill-a'
  if (tier.startsWith('B')) return 'pill pill-b'
  return qualified ? 'pill pill-c' : 'pill'
}

export default async function Companies() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const [rows, icpRow] = await Promise.all([listCompaniesForOrg(user.orgId), icpForOrg(user.orgId)])
  const icp = icpRow ? parseIcpDefinition(icpRow.definition) : null
  const qualifyAt = icp?.scoring.qualify_at

  const scored = rows.filter((r) => r.score !== null)
  const qualified = scored.filter((r) => r.qualified)
  const unscanned = rows.filter((r) => r.lastScanAt === null)

  return (
    <Shell
      user={user}
      orgName={icp?.label ?? 'Agency'}
      current="companies"
      signOut={async () => {
        'use server'
        await signOut({ redirectTo: '/signin' })
      }}
    >
      <h1>
        Companies
        <a href="/companies/import" className="action">Import</a>
      </h1>
      <p className="lede">
        {rows.length} in the pipeline · {scored.length} scanned · {qualified.length} qualified
        {qualifyAt === undefined ? null : <> at {qualifyAt}/100</>}
        {unscanned.length ? <> · {unscanned.length} never scanned</> : null}
      </p>

      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Domain</th>
            <th style={{ textAlign: 'right' }}>Score</th>
            <th>Tier</th>
            <th>Last scan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.companyId}>
              <td><a href={`/companies/${r.domain}`}>{r.name ?? r.domain}</a></td>
              <td className="mono">{r.domain}</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {/* Never scanned means no number — not a zero that reads as a result. */}
                {r.score === null ? <span className="muted">—</span> : r.score}
              </td>
              <td>
                {r.disqualifiedReason ? (
                  <span className="pill" title={r.disqualifiedReason}>disqualified</span>
                ) : r.score === null ? (
                  <span className="muted">not scanned</span>
                ) : (
                  <span className={tierClass(r.tier, r.qualified)}>{r.tier || 'below threshold'}</span>
                )}
              </td>
              <td className="mono muted">
                {r.lastScanAt ? new Date(r.lastScanAt).toISOString().slice(0, 10) : '—'}
                {r.lastScanOk === false ? ' (failed)' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {unscanned.length ? (
        <div className="note" style={{ marginTop: 22 }}>
          <strong>{unscanned.length} companies have never been scanned.</strong> They have no score
          and no findings, and the table says so rather than showing a zero. Run{' '}
          <code>npm run scan</code> to collect their public surface.
        </div>
      ) : null}
    </Shell>
  )
}
