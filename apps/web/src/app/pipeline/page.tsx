import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { listDealsForBoard, listProposals, upcomingMeetings, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { PipelineBoard, type DealCard, type Stage } from '@/components/pipeline/board'
import { When } from '@/components/when'
import { deployment } from '@/lib/deployment'
import { getDb } from '@/lib/db'
import { inZone } from '@/lib/format'
import { icpForOrg } from '@/lib/queries'

/**
 * The pipeline (PROMPT.md §8.6).
 *
 * The board, the meetings coming up (each linking to its brief), and the
 * proposals written. Closed deals older than sixty days drop off the board
 * — they are still in the table and the audit log — so `won` and `lost`
 * show recent outcomes rather than everything that ever happened.
 */
export const dynamic = 'force-dynamic'

const CLOSED_SHOWN_FOR_DAYS = 60

export default async function PipelinePage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const cutoff = new Date(now.getTime() - CLOSED_SHOWN_FOR_DAYS * 86_400_000)
  const [deals, meetings, proposals, icpRow] = await Promise.all([
    listDealsForBoard(db, user.orgId),
    upcomingMeetings(db, user.orgId, now, 20),
    listProposals(db, user.orgId, 50),
    icpForOrg(user.orgId),
  ])

  const cards: DealCard[] = deals
    .filter((d) => !d.closedAt || d.closedAt.getTime() >= cutoff.getTime())
    .map((d) => ({
      id: d.id,
      stage: d.stage as Stage,
      companyId: d.companyId,
      companyDomain: d.companyDomain,
      companyName: d.companyName,
      nextAction: d.nextAction,
      valueCents: d.valueCents,
      currency: d.currency,
      lostReason: d.lostReason,
      updatedAt: (d.updatedAt ?? d.createdAt).toISOString(),
      closedAt: d.closedAt ? d.closedAt.toISOString() : null,
    }))
  const hiddenClosed = deals.length - cards.length

  let orgLabel = 'Agency'
  if (icpRow) {
    try {
      orgLabel = parseIcpDefinition(icpRow.definition).label
    } catch {
      orgLabel = 'Agency'
    }
  }
  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={orgLabel} current="pipeline" signOut={signOutAction}>
      <h1>Pipeline</h1>
      <p className="lede">
        One card per company something has happened to.{' '}
        {deployment().worker
          ? 'Sends and replies move cards forward on their own; a person moves them anywhere, and a lost deal is asked for its reason.'
          : 'A person moves cards anywhere, and a lost deal is asked for its reason. Nothing moves them on its own here: no worker is connected to this deployment, so nothing is sending or reading replies.'}
        {hiddenClosed > 0 ? <> {hiddenClosed} closed more than {CLOSED_SHOWN_FOR_DAYS} days ago {hiddenClosed === 1 ? 'is' : 'are'} not shown.</> : null}
      </p>
      <PipelineBoard deals={cards} canWrite={can(principal, 'deals:write')} />

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
