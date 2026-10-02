import { redirect } from 'next/navigation'
import { STAGE_ROT_DAYS, can, dealIsOverdue, rottingState, untouchedLabel } from '@agency/core'
import { eq } from 'drizzle-orm'
import { dealsDue, listDealsForBoard, listProposals, schema, upcomingMeetings, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { PipelineBoard, type DealCard, type Stage } from '@/components/pipeline/board'
import { When } from '@/components/when'
import { deployment } from '@/lib/deployment'
import { getDb } from '@/lib/db'
import { inZone } from '@/lib/format'

/**
 * The pipeline (PROMPT.md §8.6).
 *
 * The board, the meetings coming up (each linking to its brief), and the
 * proposals written. Closed deals older than sixty days drop off the board
 * — they are still in the table and the audit log — so `won` and `lost`
 * show recent outcomes rather than everything that ever happened.
 *
 * Above the board, what is due: every open deal whose `next_action_at` falls
 * within the next twenty-four hours or has passed. A due date set from the
 * board is the END of the day it names in the setter's zone, so "within 24
 * hours" is "today" wherever they are — the server does not know the
 * viewer's zone, and does not pretend to. Each card's "untouched" verdict is
 * core's `rottingState`, computed here from `updated_at`, and the lede
 * states the thresholds from `STAGE_ROT_DAYS` rather than repeating them.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CLOSED_SHOWN_FOR_DAYS = 60
const DUE_WITHIN_MS = 24 * 3_600_000

export default async function PipelinePage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const cutoff = new Date(now.getTime() - CLOSED_SHOWN_FOR_DAYS * 86_400_000)
  const [deals, due, team, meetings, proposals] = await Promise.all([
    listDealsForBoard(db, user.orgId),
    dealsDue(db, user.orgId, new Date(now.getTime() + DUE_WITHIN_MS)),
    // The team, for the assign control. Small by definition (§1 calls this a
    // 2-5 person agency) so there is nothing to paginate.
    db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.orgId, user.orgId))
      .orderBy(schema.users.email),
    upcomingMeetings(db, user.orgId, now, 20),
    listProposals(db, user.orgId, 50),
  ])

  const cards: DealCard[] = deals
    .filter((d) => !d.closedAt || d.closedAt.getTime() >= cutoff.getTime())
    .map((d) => {
      const lastChanged = d.updatedAt ?? d.createdAt
      const rot = d.closedAt ? null : rottingState(d.stage, lastChanged, now)
      return {
        id: d.id,
        stage: d.stage as Stage,
        companyId: d.companyId,
        companyDomain: d.companyDomain,
        companyName: d.companyName,
        nextAction: d.nextAction,
        valueCents: d.valueCents,
        currency: d.currency,
        lostReason: d.lostReason,
        updatedAt: lastChanged.toISOString(),
        closedAt: d.closedAt ? d.closedAt.toISOString() : null,
        nextActionAt: d.nextActionAt ? d.nextActionAt.toISOString() : null,
        // Decided for closed cards too: the board hides their date, and a card
        // reopened by a drag must not come back claiming it is on time.
        overdue: dealIsOverdue(d.nextActionAt, now),
        untouched: rot,
        rottenLabel: rot?.rotten ? untouchedLabel(rot.days) : null,
        ownerUserId: d.ownerUserId,
        ownerEmail: d.ownerEmail,
        ownerName: d.ownerName,
      }
    })
  const hiddenClosed = deals.length - cards.length
  const thresholds = Object.entries(STAGE_ROT_DAYS)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .map(([stage, days]) => `${stage} ${days}`)
    .join(', ')

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="pipeline" signOut={signOutAction}>
      <h1>Pipeline</h1>
      <p className="lede">
        One card per company something has happened to.{' '}
        {deployment().worker
          ? 'Sends and replies move cards forward on their own; a person moves them anywhere, and a lost deal is asked for its reason.'
          : 'A person moves cards anywhere, and a lost deal is asked for its reason. Nothing moves them on its own here: no worker is connected to this deployment, so nothing is sending or reading replies.'}
        {hiddenClosed > 0 ? <> {hiddenClosed} closed more than {CLOSED_SHOWN_FOR_DAYS} days ago {hiddenClosed === 1 ? 'is' : 'are'} not shown.</> : null}
        {' '}A card is marked untouched once nobody has changed it for its stage&apos;s limit, in days
        ({thresholds}) — counted from the last change to the card, a due date included, not from when it
        entered the stage. <a href="/pipeline/analytics">Analytics →</a>
      </p>

      <h2>Due today, or overdue</h2>
      {due.length === 0 ? (
        <p className="muted">
          Nothing due. A due date is set on a card, and it is the end of the day it names; this lists every
          open deal due within the next twenty-four hours or already past it.
        </p>
      ) : (
        <table>
          <thead>
            <tr><th>Due</th><th>Company</th><th>Stage</th><th>Next action</th><th>Owner</th></tr>
          </thead>
          <tbody>
            {due.map((d) => {
              const late = dealIsOverdue(d.nextActionAt, now)
              return (
                <tr key={d.id}>
                  <td className="mono">
                    {d.nextActionAt ? <When iso={d.nextActionAt.toISOString()} mode="date" /> : '—'}
                    {late ? <> <span className="tag warn">overdue</span></> : null}
                  </td>
                  <td><a href={`/companies/${encodeURIComponent(d.companyDomain)}`}>{d.companyName ?? d.companyDomain}</a></td>
                  <td className="mono">{d.stage}</td>
                  <td>{d.nextAction ?? <span className="muted">no next action written</span>}</td>
                  <td>{d.ownerName?.trim() || d.ownerEmail || <span className="muted">unassigned</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h2>Board</h2>
      <PipelineBoard deals={cards} canWrite={can(principal, 'deals:write')} team={team} rotDays={STAGE_ROT_DAYS} />

      <h2>Meetings coming up</h2>
      {meetings.length === 0 ? (
        <p className="muted">Nothing booked. A meeting is recorded from a company&apos;s page, by the agent, or through the booking link.</p>
      ) : (
        <table>
          <thead>
            <tr><th>When</th><th>Company</th><th>Title</th><th>Source</th><th></th></tr>
          </thead>
          <tbody>
            {meetings.map((m) => (
              <tr key={m.id}>
                <td className="mono">{inZone(m.startsAt, m.timeZone)}</td>
                <td><a href={`/companies/${encodeURIComponent(m.companyDomain)}`}>{m.companyName ?? m.companyDomain}</a></td>
                <td>{m.title ?? '—'}</td>
                <td className="mono">{m.source.replace(/_/g, ' ')}</td>
                <td><a href={`/meetings/${m.id}`}>Brief →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Proposals</h2>
      {proposals.length === 0 ? (
        <p className="muted">None written. A proposal is generated from a company&apos;s page, from its latest scan.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Title</th><th>Status</th><th>Estimate</th><th>Generated</th></tr>
          </thead>
          <tbody>
            {proposals.map((p) => (
              <tr key={p.id}>
                <td><a href={`/proposals/${p.id}`}>{p.title}</a></td>
                <td><span className={`tag${p.status === 'accepted' ? ' on' : p.status === 'declined' || p.status === 'withdrawn' ? ' warn' : ''}`}>{p.status}</span></td>
                <td className="mono">
                  {p.totalLow != null && p.totalHigh != null
                    ? `${p.currency} ${p.totalLow.toLocaleString('en-US')}–${p.totalHigh.toLocaleString('en-US')}`
                    : 'effort only'}
                </td>
                <td className="mono"><When iso={p.generatedAt.toISOString()} mode="date" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  )
}
