import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { quoteLapsed } from '@agency/core'
import { SHARE_LINK_TOKEN_SHAPE, quoteRead, shareLinkResolve, type AgencyDb } from '@agency/db/queries'
import { QuoteDocument } from '@/components/quotes/quote-document'
import { TeamNote } from '@/components/share/team-note'
import { ViewBeacon } from '@/components/share/view-beacon'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { quoteViewFor } from '@/lib/quote-load'
import { buyerQuoteClosed } from '@/lib/quote-view'
import { viewerIsTeam } from '@/lib/team-viewer'
import { AnswerForm } from './answer-form'

/**
 * A quote, for the business it was raised for, behind its link (0023).
 *
 * The proposal link's rules: no session and no shell; exempt from the cookie
 * gate (`/q` in `proxy.ts`); an unknown, revoked or expired token is one 404;
 * nothing about the agency but what the quote prints; a view is a count and
 * two times — and, the first time, a task for the person who sent it to
 * follow up — counted by the page's own script, never by this GET, and never
 * for a teammate (`lib/link-view.ts`), who sees the buyer's page with its
 * answer buttons off. Answering is a POST, never this GET, because link
 * scanners fetch every URL in a message. `no-referrer`: the URL is the
 * credential.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Quotation',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function SharedQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!SHARE_LINK_TOKEN_SHAPE.test(token)) notFound()
  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  let link
  let quote
  try {
    link = await shareLinkResolve(db, token, 'quote', now)
    quote = link?.quoteId ? await quoteRead(db, link.orgId, link.quoteId) : null
  } catch (err) {
    log.warn('shared quote could not be read', { error: err instanceof Error ? err.name : 'UnknownError' })
    return (
      <Frame>
        <h1>Quotation</h1>
        <p>This quote cannot be shown right now. Please try again in a few minutes.</p>
      </Frame>
    )
  }
  if (!link || !quote) notFound()

  const view = await quoteViewFor(db, quote)
  const team = await viewerIsTeam(link.orgId)

  const closed = buyerQuoteClosed(quote.status, quoteLapsed(quote.validUntil, now))
  return (
    <Frame wide>
      {team ? <TeamNote agency={view.seller.name} quote /> : <ViewBeacon token={token} kind="quote" />}
      <QuoteDocument view={view} showPayment={quote.status === 'sent' || quote.status === 'accepted'} />
      {closed ? (
        <section className="buyer-accept"><p style={{ margin: 0 }}>{closed}</p></section>
      ) : team ? null : (
        <AnswerForm token={token} seller={view.seller.name} />
      )}
    </Frame>
  )
}

function Frame({ wide = false, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="auth-wrap" data-read-progress={wide ? '' : undefined}>
      <div className={wide ? 'auth buyer' : 'auth'}>{children}</div>
    </div>
  )
}
