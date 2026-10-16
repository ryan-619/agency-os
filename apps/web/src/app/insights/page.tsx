import { redirect } from 'next/navigation'
import { can, formatMoney } from '@agency/core'
import { INSIGHTS_MIN, INSIGHTS_WINDOW_DAYS, rateWords, whatsWorking, type AgencyDb, type ReachRow } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'

/**
 * What's working (2026-10-08): of the people written to in the last 90 days,
 * who replied, was interested, asked to stop, and became a won deal — by kind
 * of business, city and campaign — which message in a campaign drew the
 * reply, how the links businesses were sent got opened, and what quotes
 * became. Counts only, from what was recorded; a rate over fewer than five
 * people says it is too few to tell.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PAGE_WORDS: Readonly<Record<string, string>> = { quote: 'Quotes', report: 'Audit pages', preview: 'Website previews' }
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

function ReachTable({ rows, label, blank }: { readonly rows: readonly ReachRow[]; readonly label: string; readonly blank: string }) {
  if (rows.length === 0) return <p className="muted">Nobody was written to in this window.</p>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr><th>{label}</th><th>Written to</th><th>Replied</th><th>Interested</th><th>Asked to stop</th><th>Won</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key || '—'}>
              <td>{r.key ? r.key.replace(/_/g, ' ') : <span className="muted">{blank}</span>}</td>
              <td className="mono">{r.written}</td>
              <td>{rateWords(r.replied, r.written)}</td>
              <td>{rateWords(r.interested, r.written)}</td>
              <td>{rateWords(r.optedOut, r.written)}</td>
              <td className="mono">{r.won}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function InsightsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:read')) redirect('/')
  const w = await whatsWorking(getDb() as unknown as AgencyDb, { orgId: user.orgId, now: new Date() })

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="insights" signOut={signOutAction}>
      <h1>What&apos;s working</h1>
      <p className="lede">
        Of the people written to in the last {INSIGHTS_WINDOW_DAYS} days: who replied, who was interested, who asked to
        stop, and whose company became a won deal. Each person counts once, from their first message in the window; an
        auto-reply is not a reply. Under five people, a rate is too few to tell.
      </p>

      <h2>By kind of business</h2>
      <ReachTable rows={w.byKind} label="Kind (Google category)" blank="not found on the map" />

      <h2>By city</h2>
      <ReachTable rows={w.byCity} label="City" blank="no city recorded" />

      <h2>By campaign</h2>
      {w.byCampaign.length === 0 ? <p className="muted">No campaign has sent anything in this window.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr><th>Campaign</th><th>Written to</th><th>Replied</th><th>Interested</th><th>Asked to stop</th><th>Replied after</th></tr>
            </thead>
            <tbody>
              {w.byCampaign.map((c) => (
                <tr key={c.key}>
                  <td>{c.name}</td>
                  <td className="mono">{c.written}</td>
                  <td>{rateWords(c.replied, c.written)}</td>
                  <td>{rateWords(c.interested, c.written)}</td>
                  <td>{rateWords(c.optedOut, c.written)}</td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {c.afterMessage.length === 0 ? '—' : c.afterMessage.map((a) => `${a.replied} after the ${ordinal(a.n)} message`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12.5 }}>
        &quot;Replied after&quot; counts the campaign&apos;s messages that had gone to a person before their first reply — so a
        follow-up step that draws replies shows here. <a href="/campaigns">Campaigns →</a>
      </p>

      <h2>Links and quotes</h2>
      <ul>
        {w.pages.length === 0 ? <li className="muted">No links were made in this window.</li> : w.pages.map((p) => (
          <li key={p.kind}>
            {PAGE_WORDS[p.kind] ?? p.kind}: {p.opened} of {p.made} opened{p.made >= INSIGHTS_MIN ? ` (${Math.round((100 * p.opened) / p.made)}%)` : ''}
          </li>
        ))}
        <li>
          Quotes sent: {w.quotes.sent} — {rateWords(w.quotes.accepted, w.quotes.sent)} accepted, {w.quotes.declined} declined
          {w.quotes.acceptedValue > 0 ? `; ${formatMoney(w.quotes.acceptedValue, 'INR')} accepted in all` : ''}.
        </li>
      </ul>
    </Shell>
  )
}
