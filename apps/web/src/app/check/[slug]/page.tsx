import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { orgByBookingSlug, type AgencyDb } from '@agency/db/queries'
import { checkConsentWording } from '@/lib/check-copy'
import { getDb } from '@/lib/db'
import { CheckForm } from './form'

/**
 * The free website check (2026-10-08): a page a business owner opens from a
 * post or a message, types in their website, and gets their own audit page.
 * Public (`/check` in `proxy.ts`), under the agency's booking slug; nothing
 * about the agency but its name. What it reads is what anyone can see.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Free website check',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function CheckPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) notFound()
  const org = await orgByBookingSlug(getDb() as unknown as AgencyDb, slug)
  if (!org) notFound()
  return (
    <div className="auth-wrap">
      <div className="auth buyer">
        <p className="quote-small" style={{ margin: 0 }}>{org.name}</p>
        <h1 style={{ margin: '4px 0 8px' }}>Free website check</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          See how your business shows up online: whether your site works well on a phone, how customers can reach you, and
          the basics search engines and browsers look for — in about half a minute. We look only at what anyone can see,
          and change nothing.
        </p>
        <CheckForm slug={slug} consentWording={checkConsentWording(org.name)} />
      </div>
    </div>
  )
}
