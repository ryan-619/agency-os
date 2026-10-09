import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MessageCircle, Search, Smartphone } from 'lucide-react'
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
      <div className="auth buyer check-card">
        <p className="check-chip"><span className="check-chip-dot" aria-hidden="true" />{org.name}</p>
        <h1 className="check-title" data-split>Free website check</h1>
        <p className="muted check-lede">
          See how your business shows up online, in about half a minute. We look only at what anyone can see, and
          change nothing.
        </p>
        <ul className="check-points">
          <li>
            <Smartphone aria-hidden="true" />
            <span><b>Works on a phone</b>Whether your site fits the screen your customers hold.</span>
          </li>
          <li>
            <MessageCircle aria-hidden="true" />
            <span><b>Easy to reach</b>Whether customers can call, message or write to you from it.</span>
          </li>
          <li>
            <Search aria-hidden="true" />
            <span><b>Found and shared</b>The basics search engines and browsers look for.</span>
          </li>
        </ul>
        <CheckForm slug={slug} consentWording={checkConsentWording(org.name)} />
      </div>
    </div>
  )
}
