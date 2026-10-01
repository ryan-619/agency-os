import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { Proposal } from '@agency/core'
import { SHARE_TOKEN_SHAPE, shareReadByToken, type AgencyDb, type ShareView } from '@agency/db/queries'
import { ProposalDocument } from '@/components/pipeline/proposal-document'
import { buyerBasis, buyerClosed, buyerReverifying } from '@/components/pipeline/proposal-share-copy'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { AcceptForm } from './accept-form'

/**
 * The buyer's copy of a proposal, behind its share link (PROMPT.md §8.6).
 *
 * No session, no shell: a stranger arriving from a link in a message a
 * person wrote. Exempt from the cookie gate in `proxy.ts` (`/p`). The booking
 * page's rules apply: the org's display name is the only thing about the org
 * this page reveals, and a token that is unknown, revoked or expired is a
 * 404 — the same 404 for each, so the page cannot be used to tell them apart.
 *
 * The document is the STORED one, rendered by `<ProposalDocument
 * audience="buyer">`: no score, no tier, no weights, and not the word
 * "stale" (§2.2). Whether a buyer may see it at all is decided before it
 * renders — the link expires when the evidence under it goes stale, and the
 * read re-derives freshness from the scan's `ran_at` anyway; a proposal
 * whose evidence has aged out, or been superseded by a newer successful scan,
 * shows no document, only that it is being re-verified.
 *
 * Loading this page counts a view (a count and two instants — never an IP or
 * a user agent). It records nothing else: accepting is a POST, never a GET,
 * because link scanners and mail-client previews fetch every URL in a
 * message.
 *
 * `force-dynamic` and the Node runtime like every page here, for a sharper
 * reason than most: with no cookies or headers read, Next would otherwise
 * render a token's answer once and cache it — and keep serving a revoked
 * link, and freeze the view count. `no-referrer`, because the URL is the
 * credential and must not leave in a Referer header.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Proposal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function SharedProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!SHARE_TOKEN_SHAPE.test(token)) notFound()

  let view: ShareView | null
  try {
    view = await shareReadByToken(getDb() as unknown as AgencyDb, token, new Date())
  } catch (err) {
    // Never the token and never the driver's message: the error's name only.
    log.warn('shared proposal could not be read', { error: err instanceof Error ? err.name : 'UnknownError' })
    return (
      <Frame>
        <h1>Proposal</h1>
        <p>This proposal cannot be shown right now. Please try again in a few minutes.</p>
      </Frame>
    )
  }
  if (!view) notFound()

  if (view.state === 'reverifying') {
    return (
      <Frame>
        <h1>Proposal</h1>
        <p>{buyerReverifying(view.org.name)}</p>
      </Frame>
    )
  }

  const doc = view.proposal.document as Proposal
  const evidenceAsOf = view.evidenceAsOf.toISOString()
  // Freshness was decided above: a document reaching this line is not stale,
  // so `evidenceStale` is false — and the buyer's copy never says the word
  // either way.
  return (
    <Frame wide>
      <ProposalDocument
        doc={doc}
        company={view.company}
        agency={view.org}
        status={view.proposal.status}
        evidenceAsOf={evidenceAsOf}
        evidenceStale={false}
        audience="buyer"
      />
      {view.state === 'open' ? (
        <AcceptForm
          token={token}
          orgName={view.org.name}
          basis={buyerBasis(view.company.domain, evidenceAsOf.slice(0, 10))}
        />
      ) : (
        <section className="buyer-accept">
          <p style={{ color: 'var(--ink)', margin: 0 }}>{buyerClosed(view.proposal.status)}</p>
        </section>
      )}
    </Frame>
  )
}

/** The sign-in card, widened for a document when there is one; nothing of the app around it. */
function Frame({ wide = false, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className={wide ? 'auth buyer' : 'auth'}>{children}</div>
    </div>
  )
}
