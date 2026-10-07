import { isNoSiteDomain } from '@agency/core'
import { companyOpportunity, latestSiteAudit, servicesList, type AgencyDb } from '@agency/db/queries'
import * as schema from '@agency/db/schema'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { priceLine } from '@/lib/service-price'
import type { CompanySlotProps } from './slot'

/**
 * What this business needs, and what the agency could sell it (0022).
 *
 * The needs come from `needsOf` through `companyOpportunity` — the listing, the
 * latest scan, the latest PageSpeed audit — each with the dated lines that show
 * it; what could not be established is listed as not assessed, never as a need.
 * The services are the catalogue's (Settings → Services), or the suggested set,
 * labelled, while there is none. A Google listing is shown as Google's record,
 * dated, never as an observation of ours.
 */
export async function OpportunitiesSlot(props: CompanySlotProps) {
  const db = getDb() as unknown as AgencyDb
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, props.orgId), eq(schema.companies.id, props.companyId)))
    .limit(1)
  if (!company) return null
  const [o, audit, catalogue] = await Promise.all([
    companyOpportunity(db, { orgId: props.orgId, company, now: new Date() }),
    latestSiteAudit(db, props.orgId, company.id),
    servicesList(db, props.orgId, { activeOnly: true }),
  ])
  const price = (id: string | null) => {
    const s = id ? catalogue.find((c) => c.id === id) : undefined
    return s ? priceLine(s) : null
  }
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const noSite = isNoSiteDomain(company.domain)

  return (
    <section className="card" style={{ marginTop: 18 }}>
      <h2 style={{ marginTop: 0 }}>What this business needs</h2>

      {company.listingCheckedAt ? (
        <p className="hint" style={{ margin: '0 0 10px' }}>
          Google Maps, as read on {day(company.listingCheckedAt)}:{' '}
          {[
            company.googleCategory?.replace(/_/g, ' '),
            company.googleRating !== null ? `★${Number(company.googleRating).toFixed(1)} from ${company.googleReviewCount ?? 0} reviews` : 'no rating',
            company.phone ? `phone ${company.phone}` : 'no phone listed',
            company.address,
            company.listingWebsite ? `website listed: ${company.listingWebsite}` : 'no website listed',
          ]
            .filter(Boolean)
            .join(' · ')}
          {company.googleMapsUrl ? (
            <>
              {' · '}
              <a href={company.googleMapsUrl} target="_blank" rel="noreferrer noopener">open in Maps</a>
            </>
          ) : null}
          . Google’s record, not an observation of ours.
        </p>
      ) : noSite ? (
        <p className="hint" style={{ margin: '0 0 10px' }}>No website of its own is on record, and no Google listing was read.</p>
      ) : null}

      {o.reading.needs.length === 0 ? (
        <p className="muted">No need is established from what is on record.</p>
      ) : (
        <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
          {o.reading.needs.map((n) => (
            <li key={n.key} style={{ marginBottom: 6 }}>
              <strong>{n.label}</strong>
              {n.evidence.map((e, i) => (
                <div key={i} className="hint">{e}</div>
              ))}
            </li>
          ))}
        </ul>
      )}

      {o.services.length > 0 ? (
        <>
          <p style={{ margin: '8px 0 4px' }}>
            {o.services[0]!.suggested ? (
              <>
                Services that would answer them — <em>suggestions</em>; the agency has no catalogue yet (
                <a href="/settings/services">Settings → Services</a>):
              </>
            ) : (
              'Services that answer them:'
            )}
          </p>
          <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
            {o.services.map((s) => (
              <li key={s.name}>
                {s.name}
                {price(s.id) ? <span className="muted"> — {price(s.id)}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {audit ? (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          PageSpeed ({audit.strategy}, {day(audit.ranAt)}):{' '}
          {audit.ok
            ? `performance ${audit.performance ?? '—'}/100 · SEO ${audit.seo ?? '—'}/100 · accessibility ${audit.accessibility ?? '—'}/100 · best practices ${audit.bestPractices ?? '—'}/100${
                audit.lcpMs !== null ? ` · main content after ${(audit.lcpMs / 1000).toFixed(1)} s` : ''
              }`
            : `could not measure the page (${audit.error}) — not a slow site.`}
        </p>
      ) : null}

      {o.reading.notAssessed.length > 0 ? (
        <details>
          <summary className="muted" style={{ fontSize: 12.5 }}>Not assessed ({o.reading.notAssessed.length}) — unknown, never a need</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {o.reading.notAssessed.map((n, i) => (
              <li key={i} className="hint">{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
