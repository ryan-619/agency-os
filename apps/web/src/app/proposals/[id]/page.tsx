import { notFound, redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { can, parseIcpDefinition, type Proposal } from '@agency/core'
import { readProposal, schema, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { ProposalStatus } from '@/components/pipeline/proposal-status'
import { When } from '@/components/when'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'

/**
 * One proposal, as generated (PROMPT.md §8.6).
 *
 * The document is rendered from the stored JSON, never regenerated: what
 * was sent to a buyer stays what it was, whatever the scan says now. The
 * evidence is under every scope item, so a reader can check the scope
 * against the site rather than take it on trust (§2.2).
 */
export const dynamic = 'force-dynamic'

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()

  const db = getDb() as unknown as AgencyDb
  const [row, icpRow] = await Promise.all([readProposal(db, user.orgId, id), icpForOrg(user.orgId)])
  if (!row) notFound()
  const [company] = await db
    .select({ domain: schema.companies.domain, name: schema.companies.name })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, user.orgId), eq(schema.companies.id, row.companyId)))
    .limit(1)
  const doc = row.document as Proposal

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
  const money = (n: number) => `${doc.pricing.currency} ${n.toLocaleString('en-US')}`

  return (
    <Shell user={user} orgName={orgLabel} current="pipeline" signOut={signOutAction}>
      <p className="crumb"><a href="/pipeline">← Pipeline</a></p>
      <h1>{doc.title}</h1>
      <p className="lede">
        <span className={`tag${row.status === 'accepted' ? ' on' : row.status === 'declined' || row.status === 'withdrawn' ? ' warn' : ''}`}>{row.status}</span>
        {' · '}
        {company ? <a href={`/companies/${encodeURIComponent(company.domain)}`}>{company.name ?? company.domain}</a> : null}
        {' · generated '}<When iso={row.generatedAt.toISOString()} />
        {row.decidedAt ? <> · decided <When iso={row.decidedAt.toISOString()} /></> : null}
      </p>
      <ProposalStatus id={row.id} status={row.status} canWrite={can({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')} />

      <article className="proposal">
        <section>
          <h2>Summary</h2>
          <p>{doc.summary}</p>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Based on the scan of <When iso={doc.basedOn.scanRanAt} mode="date" />
            {doc.basedOn.score != null ? <> · score {doc.basedOn.score}/100{doc.basedOn.tier ? `, tier ${doc.basedOn.tier}` : ''}</> : null}
          </p>
        </section>

        {doc.workstreams.map((ws) => (
          <section key={ws.name} className="card" style={{ marginTop: 14 }}>
            <h2 style={{ marginTop: 0 }}>
              {ws.name}
              <span className="muted" style={{ float: 'right', fontWeight: 400, fontSize: 13 }}>
                {ws.effortDays.low}–{ws.effortDays.high} days
              </span>
            </h2>
            <p className="muted" style={{ fontSize: 13 }}>{ws.summary}</p>
            <table>
              <thead><tr><th>Deliverable</th><th>Why</th><th>Evidence observed</th></tr></thead>
              <tbody>
                {ws.items.map((item) => (
                  <tr key={item.signalKey}>
                    <td><div>{item.deliverable}</div><div className="mono muted" style={{ fontSize: 11.5 }}>{item.signalKey} · weight {item.weight}</div></td>
                    <td>{item.why}</td>
                    <td>
                      <dl className="evidence">
                        {item.evidence.map((line, i) => <dd key={i} className="mono">{line}</dd>)}
                      </dl>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>Pricing</h2>
          <table>
            <tbody>
              <tr><th>Effort</th><td className="mono">{doc.pricing.effortDays.low}–{doc.pricing.effortDays.high} days</td></tr>
              <tr><th>Day rate</th><td className="mono">{doc.pricing.dayRate != null ? money(doc.pricing.dayRate) : 'not set — effort only'}</td></tr>
              <tr><th>Total</th><td className="mono">{doc.pricing.total ? `${money(doc.pricing.total.low)} – ${money(doc.pricing.total.high)}` : '—'}</td></tr>
            </tbody>
          </table>
        </section>

        <section style={{ marginTop: 14 }}>
          <h2>Assumptions</h2>
          <ul>{doc.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </section>

        {doc.alreadyInPlace.length > 0 ? (
          <section>
            <h2>Already in place</h2>
            <p className="muted" style={{ fontSize: 13 }}>
              Checked from the outside and not found to be a problem. Out of scope. (The wording in brackets is
              what the scan looks for, not what it found.)
            </p>
            <ul>
              {doc.alreadyInPlace.map((s) => (
                <li key={s.signalKey}><span className="mono">{s.signalKey}</span> <span className="muted">— not the case here ({s.why})</span></li>
              ))}
            </ul>
          </section>
        ) : null}

        {doc.notAssessed.length > 0 ? (
          <section>
            <h2>Not assessed</h2>
            <div className="note">
              <strong>These could not be observed from the outside and are excluded from scope — not assumed to be fine.</strong>
              <ul>{doc.notAssessed.map((s) => <li key={s.signalKey}><span className="mono">{s.signalKey}</span> — {s.why}</li>)}</ul>
            </div>
          </section>
        ) : null}
      </article>
    </Shell>
  )
}
