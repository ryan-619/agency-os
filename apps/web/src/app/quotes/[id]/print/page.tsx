import { notFound, redirect } from 'next/navigation'
import { can } from '@agency/core'
import { quoteRead, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { QuoteDocument } from '@/components/quotes/quote-document'
import { getDb } from '@/lib/db'
import { quoteViewFor } from '@/lib/quote-load'
import { PrintButton } from './print-button'

/**
 * A quote, ready to print or save as a PDF (0023): the document alone, no
 * sidebar, black on white on paper. "Save as PDF" is the browser's own print
 * dialog — nothing is generated on the server, and nothing leaves it.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
@media print {
  :root { --ink: #000; --muted: #333; --line: #bbb; --panel: #fff; --bg: #fff; }
  body { background: #fff; }
  .print-hide { display: none !important; }
  .quote-doc { box-shadow: none; border: 0; padding: 0; }
  tr, .quote-pay, .quote-terms { break-inside: avoid; }
}
`

export default async function QuotePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:read')) redirect('/')
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound()
  const db = getDb() as unknown as AgencyDb
  const quote = await quoteRead(db, user.orgId, id)
  if (!quote) notFound()
  const view = await quoteViewFor(db, quote)
  return (
    <main className="main" style={{ maxWidth: 880, margin: '0 auto' }}>
      <style>{PRINT_CSS}</style>
      <div className="print-hide row-actions" style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <a href={`/quotes/${quote.id}`}>← Back to the quote</a>
        <PrintButton />
        {quote.status === 'draft' ? <span className="hint">A draft: the seller details are as your profile reads now.</span> : null}
      </div>
      <QuoteDocument view={view} />
    </main>
  )
}
