import { quotesList, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { money } from '@/lib/quote-view'
import { NewQuoteButton } from '@/components/quotes/new-quote-button'
import type { CompanySlotProps } from './slot'

/**
 * A company's quotes (0023): each with its number, status and total, and a
 * button that raises a new one — prefilled from the services its needs point
 * at — and opens it to edit.
 */
export async function QuotesSlot(props: CompanySlotProps) {
  const quotes = await quotesList(getDb() as unknown as AgencyDb, { orgId: props.orgId, companyId: props.companyId, limit: 20 })
  return (
    <section className="card" style={{ marginTop: 18 }}>
      <div className="row-head" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Quotes</h2>
        <NewQuoteButton companyId={props.companyId} />
      </div>
      {quotes.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          No quote yet. A new one starts from the services that answer what this business needs, at your prices — edit
          anything before you send it.
        </p>
      ) : (
        <table style={{ marginTop: 8 }}>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td><a href={`/quotes/${q.id}`}>{q.number}</a></td>
                <td>{q.title}</td>
                <td><span className={`pill quote-status-${q.status}`}>{q.status}</span></td>
                <td className="num">{money(q.total, q.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
