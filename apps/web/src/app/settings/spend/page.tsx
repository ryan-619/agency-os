import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import {
  SPEND_WINDOW_DAYS, spendByDay, spendByPerson, spendRunRate, spendTotal, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { orgIdentity } from '../org'

/**
 * Settings → Spend: what the model has actually cost, from the rows.
 *
 * The same three questions tools/spend.sh answers from a terminal — per day,
 * per person, and a run rate — scoped to this organisation. Every figure is
 * summed, divided and projected by Postgres (`packages/db/src/spend.ts`):
 * `cost_usd` is `numeric`, which arrives here as a STRING, and adding two in
 * JavaScript concatenates them. This page only formats what it is handed.
 *
 * Readable by any member (`audit:read`). Per-person spend names teammates,
 * and the team page already shows every member the roster.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Four decimal places, as tools/spend.sh prints. Formatting, not arithmetic:
 * the number is parsed only to be printed, and never added to anything.
 */
function money(v: string): string {
  const n = Number(v)
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : '—'
}

export default async function SpendPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const org = await orgIdentity(user.orgId)

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'audit:read')) {
    return (
      <Shell user={user} orgName={org.name} current="spend" signOut={signOutAction}>
        <h1>Spend</h1>
        <div className="note">Your role cannot read what the model has cost.</div>
      </Shell>
    )
  }

  const db = getDb() as unknown as AgencyDb
  const [total, rate, days, people] = await Promise.all([
    spendTotal(db, user.orgId),
    spendRunRate(db, user.orgId),
    spendByDay(db, user.orgId, SPEND_WINDOW_DAYS),
    spendByPerson(db, user.orgId, SPEND_WINDOW_DAYS),
  ])

  return (
    <Shell user={user} orgName={org.name} current="spend" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Spend</h1>
      <p className="lede">
        What chat turns have cost, from the rows the worker wrote — per day, per person, and what the last week
        projects to.
      </p>

      <div className="cards">
        <div className="card"><div className="n">{money(rate.last7Usd)}</div><div className="k">Last 7 days</div></div>
        <div className="card"><div className="n">{money(rate.perDayUsd)}</div><div className="k">Per day, at that rate</div></div>
        <div className="card"><div className="n">{money(rate.projectedMonthUsd)}</div><div className="k">A month at that rate</div></div>
        <div className="card">
          <div className="n">{money(total.usd)}</div>
          <div className="k">All time, over {total.turns} costed turn{total.turns === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="note" style={{ marginTop: 16 }}>
        <strong>These are the SDK&apos;s own figures, not an estimate.</strong> For each turn the worker stores the
        SDK&apos;s reported total, less anything already stored within that same turn. That is the turn&apos;s own
        cost because, today, a resumed conversation&apos;s total starts again from zero on every turn. An SDK
        upgrade under which a resumed session&apos;s total carried on from earlier turns would make each stored
        turn include the ones before it — these numbers would change meaning without changing how they look.
        The last seven days are rolling, and a month is 4.35 weeks, as <code>tools/spend.sh</code> projects it.
      </div>

      <h2>By day, last {SPEND_WINDOW_DAYS} days</h2>
      {days.length === 0 ? (
        <p className="muted">Nothing was spent in the last {SPEND_WINDOW_DAYS} days.</p>
      ) : (
        <>
          <table>
            <thead><tr><th>Day (UTC)</th><th>Turns</th><th>Spent</th></tr></thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td className="mono">{d.day}</td>
                  <td className="mono">{d.turns}</td>
                  <td className="mono">{money(d.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12.5 }}>A day with no costed turn has no row.</p>
        </>
      )}

      <h2>By person, last {SPEND_WINDOW_DAYS} days</h2>
      {people.length === 0 ? (
        <p className="muted">Nobody&apos;s turns cost anything in the last {SPEND_WINDOW_DAYS} days.</p>
      ) : (
        <table>
          <thead><tr><th>Person</th><th>Turns</th><th>Spent</th></tr></thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.userId}>
                <td>
                  {p.name ? `${p.name} · ` : ''}{p.email}
                  {p.revoked ? <span className="tag" style={{ marginLeft: 8 }}>access revoked</span> : null}
                </td>
                <td className="mono">{p.turns}</td>
                <td className="mono">{money(p.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  )
}
