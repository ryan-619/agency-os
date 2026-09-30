import { notFound, redirect } from 'next/navigation'
import {
  DEFAULT_STALE_AFTER_DAYS, PROPOSAL_RESCORE_SENTENCE, isStale, parseIcpDefinition, proposalNeedsRescore,
} from '@agency/core'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { can } from '@agency/core'
import {
  companyThread, listContactsForCompany, meetingsForCompany, openDealFor, proposalsForCompany, type AgencyDb,
} from '@agency/db/queries'
import { CompanyEditSlot } from '@/components/company/edit'
import { EvidencePanelsSlot } from '@/components/company/evidence'
import { InformationalSlot } from '@/components/company/informational'
import { NotesSlot } from '@/components/company/notes'
import type { CompanySlotProps } from '@/components/company/slot'
import { ContactsPanel } from '@/components/outreach/contacts'
import { CompanyActions } from '@/components/pipeline/company-actions'
import { When } from '@/components/when'
import { getDb } from '@/lib/db'
import { inZone } from '@/lib/format'
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

  const db = getDb() as unknown as AgencyDb
  const [found, icpRow, contacts, thread, deal, meetings, proposals] = await Promise.all([
    scanWithFindings(user.orgId, company.id),
    icpForOrg(user.orgId),
    listContactsForCompany(db, user.orgId, company.id),
    companyThread(db, user.orgId, company.id, 30),
    openDealFor(db, user.orgId, company.id),
    meetingsForCompany(db, user.orgId, company.id),
    proposalsForCompany(db, user.orgId, company.id),
  ])
  const icp = icpRow ? parseIcpDefinition(icpRow.definition) : null
  const staleAfter = icp?.freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS

  // The score shown is the one computed FROM the scan whose findings are shown,
  // not the newest score row for the company. Pairing those independently puts
  // one scan's number above another scan's evidence.
  const score = found?.score ?? null

  const findings = found?.findings ?? []
  // Only the SCORED rows are a gap, a strength or a missing observation; an
  // informational signal is context and belongs to <InformationalSlot>.
  // `findings.scored` arrives in the same PR as this line (0018, from the
  // parallel schema worktree), so it is read structurally: an absent property
  // means "scored", which is what every row was before that migration.
  const scoredRows = findings.filter((f) => ('scored' in f ? (f as { scored: boolean }).scored : true))
  // §2.2 and §12: a finding whose `observed` is false is NEVER rendered as a
  // gap. The two lists are built from the column, not from a convention.
  const gaps = scoredRows.filter((f) => f.observed && f.gap === true)
  const inPlace = scoredRows.filter((f) => f.observed && f.gap === false)
  const notObserved = scoredRows.filter((f) => !f.observed)

  // Derived from when the scan RAN, not read from `findings.stale`. That column
  // is a cache written by a sweep that only runs during `npm run scan`, so it
  // says fresh about an observation that aged out an hour ago — and this page
  // would then show a three-week-old gap with no mark on it at all. §2.2 says
  // such a finding must be re-verified; the page has to be able to say so
  // without waiting for a scan to relabel it.
  const stale = isStale(found?.scan.ranAt, staleAfter)
  const staleGaps = stale ? gaps : []

  // Whether a proposal can be written, decided HERE from the same facts the
  // generator refuses on, so the button says why before it is pressed.
  const canGenerate: { ok: true } | { ok: false; why: string } = !found
    ? { ok: false, why: 'Scan the company first — a proposal is written from findings.' }
    : !found.scan.ok
      ? { ok: false, why: 'The last scan never reached the site; nothing was observed to propose from.' }
      : stale
        ? { ok: false, why: `The findings are stale (older than ${staleAfter} days). Re-scan before generating (§2.2).` }
        : icp && icpRow &&
            proposalNeedsRescore({
              icp,
              findings: found.findings,
              profiles: { activeProfileId: icpRow.id, scoreProfileId: found.score?.icpProfileId ?? null },
            })
          ? {
              ok: false,
              why: `The last scan was ${PROPOSAL_RESCORE_SENTENCE} before generating: the active ICP scores signals it did not.`,
            }
          : gaps.length === 0
            ? { ok: false, why: 'No gaps were observed. There is nothing to propose.' }
            : { ok: true }
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  const slot: CompanySlotProps = {
    orgId: user.orgId,
    companyId: company.id,
    domain: company.domain,
    userId: user.id,
    canWrite: can(principal, 'companies:write'),
    staleAfterDays: staleAfter,
  }

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
      <CompanyEditSlot {...slot} />

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

          <InformationalSlot {...slot} />

          <h2>Scan</h2>
          <table>
            <tbody>
              <tr><th>Ran at</th><td className="mono">{new Date(found.scan.ranAt).toISOString()}</td></tr>
              <tr><th>Reached the site</th><td className="mono">{found.scan.ok ? 'yes' : 'no'}</td></tr>
              <tr><th>Signals observed</th><td className="mono">{gaps.length + inPlace.length} of {scoredRows.length}</td></tr>
              <tr><th>Score computed</th><td className="mono">{score ? new Date(score.computedAt).toISOString() : '—'}</td></tr>
            </tbody>
          </table>
        </>
      )}
      <EvidencePanelsSlot {...slot} />
      <CompanyActions
        companyId={company.id}
        companyDomain={company.domain}
        contacts={contacts.map((c) => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'unnamed' }))}
        dealStage={deal?.stage ?? null}
        canWrite={can(principal, 'deals:write')}
        canGenerate={canGenerate}
      />

      {meetings.length > 0 || proposals.length > 0 ? (
        <section className="card" style={{ marginTop: 18 }}>
          {meetings.length > 0 ? (
            <>
              <h2 style={{ marginTop: 0 }}>Meetings</h2>
              <table>
                <thead><tr><th>When</th><th>Title</th><th>Source</th><th></th></tr></thead>
                <tbody>
                  {meetings.map((m) => (
                    <tr key={m.id} className={m.cancelledAt ? 'row-stale' : undefined}>
                      <td className="mono">{inZone(m.startsAt, m.timeZone)}</td>
                      <td>{m.title ?? '—'}{m.cancelledAt ? <span className="pill pill-stale">cancelled</span> : null}</td>
                      <td className="mono">{m.source.replace(/_/g, ' ')}</td>
                      <td><a href={`/meetings/${m.id}`}>Brief →</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {proposals.length > 0 ? (
            <>
              <h2 style={{ marginTop: meetings.length > 0 ? 22 : 0 }}>Proposals</h2>
              <table>
                <thead><tr><th>Title</th><th>Status</th><th>Estimate</th><th>Generated</th></tr></thead>
                <tbody>
                  {proposals.map((p) => (
                    <tr key={p.id}>
                      <td><a href={`/proposals/${p.id}`}>{p.title}</a></td>
                      <td><span className={`tag${p.status === 'accepted' ? ' on' : p.status === 'declined' || p.status === 'withdrawn' ? ' warn' : ''}`}>{p.status}</span></td>
                      <td className="mono">
                        {p.totalLow != null && p.totalHigh != null
                          ? `${p.currency} ${p.totalLow.toLocaleString('en-US')}–${p.totalHigh.toLocaleString('en-US')}`
                          : 'effort only'}
                      </td>
                      <td className="mono"><When iso={p.generatedAt.toISOString()} mode="date" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </section>
      ) : null}

      <ContactsPanel
        companyId={company.id}
        canWrite={can(principal, 'contacts:write')}
        contacts={contacts.map((c) => ({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'unnamed',
          title: c.title,
          email: c.email,
          phone: c.phone,
          linkedinUrl: c.linkedinUrl,
          timeZone: c.timeZone,
          pausedAt: c.pausedAt ? c.pausedAt.toISOString() : null,
          pausedReason: c.pausedReason,
          consents: c.consents.map((k) => ({ channel: k.channel, granted: k.granted, source: k.source })),
        }))}
      />
      <NotesSlot {...slot} />

      <section className="card" style={{ marginTop: 18 }}>
        <h2>Conversation</h2>
        {deal ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            Deal stage <strong>{deal.stage}</strong>
            {deal.nextAction ? <> · next: {deal.nextAction}</> : null}
          </p>
        ) : null}
        {thread.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>Nothing has been sent or received yet.</p>
        ) : (
          <div className="thread">
            {thread.map((t) => (
              <div key={t.id} className={`touch touch-${t.direction}`}>
                <div className="touch-head">
                  <span className="pill">{t.direction === 'in' ? 'reply' : t.channel}</span>
                  <span className={`tag${t.status === 'sent' || t.status === 'replied' ? ' on' : t.status === 'refused' || t.status === 'failed' ? ' warn' : ''}`}>
                    {t.status}
                    {t.refusalCode ? ` — ${t.refusalCode.replace(/_/g, ' ')}` : ''}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    <When iso={(t.sentAt ?? t.createdAt).toISOString()} />
                    {t.recipient ? ` · ${t.recipient}` : ''}
                  </span>
                </div>
                {t.subject ? <div style={{ fontSize: 13.5, fontWeight: 600 }}>{t.subject}</div> : null}
                {t.body ? <pre className="mono touch-body">{t.body}</pre> : null}
                {t.error ? <div className="err-line">{t.error}</div> : null}
                {t.decisionNote ? <div className="muted" style={{ fontSize: 12.5 }}>Note: {t.decisionNote}</div> : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </Shell>
  )
}
