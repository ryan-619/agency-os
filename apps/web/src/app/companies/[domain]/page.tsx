import { notFound, redirect } from 'next/navigation'
import { DEFAULT_STALE_AFTER_DAYS, isStale, parseIcpDefinition } from '@agency/core'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { companyByDomain, icpForOrg, scanWithFindings } from '@/lib/queries'

export const dynamic = 'force-dynamic'

function evidenceLines(evidence: unknown): Array<[string, string]> {
  if (!evidence || typeof evidence !== 'object') return []
  return Object.entries(evidence as Record<string, unknown>).map(([k, v]) => [
    k,
    typeof v === 'string' ? v : JSON.stringify(v),
  ])
}

export default async function CompanyDetail({ params }: { params: Promise<{ domain: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const { domain } = await params
  const company = await companyByDomain(user.orgId, decodeURIComponent(domain))
  if (!company) notFound()

  const [found, icpRow] = await Promise.all([
    scanWithFindings(user.orgId, company.id),
    icpForOrg(user.orgId),
  ])
  const icp = icpRow ? parseIcpDefinition(icpRow.definition) : null
  const staleAfter = icp?.freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS

  // The score shown is the one computed FROM the scan whose findings are shown,
  // not the newest score row for the company. Pairing those independently puts
  // one scan's number above another scan's evidence.
  const score = found?.score ?? null

  const findings = found?.findings ?? []
  // §2.2 and §12: a finding whose `observed` is false is NEVER rendered as a
  // gap. The two lists are built from the column, not from a convention.
  const gaps = findings.filter((f) => f.observed && f.gap === true)
  const inPlace = findings.filter((f) => f.observed && f.gap === false)
  const notObserved = findings.filter((f) => !f.observed)

  // Derived from when the scan RAN, not read from `findings.stale`. That column
  // is a cache written by a sweep that only runs during `npm run scan`, so it
  // says fresh about an observation that aged out an hour ago — and this page
  // would then show a three-week-old gap with no mark on it at all. §2.2 says
  // such a finding must be re-verified; the page has to be able to say so
  // without waiting for a scan to relabel it.
  const stale = isStale(found?.scan.ranAt, staleAfter)
  const staleGaps = stale ? gaps : []

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={icp?.label ?? 'Agency'} current="companies" signOut={signOutAction}>
      <p className="crumb"><a href="/companies">← Companies</a></p>
      <h1>{company.name ?? company.domain}</h1>
      <p className="lede">
        <span className="mono">{company.domain}</span>
        {score ? (
          <>
            {' · '}
            {score.disqualifiedReason
              ? <>disqualified — {score.disqualifiedReason}</>
              : <>{score.score}/100 · {score.tier || 'below threshold'}</>}
          </>
        ) : (
          ' · never scanned'
        )}
      </p>

      {!found ? (
        <div className="note">
          <strong>This company has never been scanned.</strong> There are no findings, and none are
          invented to fill the space. Run <code>npm run scan -- {company.domain}</code>.
        </div>
      ) : !found.scan.ok ? (
        <div className="note note-warn">
          <strong>The last scan never reached the site.</strong>{' '}
          <span className="mono">{found.scan.error}</span>
          <br />
          Nothing was observed, so nothing is claimed. The company is disqualified as unreachable
          rather than scored as though it had failings.
        </div>
      ) : (
        <>
          {staleGaps.length ? (
            <div className="note note-warn">
              <strong>These {staleGaps.length} findings are stale.</strong> They were observed more
              than {staleAfter} days ago and must be re-verified before appearing in anything
              outbound. Run <code>npm run scan -- {company.domain}</code>.
            </div>
          ) : null}

          <h2>What was observed from the outside</h2>
          <p className="lede">
            Everything below came from {company.domain}&apos;s own public pages — the homepage
            response headers, conventional public paths, and the TLS certificate the server
            presents. Nothing private was accessed. This is posture review from the outside, not a
            security test.
          </p>

          {gaps.length === 0 ? (
            <p className="muted">No gaps were observed.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Signal</th>
                  <th style={{ textAlign: 'right' }}>Weight</th>
                  <th>What was observed</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((f) => (
                  <tr key={f.id} className={stale ? 'row-stale' : undefined}>
                    <td className="mono">
                      {f.signalKey}
                      {stale ? <span className="pill pill-stale">stale</span> : null}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{f.weight}</td>
                    <td>{icp?.signals[f.signalKey]?.why ?? f.detail ?? '—'}</td>
                    <td>
                      <dl className="evidence">
                        {evidenceLines(f.evidence).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            {/*
                              Not truncated. This is the raw evidence a finding
                              is judged on, and cutting it at 200 characters cut
                              JSON mid-object and cut the verification URL off
                              the end of the very lines an operator needs to
                              check a claim before sending it. The clamp is
                              visual — `.evidence dd` scrolls — so the whole
                              value stays selectable and copyable.
                            */}
                            <dd className="mono">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {inPlace.length ? (
            <>
              <h2>Already in place</h2>
              <p className="mono muted">{inPlace.map((f) => f.signalKey).join('  ·  ')}</p>
            </>
          ) : null}

          {notObserved.length ? (
            <>
              <h2>Not observed</h2>
              <div className="note">
                <strong>These were not checked successfully, so nothing is claimed about them.</strong>
                <p style={{ margin: '8px 0 0' }}>
                  They score zero and are excluded from the denominator — a blocked fetch is not
                  evidence of a gap. They are listed here so the coverage of this scan is visible,
                  not as findings.
                </p>
                <ul>
                  {notObserved.map((f) => (
                    <li key={f.id}>
                      <span className="mono">{f.signalKey}</span>
                      {f.detail ? <> — <span className="muted">{f.detail}</span></> : null}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}

          <h2>Scan</h2>
          <table>
            <tbody>
              <tr><th>Ran at</th><td className="mono">{new Date(found.scan.ranAt).toISOString()}</td></tr>
              <tr><th>Reached the site</th><td className="mono">{found.scan.ok ? 'yes' : 'no'}</td></tr>
              <tr><th>Signals observed</th><td className="mono">{gaps.length + inPlace.length} of {findings.length}</td></tr>
              <tr><th>Score computed</th><td className="mono">{score ? new Date(score.computedAt).toISOString() : '—'}</td></tr>
            </tbody>
          </table>
        </>
      )}
    </Shell>
  )
}
