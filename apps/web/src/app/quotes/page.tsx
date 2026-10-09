import { redirect } from 'next/navigation'
import { can, quoteLapsed } from '@agency/core'
import { quotesList, type AgencyDb, type QuoteStatus } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { money } from '@/lib/quote-view'
import { ReceiptText } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'

/** Every quote, newest first, by status (0023). A new one is raised from a company's page. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const STATUSES: readonly QuoteStatus[] = ['draft', 'sent', 'accepted', 'declined', 'withdrawn']

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:read')) redirect('/')
  const { status: raw } = await searchParams
  const status = STATUSES.find((s) => s === raw)
  const quotes = await quotesList(getDb() as unknown as AgencyDb, { orgId: user.orgId, ...(status ? { status } : {}), limit: 200 })
  const now = new Date()

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  const open = quotes.filter((q) => q.status === 'sent')
  const openValue = open.reduce((sum, q) => sum + q.total, 0)
  const won = quotes.filter((q) => q.status === 'accepted')
  return (
    <Shell user={user} current="quotes" signOut={signOutAction}>
      <h1>Quotes</h1>
      <p className="lede">
        Priced offers of your services, with GST and a UPI code for the advance. Raise one from a company’s page — it starts
        from the services that answer what the business needs — then send its link, or draft the email that carries it.
      </p>
      {!status ? (
        <p className="hint">
          {open.length} open ({money(openValue, 'INR')}) · {won.length} accepted ({money(won.reduce((s, q) => s + q.total, 0), 'INR')})
        </p>
      ) : null}
      <p className="hint">
        <a href="/quotes">All</a>
        {STATUSES.map((s) => <span key={s}> · <a href={`/quotes?status=${s}`}>{s}</a></span>)}
      </p>
      {quotes.length === 0 ? (
        status ? (
          <EmptyState icon={ReceiptText} title={`No ${status} quotes`} compact actions={[{ href: '/quotes', label: 'Every quote', secondary: true }]} />
        ) : (
          <EmptyState
            icon={ReceiptText}
            title="No quotes yet"
            actions={[
              { href: '/companies', label: 'Open a company to quote' },
              { href: '/settings/profile', label: 'Business profile', secondary: true },
            ]}
          >
            A quote is raised from a company’s page, from the services that answer what the business needs. Your business
            profile supplies the GST and the UPI code for the advance.
          </EmptyState>
        )
      ) : (
        <table>
          <thead>
            <tr><th>Number</th><th>Business</th><th>Title</th><th>Status</th><th>Valid until</th><th className="num">Total</th></tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td><a href={`/quotes/${q.id}`}>{q.number}</a></td>
                <td><a href={`/companies/${encodeURIComponent(q.companyDomain)}`}>{q.companyName || q.companyDomain}</a></td>
                <td>{q.title}</td>
                <td>
                  <span className={`pill quote-status-${q.status}`}>{q.status}</span>
                  {q.status === 'sent' && quoteLapsed(q.validUntil, now) ? <span className="tag" style={{ marginLeft: 4 }}>lapsed</span> : null}
                </td>
                <td>{q.validUntil}</td>
                <td className="num">{money(q.total, q.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  )
}
