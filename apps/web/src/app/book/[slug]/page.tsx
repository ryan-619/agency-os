import { notFound } from 'next/navigation'
import { orgByBookingSlug, type AgencyDb } from '@agency/db/queries'
import { BookingForm } from '@/components/booking/form'
import { getDb } from '@/lib/db'

/**
 * The public booking page (PROMPT.md §8.6).
 *
 * No session, no shell: a stranger arriving from a link. Exempt from the
 * cookie gate in `proxy.ts`. The org's display name is the only thing
 * about the org this page reveals, and a slug that is not live is a 404.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) notFound()
  const org = await orgByBookingSlug(getDb() as unknown as AgencyDb, slug)
  if (!org) notFound()
  return (
    <div className="auth-wrap">
      <BookingForm slug={slug} orgName={org.name} />
    </div>
  )
}
