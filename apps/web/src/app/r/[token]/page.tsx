import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { isNoSiteDomain, peerLabel, phoneForDisplay, whatsappLink } from '@agency/core'
import { SHARE_LINK_TOKEN_SHAPE, orgProfileRead, presenceReport, schema, shareLinkResolve, type AgencyDb } from '@agency/db/queries'
import { TeamNote } from '@/components/share/team-note'
import { ViewBeacon } from '@/components/share/view-beacon'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { priceLine } from '@/lib/service-price'
import { viewerIsTeam } from '@/lib/team-viewer'

/**
 * A business's own audit page, behind its link (2026-10-08).
 *
 * What we noticed about its presence online, each line dated; how it stands
 * beside its nearest competitors (never named); what Google's PageSpeed
 * measured; and what the agency would do. Built from public information only
 * — its Google listing, its website's public pages, Google's measurement —
 * and it says so, naming only the sources it read. What it could NOT check
 * is the team's to read before sending (`components/company/share.tsx`),
 * never the business's: those sentences tell a person what to do next. The
 * proposal link's rules hold: no session, a 404 for an
 * unknown, revoked or expired token alike, `no-referrer`, not indexed, and a
 * view is a count and two times — plus, the first time, a task for whoever
 * sent the link to follow up while the business is reading. A view is
 * counted by the page's own script, never by this GET, and never for a
 * teammate (`lib/link-view.ts`).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Your online presence',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

const day = (d: Date) => d.toISOString().slice(0, 10)

export default async function ReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!SHARE_LINK_TOKEN_SHAPE.test(token)) notFound()
  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  let link
  let report
  try {
    link = await shareLinkResolve(db, token, 'report', now)
    report = link ? await presenceReport(db, { orgId: link.orgId, companyId: link.companyId, now }) : null
  } catch (err) {
    log.warn('audit page could not be read', { error: err instanceof Error ? err.name : 'UnknownError' })
    return <Frame><h1>Your online presence</h1><p>This page cannot be shown right now. Please try again in a few minutes.</p></Frame>
  }
  if (!link || !report) notFound()

  const [[org], profile] = await Promise.all([
    db.select({ name: schema.orgs.name, bookingSlug: schema.orgs.bookingSlug }).from(schema.orgs).where(eq(schema.orgs.id, link.orgId)).limit(1),
    orgProfileRead(db, link.orgId),
  ])
  const business = report.company.name || report.company.domain
  const team = await viewerIsTeam(link.orgId)

  const category = report.company.googleCategory ?? 'business'
  const agency = org?.name ?? 'Us'
  const booking = org?.bookingSlug ? new URL(`/book/${org.bookingSlug}`, env().AUTH_URL).toString() : null
  const whatsapp = whatsappLink(profile.phone, `Hi ${agency}, about the page on ${business}`)
  const a = report.audit
  // Only the sources this page actually read: a business with no website was not read through one.
  const sources = [
    report.company.listingCheckedAt ? 'your Google listing' : null,
    isNoSiteDomain(report.company.domain) ? null : 'your website’s public pages',
    a ? 'Google’s PageSpeed measurement' : null,
  ].filter((x): x is string => x !== null)

  return (
    <Frame>
      {team ? <TeamNote agency={agency} /> : <ViewBeacon token={token} kind="report" />}
      <p className="quote-small" style={{ margin: 0 }}>{agency} · prepared {day(report.generatedAt)}</p>
      <h1 style={{ margin: '4px 0 6px' }} data-split>{business}: your online presence</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        A short look at how customers find and reach {business} online{report.company.city ? ` in ${report.company.city}` : ''}.
      </p>
      {report.headline ? <p className="report-headline">{report.headline}</p> : null}

      <section className="report-section">
        <h2>What we noticed</h2>
        {report.needs.length === 0 ? (
          <p className="muted">Nothing stood out from what we could check — a good sign.</p>
        ) : (
          <ul className="report-needs">
            {report.needs.map((n) => (
              <li key={n.key}>
                <strong>{n.label}</strong>
                {n.evidence.map((e, i) => <div key={i} className="quote-small">{e}</div>)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {report.rows.length > 0 ? (
        <section className="report-section">
          <h2>You and {report.peers.length} similar {report.peers.length === 1 ? 'business' : 'businesses'} nearby</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="report-compare">
              <thead>
                <tr>
                  <th />
                  <th>{business}</th>
                  {report.peers.map((p, i) => <th key={p.facts.id}>{peerLabel(p, category, i)}</th>)}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.label}>
                    <th>{r.label}</th>
                    <td className="report-you">{r.subject}</td>
                    {r.peers.map((v, i) => <td key={i}>{v}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="quote-small">From public Google listings and websites; competitors are not named. “Not checked” means we could not see it — not that it is missing.</p>
        </section>
      ) : null}

      {a ? (
        <section className="report-section">
          <h2>How your website does on a phone</h2>
          <p className="quote-small">Measured by Google PageSpeed on {day(a.ranAt)}, out of 100.</p>
          <div className="report-scores">
            {([['Speed', a.performance], ['Search basics', a.seo], ['Accessibility', a.accessibility], ['Best practices', a.bestPractices]] as const).map(([label, v]) => (
              <div key={label} className={`report-score ${v === null ? '' : v >= 90 ? 'good' : v >= 50 ? 'fair' : 'poor'}`}>
                <div className="report-score-n">{v ?? '—'}</div>
                <div className="quote-small">{label}</div>
              </div>
            ))}
          </div>
          {a.lcpMs !== null ? <p className="quote-small">The main content appears after about {(a.lcpMs / 1000).toFixed(1)} seconds.</p> : null}
        </section>
      ) : null}

      {report.services.length > 0 ? (
        <section className="report-section">
          <h2>How {agency} can help</h2>
          <ul className="report-needs">
            {report.services.map(({ service }) => (
              <li key={service.id}>
                <strong>{service.name}</strong>
                {service.priceFrom !== null || service.priceTo !== null ? <span className="muted"> — {priceLine(service)}</span> : null}
                {service.description ? <div className="quote-small">{service.description}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="report-section report-cta">
        <h2>Talk to us</h2>
        <p style={{ marginTop: 0 }}>Reply to the message this link came in, or:</p>
        <div className="report-cta-row">
          {whatsapp ? <a className="button-like" data-magnetic href={whatsapp} target="_blank" rel="noreferrer noopener">WhatsApp us</a> : null}
          {profile.phone ? <a className="button-like" data-magnetic href={`tel:${profile.phone}`}>Call {phoneForDisplay(profile.phone)}</a> : null}
          {booking ? <a className="button-like" data-magnetic href={booking} target="_blank" rel="noreferrer noopener">Book a time</a> : null}
          {profile.email ? <a className="button-like" data-magnetic href={`mailto:${profile.email}`}>Email us</a> : null}
        </div>
      </section>

      <p className="quote-small" style={{ marginTop: 18 }}>
        We looked only at what anyone can see{sources.length > 0 ? `: ${sources.length === 1 ? sources[0] : `${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]}`}` : ''}.
        Nothing was tested, logged into or changed.
      </p>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    // A long page a client reads: the bar at the top shows how far down it they are (motion-root.tsx).
    <div className="auth-wrap" data-read-progress>
      <div className="auth buyer report">{children}</div>
    </div>
  )
}
