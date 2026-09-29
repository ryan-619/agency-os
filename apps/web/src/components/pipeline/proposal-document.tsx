import type { Proposal } from '@agency/core'
import { When } from '../when'

/**
 * The proposal, as a document (PROMPT.md §8.6).
 *
 * Rendered from the stored JSON, never regenerated: what was sent to a
 * buyer stays what it was, whatever the scan says now. The evidence is under
 * every scope item, so a reader can check the scope against the site rather
 * than take it on trust (§2.2).
 *
 * One document, two readers. The team sees everything the generator wrote,
 * including the score it worked from and each item's weight — numbers that
 * describe how the pipeline ranks a prospect, which is the agency's business
 * and not the buyer's. The buyer's copy omits those, and omits the word
 * "stale" and any warning box: whether a buyer may be handed an aged
 * proposal at all is decided by whoever hands it over, not softened by a
 * footnote in it. What both readers get, verbatim, is the two honest
 * sentences §2.2 insists on — a strength is "not the case here (…)", with
 * the bracketed wording identified as what the scan looks for; and a signal
 * that could not be observed is "not assessed", never assumed fine.
 */
export function ProposalDocument({
  doc, company, agency, status, evidenceAsOf, evidenceStale, audience,
}: {
  doc: Proposal
  company: { domain: string; name: string | null }
  agency: { name: string }
  status: string
  /** The scan's `ran_at`, as the page read it; null when the scan row is gone. */
  evidenceAsOf: string | null
  /** Derived by the page from `ran_at` (§2.2). Marked for the team; never said to a buyer. */
  evidenceStale: boolean
  audience: 'team' | 'buyer'
}) {
  const buyer = audience === 'buyer'
  const money = (n: number) => `${doc.pricing.currency} ${n.toLocaleString('en-US')}`
  const scannedAt = evidenceAsOf ?? doc.basedOn.scanRanAt

  return (
    <article className="proposal">
      {buyer ? (
        <header>
          <h1>{doc.title}</h1>
          <p className="lede">
            Prepared by {agency.name} for {company.name ?? company.domain}
            {status === 'accepted' ? <span className="tag on">accepted</span> : null}
            {status === 'declined' || status === 'withdrawn' ? <span className="tag warn">{status}</span> : null}
          </p>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Everything below came from {company.domain}&apos;s own public pages, read from the outside on{' '}
            <When iso={scannedAt} mode="date" />. Nothing private was accessed; this is posture review from the
            outside, not a security test.
          </p>
        </header>
      ) : null}

      <section>
        <h2>Summary</h2>
        <p>{doc.summary}</p>
        <p className="muted" style={{ fontSize: 12.5 }}>
          Based on the scan of <When iso={doc.basedOn.scanRanAt} mode="date" />
          {!buyer && doc.basedOn.score != null ? <> · score {doc.basedOn.score}/100{doc.basedOn.tier ? `, tier ${doc.basedOn.tier}` : ''}</> : null}
          {!buyer && evidenceStale ? <span className="pill pill-stale">stale</span> : null}
        </p>
      </section>

      {doc.workstreams.map((ws) => (
        <section key={ws.name} className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>
            {ws.name}
            <span className="muted" style={{ float: 'right', fontWeight: 400, fontSize: 13 }}>
              {ws.effortDays.low}–{ws.effortDays.high} days
            </span>
          </h2>
          <p className="muted" style={{ fontSize: 13 }}>{ws.summary}</p>
          <table>
            <thead><tr><th>Deliverable</th><th>Why</th><th>Evidence observed</th></tr></thead>
            <tbody>
              {ws.items.map((item) => (
                <tr key={item.signalKey}>
                  <td>
                    <div>{item.deliverable}</div>
                    {buyer ? null : (
                      <div className="mono muted" style={{ fontSize: 11.5 }}>{item.signalKey} · weight {item.weight}</div>
                    )}
                  </td>
                  <td>{item.why}</td>
                  <td>
                    <dl className="evidence">
                      {item.evidence.map((line, i) => <dd key={i} className="mono">{line}</dd>)}
                    </dl>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Pricing</h2>
        <table>
          <tbody>
            <tr><th>Effort</th><td className="mono">{doc.pricing.effortDays.low}–{doc.pricing.effortDays.high} days</td></tr>
            <tr><th>Day rate</th><td className="mono">{doc.pricing.dayRate != null ? money(doc.pricing.dayRate) : 'not set — effort only'}</td></tr>
            <tr><th>Total</th><td className="mono">{doc.pricing.total ? `${money(doc.pricing.total.low)} – ${money(doc.pricing.total.high)}` : '—'}</td></tr>
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: 14 }}>
        <h2>Assumptions</h2>
        <ul>{doc.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      </section>

      {doc.alreadyInPlace.length > 0 ? (
        <section>
          <h2>Already in place</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Checked from the outside and not found to be a problem. Out of scope. (The wording in brackets is
            what the scan looks for, not what it found.)
          </p>
          <ul>
            {doc.alreadyInPlace.map((s) => (
              <li key={s.signalKey}><span className="mono">{s.signalKey}</span> <span className="muted">— not the case here ({s.why})</span></li>
            ))}
          </ul>
        </section>
      ) : null}

      {doc.notAssessed.length > 0 ? (
        <section>
          <h2>Not assessed</h2>
          <div className="note">
            <strong>These could not be observed from the outside and are excluded from scope — not assumed to be fine.</strong>
            <ul>{doc.notAssessed.map((s) => <li key={s.signalKey}><span className="mono">{s.signalKey}</span> — {s.why}</li>)}</ul>
          </div>
        </section>
      ) : null}
    </article>
  )
}
