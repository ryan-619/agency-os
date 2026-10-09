import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { whatsappLink } from '@agency/core'
import { SHARE_LINK_TOKEN_SHAPE, orgProfileRead, schema, shareLinkResolve, type AgencyDb } from '@agency/db/queries'
import { PreviewMotion } from '@/components/share/preview-motion'
import { SitePreview } from '@/components/share/site-preview'
import { TeamNote } from '@/components/share/team-note'
import { ViewBeacon } from '@/components/share/view-beacon'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { viewerIsTeam } from '@/lib/team-viewer'

/**
 * A preview of the website the agency would build a business (2026-10-08),
 * behind its link: one page from its Google listing and a template for its
 * kind of business (`components/share/site-preview.tsx`).
 *
 * It must never be mistaken for the business's own site: a banner pinned to
 * the top says who made it and that it is not live, it is never indexed, and
 * it reads only the listing the business already shows the world. The
 * link's other rules are the proposal link's: no session, one 404 for an
 * unknown, revoked or expired token, `no-referrer`, a view is a count and two
 * times — and, the first time, a task for whoever sent it. A view is counted
 * by the page's own script, never by this GET, and never for a teammate
 * (`lib/link-view.ts`).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Website preview',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function PreviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!SHARE_LINK_TOKEN_SHAPE.test(token)) notFound()
  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  let link
  try {
    link = await shareLinkResolve(db, token, 'preview', now)
  } catch (err) {
    log.warn('website preview could not be read', { error: err instanceof Error ? err.name : 'UnknownError' })
    return <p style={{ padding: 24 }}>This preview cannot be shown right now. Please try again in a few minutes.</p>
  }
  if (!link) notFound()
  const [[company], [org], profile, team] = await Promise.all([
    db.select().from(schema.companies).where(and(eq(schema.companies.orgId, link.orgId), eq(schema.companies.id, link.companyId))).limit(1),
    db.select({ name: schema.orgs.name, bookingSlug: schema.orgs.bookingSlug }).from(schema.orgs).where(eq(schema.orgs.id, link.orgId)).limit(1),
    orgProfileRead(db, link.orgId),
    viewerIsTeam(link.orgId),
  ])
  if (!company) notFound()
  const name = company.name || 'Your business'
  const agency = org?.name ?? 'us'
  const talkToAgency =
    whatsappLink(profile.phone, `Hi ${agency}, about the website preview for ${name}`) ??
    (profile.email ? `mailto:${profile.email}` : org?.bookingSlug ? new URL(`/book/${org.bookingSlug}`, env().AUTH_URL).toString() : null)

  return (
    <>
      <SitePreview
        business={{
          name,
          category: company.googleCategory,
          city: company.city,
          phone: company.phone,
          address: company.address,
          mapsUrl: company.googleMapsUrl,
          rating: company.googleRating === null ? null : Number(company.googleRating),
          reviews: company.googleReviewCount,
          listingCheckedAt: company.listingCheckedAt,
        }}
        agency={agency}
        talkToAgency={talkToAgency}
        year={now.getUTCFullYear()}
        notice={team ? <TeamNote agency={agency} /> : <ViewBeacon token={token} kind="preview" />}
      />
      <PreviewMotion />
    </>
  )
}
