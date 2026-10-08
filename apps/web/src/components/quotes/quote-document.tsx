import { amountInWords, money, quotePayment, unitWords, type QuoteView } from '@/lib/quote-view'

/**
 * A quote, as the buyer reads it and as it prints (0023): who is offering
 * what, to whom, for how much with GST, until when, why — the needs it
 * answers, each with the dated lines that showed it — and how to pay the
 * advance by UPI. No internal score or note: the same document goes to the
 * team's print view and the buyer's link.
 */
export function QuoteDocument({ view, showPayment = true }: { view: QuoteView; showPayment?: boolean }) {
  const s = view.seller
  const payment = showPayment ? quotePayment(view) : null
  const words = amountInWords(view.total, view.currency)
  return (
    <article className="quote-doc">
      <header className="quote-head">
        <div>
          <div className="quote-seller">{s.legalName || s.name}</div>
          {s.legalName && s.legalName !== s.name ? <div className="muted">{s.name}</div> : null}
          {s.address ? <div className="quote-small">{s.address}</div> : null}
          <div className="quote-small">
            {[s.phone, s.email, s.website].filter(Boolean).join(' · ')}
          </div>
          {s.gstin ? <div className="quote-small">GSTIN {s.gstin}</div> : null}
        </div>
        <div className="quote-meta">
          <div className="quote-kind">Quotation</div>
          <div><strong>{view.number}</strong></div>
          <div className="quote-small">Date {view.dated}</div>
          <div className="quote-small">Valid until {view.validUntil}</div>
        </div>
      </header>

      <section className="quote-to">
        <div className="quote-label">Prepared for</div>
        <div><strong>{view.buyer.company}</strong></div>
        {view.buyer.contact ? <div className="quote-small">{view.buyer.contact}</div> : null}
      </section>

      <h1 className="quote-title">{view.title}</h1>
      {view.intro ? <p className="quote-intro">{view.intro}</p> : null}

      {view.needs.length > 0 ? (
        <section className="quote-why">
          <div className="quote-label">What we noticed</div>
          <ul>
            {view.needs.map((n) => (
              <li key={n.label}>
                <strong>{n.label}</strong>
                {n.evidence.length > 0 ? <div className="quote-small">{n.evidence.join(' · ')}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <table className="quote-lines">
        <thead>
          <tr>
            <th style={{ width: 28 }}>#</th>
            <th>Service</th>
            <th className="num">Qty</th>
            <th className="num">Rate</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {view.items.map((item, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>
                <div><strong>{item.name}</strong></div>
                {item.description ? <div className="quote-small">{item.description}</div> : null}
              </td>
              <td className="num">
                {item.quantity}
                {item.unit !== 'one_off' ? <div className="quote-small">{unitWords(item.unit)}</div> : null}
              </td>
              <td className="num">{money(item.unitPrice, view.currency)}</td>
              <td className="num">{money(item.quantity * item.unitPrice, view.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4} className="num">Subtotal</td>
            <td className="num">{money(view.subtotal, view.currency)}</td>
          </tr>
          {view.taxRate > 0 ? (
            <tr>
              <td colSpan={4} className="num">GST {view.taxRate}%</td>
              <td className="num">{money(view.taxAmount, view.currency)}</td>
            </tr>
          ) : null}
          <tr className="quote-total">
            <td colSpan={4} className="num">Total</td>
            <td className="num">{money(view.total, view.currency)}</td>
          </tr>
        </tfoot>
      </table>
      {words ? <p className="quote-small" style={{ textAlign: 'right' }}>{words}</p> : null}

      {view.advanceAmount > 0 ? (
        <section className="quote-pay">
          <div>
            <div className="quote-label">To start</div>
            <p style={{ margin: '4px 0' }}>
              An advance of <strong>{money(view.advanceAmount, view.currency)}</strong> ({view.advancePercent}% of the total), the
              rest as agreed in the terms below.
            </p>
            {payment ? (
              <p className="quote-small" style={{ margin: '4px 0' }}>
                Pay by UPI to <strong>{payment.vpa}</strong> ({payment.payee}) — scan the code with any UPI app, or{' '}
                <a href={payment.uri} className="print-hide">tap here on your phone</a>.
              </p>
            ) : null}
          </div>
          {payment ? <div className="quote-qr" dangerouslySetInnerHTML={{ __html: payment.svg }} /> : null}
        </section>
      ) : null}

      {view.terms ? (
        <section className="quote-terms">
          <div className="quote-label">Terms</div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{view.terms}</p>
        </section>
      ) : null}

      {s.brochureUrl ? (
        <p className="quote-small">
          More about us: <a href={s.brochureUrl} target="_blank" rel="noreferrer noopener">{s.brochureUrl}</a>
        </p>
      ) : null}
    </article>
  )
}
