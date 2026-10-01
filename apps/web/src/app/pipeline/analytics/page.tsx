import { redirect } from 'next/navigation'
import { pipelineMetrics } from '@agency/core'
import { analyticsTransitions, listDeals, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { getDb } from '@/lib/db'

/**
 * Pipeline analytics: counts per stage, conversion from each stage to the
 * next, the median stay in a stage, the win rate and how long winning takes.
 *
 * The arithmetic is core's `pipelineMetrics`; this page only lays it out,
 * and it lays out every figure beside the count it came from. Below the
 * minimum sample a figure is `null` and the page says "insufficient data"
 * instead of printing a ratio of two. Conversion and time in stage come from
 * the moves the audit log recorded (`analyticsTransitions`), which is not
 * every move there was — the note says which are missing, so a reader knows
 * those counts are lower bounds rather than finding out.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function PipelineAnalyticsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const [deals, moves] = await Promise.all([
    listDeals(db, user.orgId),
    analyticsTransitions(db, user.orgId),
  ])
  const m = pipelineMetrics(deals, moves, now)
  const insufficient = `insufficient data (< ${m.minSample})`
  const pct = (rate: number): string => `${Math.round(rate * 100)}%`

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="pipeline" signOut={signOutAction}>
      <p className="crumb"><a href="/pipeline">← Pipeline</a></p>
      <h1>Pipeline analytics</h1>
      <p className="lede">
        Every figure carries its denominator. Below {m.minSample === 5 ? 'five' : m.minSample} deals a number is not a
        number. Some moves are recorded only inside other audit actions, so conversions are lower bounds. All time,
        as of <When iso={m.asOf.toISOString()} />.
      </p>

      <div className="cards">
        <div className="card">
          <div className="n">{m.winRate.rate === null ? '—' : pct(m.winRate.rate)}</div>
          <div className="k">
            win rate: {m.winRate.won} won of {m.winRate.closed} closed
            {m.winRate.rate === null ? <> — {insufficient}</> : null}
          </div>
        </div>
        <div className="card">
          <div className="n">{m.velocityDays === null ? '—' : `${m.velocityDays} d`}</div>
          <div className="k">
            median days from a deal&apos;s creation to won, over {m.velocitySample} won
            {m.velocityDays === null ? <> — {insufficient}</> : null}
          </div>
        </div>
        <div className="card">
          <div className="n">{deals.filter((d) => d.closedAt === null).length}</div>
          <div className="k">open deals, of {deals.length} in all</div>
        </div>
      </div>

      <h2>Deals by stage, now</h2>
      <table>
        <thead>
          <tr><th>Stage</th><th>Open</th><th>All</th></tr>
        </thead>
        <tbody>
          {m.perStage.map((s) => (
            <tr key={s.stage}>
              <td className="mono">{s.stage}</td>
              <td className="mono">{s.open}</td>
              <td className="mono">{s.total}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Conversion</h2>
      <p className="muted">
        Of the deals known to have entered a stage, how many are known to have gone further. Skipping the next stage
        counts as going further; losing the deal does not. A deal still in the stage has entered it and not yet gone on.
      </p>
      <table>
        <thead>
          <tr><th>From</th><th>To</th><th>Went on</th><th>Rate</th></tr>
        </thead>
        <tbody>
          {m.conversion.map((c) => (
            <tr key={c.from}>
              <td className="mono">{c.from}</td>
              <td className="mono">{c.to} or further</td>
              <td className="mono">{c.advanced} of {c.entered}</td>
              <td className={c.rate === null ? 'muted' : 'mono'}>{c.rate === null ? insufficient : pct(c.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Time in stage</h2>
      <p className="muted">
        The median stay, counted only from stays whose arrival and departure were both recorded. A stay still going is
        not one, and nor is one with a move missing on either side.
      </p>
      <table>
        <thead>
          <tr><th>Stage</th><th>Median days</th><th>Stays measured</th></tr>
        </thead>
        <tbody>
          {m.medianDaysInStage.map((s) => (
            <tr key={s.stage}>
              <td className="mono">{s.stage}</td>
              <td className={s.days === null ? 'muted' : 'mono'}>{s.days === null ? insufficient : s.days}</td>
              <td className="mono">{s.sample}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="note" style={{ marginTop: 22 }}>
        <strong>What these numbers are made of.</strong> {m.note} Read from {moves.length} recorded{' '}
        {moves.length === 1 ? 'move' : 'moves'}
        {moves.skipped > 0 ? (
          <>
            ; {moves.skipped} audit {moves.skipped === 1 ? 'row' : 'rows'} named as a move could not be read as one and{' '}
            {moves.skipped === 1 ? 'is' : 'are'} not counted
          </>
        ) : null}
        .
      </div>
    </Shell>
  )
}
