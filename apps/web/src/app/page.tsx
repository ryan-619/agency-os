import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { NEEDS, can } from '@agency/core'
import {
  COMPLIANCE_WINDOW_DAYS, auditResolveActors, auditSubjectsToCompanies, complianceAutoSendOffCold,
  complianceColdOptInTouches, complianceDisclosure, complianceDraftsOnStaleEvidence, complianceEvidenceFreshness,
  complianceOptOutsNotRecorded, complianceOptOutsWithoutSuppression, inboxUnhandledCount, listAudit, listDeals,
  nightReportLatest, tasksCounts, todayActions, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { AuditLog } from '@/components/audit/log'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { readIcp } from '@/lib/company-list'
import {
  ICP_OUTREACH_NOTE, complianceChecksFailing, dealsNeedingALook, feedLines, feedPersonIds, honestyBullets,
  honestyHeadline, needsALook, quietFeedNote, splitLook, workerLine,
} from '@/lib/dashboard-view'
import { getDb, schema } from '@/lib/db'
import { deployment } from '@/lib/deployment'
import { workerStatus } from '@/lib/worker-status'

/**
 * The dashboard: what needs a person, what just happened, and what this
 * deployment can and cannot do (PROMPT.md §2.2).
 *
 * Every sentence on it is decided in `lib/dashboard-view.ts` from a fact —
 * the configuration (`deployment()`), the newest worker heartbeat, the audit
 * log — and every number is a count from the same function the page it
 * links to uses: the inbox's unhandled count, the board's rotting rule, the
 * tasks' overdue rule, the compliance page's freshness and must-be-zero
 * checks, at the ICP's own stale threshold. A counter that could disagree
 * with the list it opens is worse than no counter.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const FEED_ROWS = 10
const MS_PER_DAY = 86_400_000

/** One round trip for the totals row. */
async function counts(orgId: string) {
  const result = await getDb().execute<{
    companies: string
    contacts: string
    findings: string
    deals: string
    campaigns: string
    approvals: string
    connectors: string
  }>(sql`
    SELECT
      (SELECT count(*) FROM ${schema.companies}  WHERE org_id = ${orgId}) AS companies,
      (SELECT count(*) FROM ${schema.contacts}   WHERE org_id = ${orgId}) AS contacts,
      (SELECT count(*) FROM ${schema.findings}   WHERE org_id = ${orgId}) AS findings,
      (SELECT count(*) FROM ${schema.deals}      WHERE org_id = ${orgId}) AS deals,
      (SELECT count(*) FROM ${schema.campaigns}  WHERE org_id = ${orgId}) AS campaigns,
      (SELECT count(*) FROM ${schema.approvals}  WHERE org_id = ${orgId} AND status = 'pending') AS approvals,
      (SELECT count(*) FROM ${schema.connectors} WHERE org_id = ${orgId} AND enabled) AS connectors
  `)
  // node-postgres returns a QueryResult; the rows are on .rows, not the result.
  const row = result.rows[0]
  return {
    companies: Number(row?.companies ?? 0),
    contacts: Number(row?.contacts ?? 0),
    findings: Number(row?.findings ?? 0),
    deals: Number(row?.deals ?? 0),
    campaigns: Number(row?.campaigns ?? 0),
    approvals: Number(row?.approvals ?? 0),
    connectors: Number(row?.connectors ?? 0),
  }
}

/**
 * The /compliance checks marked "must be zero", from the functions that page
 * calls, over the same window. Only these six — not `complianceSummary`,
 * whose other blocks the dashboard does not show and whose reads would queue
 * behind these on a one-connection pool.
 */
async function complianceMustBeZero(db: AgencyDb, orgId: string, staleDays: number, now: Date) {
  const since = new Date(now.getTime() - COMPLIANCE_WINDOW_DAYS * MS_PER_DAY)
  const [disclosure, withoutSuppression, notStored, coldOptIn, drafts, autoSend] = await Promise.all([
    complianceDisclosure(db, orgId),
    complianceOptOutsWithoutSuppression(db, orgId),
    complianceOptOutsNotRecorded(db, orgId, since, 0),
    complianceColdOptInTouches(db, orgId, 0),
    complianceDraftsOnStaleEvidence(db, orgId, staleDays, now),
    complianceAutoSendOffCold(db, orgId),
  ])
  return {
    draftsAwaiting: drafts.awaiting,
    callsOnRecord: disclosure.calls,
    failing: complianceChecksFailing({
      undisclosedCalls: disclosure.undisclosed.length,
      optOutsWithoutSuppression: withoutSuppression.count,
      optOutsNotStoredLastWindow: notStored.count,
      optInChannelMessagesWithoutOptIn: coldOptIn.touches,
      draftsOnStaleEvidence: drafts.count,
      autoSendOnOptInChannels: autoSend.count,
    }),
  }
}

export default async function Dashboard() {
  const session = await auth()
  if (!session?.user) redirect('/signin')

  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  const mayReadAudit = can(principal, 'audit:read')
  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const live = deployment()

  const [icp] = await getDb()
    .select({ name: schema.icpProfiles.name, definition: schema.icpProfiles.definition })
    .from(schema.icpProfiles)
    .where(sql`${schema.icpProfiles.orgId} = ${user.orgId} AND ${schema.icpProfiles.active}`)
    .limit(1)

  // Read from the stored definition rather than repeating §11's numbers as
  // literals: a dashboard that displays a threshold the engine is not using
  // is the same class of mistake as a finding nobody observed. For the same
  // reason the channels and cap are headed as the profile's DESCRIPTION — the
  // send path applies each campaign's own, and reads neither of these.
  const def = icp?.definition as
    | { scoring?: { qualify_at?: number }; outreach?: { channels?: string[]; max_per_day?: number } }
    | undefined
  const qualifyAt = def?.scoring?.qualify_at
  const channels = def?.outreach?.channels
  const dailyCap = def?.outreach?.max_per_day
  // The stale threshold `/companies?state=stale` filters on, read the way
  // that page reads it, so the counter and the list it opens agree.
  const { staleAfterDays } = readIcp(icp?.definition)

  const [c, worker, unhandled, tasks, deals, freshness, compliance, feed, lastRescan, today, night] = await Promise.all([
    counts(user.orgId),
    workerStatus(db, now),
    inboxUnhandledCount(db, user.orgId),
    tasksCounts(db, user.orgId, now),
    listDeals(db, user.orgId),
    complianceEvidenceFreshness(db, user.orgId, staleAfterDays, now),
    complianceMustBeZero(db, user.orgId, staleAfterDays, now),
    mayReadAudit ? listAudit(db, user.orgId, { limit: FEED_ROWS }) : Promise.resolve([]),
    listAudit(db, user.orgId, { limit: 1, actionPrefix: 'scan.cron_run' }),
    todayActions(db, { orgId: user.orgId, userId: user.id, now }),
    // The night shift's morning list (0025); a database before 0025 shows none rather than failing the page.
    nightReportLatest(db, user.orgId).catch(() => null),
  ])
  // Last night's, not last week's: a list a day and a half old is no longer this morning's.
  const overnight = night && now.getTime() - night.at.getTime() <= 36 * 3_600_000 && night.top.length > 0 ? night : null

  const [companies, people] = await Promise.all([
    auditSubjectsToCompanies(db, user.orgId, feed),
    auditResolveActors(db, user.orgId, feedPersonIds(feed)),
  ])
  const lines = feedLines(feed, companies, people)

  const facts = { now, lastRescanAt: lastRescan[0]?.createdAt ?? null, callsOnRecord: compliance.callsOnRecord }
  const rot = dealsNeedingALook(deals, now)
  const look = splitLook(
    needsALook(
      {
        repliesUnhandled: unhandled,
        draftsAwaiting: compliance.draftsAwaiting,
        approvalsPending: c.approvals,
        dealsRotting: rot.rotting,
        dealsOverdue: rot.overdue,
        tasksOverdue: tasks.overdue,
        companiesStale: freshness.stale,
        companiesNeverScanned: freshness.neverScanned,
        companiesUnreachable: freshness.unreachable,
        staleAfterDays,
        complianceChecksFailing: mayReadAudit ? compliance.failing : null,
      },
      live,
      worker,
    ),
  )
  const status = workerLine(worker, now)
  const headline = honestyHeadline(live, worker, facts)
  const bullets = honestyBullets(live, worker, facts)
  const quiet = quietFeedNote(live, worker)

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell
      user={user}
      current="dashboard"
      signOut={signOutAction}
      pendingApprovals={c.approvals}
    >
        <h1>Dashboard</h1>
        <p className="lede">
          Companies are found, scanned from the outside and scored; the agent researches and drafts
          under a human gate; outreach goes out through one send path; the pipeline runs from reply to
          proposal. Nothing sends, calls or texts without a person or a recorded consent.
        </p>

        <p style={{ margin: '0 0 18px', fontSize: 13.5 }}>
          <span
            aria-hidden
            style={{
              color: status.tone === 'ok' ? 'var(--ok)' : status.tone === 'warn' ? 'var(--warn)' : 'var(--muted)',
              marginRight: 6,
            }}
          >
            ●
          </span>
          <strong>{status.lead}</strong>
          {status.at ? <> <When iso={status.at.toISOString()} /></> : null}
          {status.tail ? <span className="muted"> · {status.tail}</span> : null}
        </p>

        <h2>Today’s top actions</h2>
        {today.length > 0 ? (
          <ol className="today">
            {today.map((a) => (
              <li key={a.id} className={a.kind === 'call' ? 'today-hot' : undefined}>
                <a href={a.href}>{a.title}</a>
                {a.at ? <span className="muted"> · <When iso={a.at.toISOString()} /></span> : null}
                {a.detail ? <div className="muted today-detail">{a.detail}</div> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted" style={{ fontSize: 13.5 }}>
            Nothing is due right now. Ask Chat to find businesses that need what you sell, or look over the{' '}
            <a href="/pipeline">pipeline</a>.
          </p>
        )}

        {overnight ? (
          <>
            <h2>Found overnight</h2>
            <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
              The night shift&apos;s best new finds{overnight.date ? ` (${overnight.date})` : ''}, by what they need and whether
              they can be called — from {overnight.searches} saved {overnight.searches === 1 ? 'search' : 'searches'}, {overnight.added} new in
              all. <a href="/settings/night">Night shift settings →</a>
            </p>
            <ol className="today">
              {overnight.top.map((co) => {
                const needs = (overnight.needs.get(co.id) ?? []).map((k) => NEEDS[k].label)
                const facts = [
                  co.googleCategory?.replace(/_/g, ' '),
                  co.city,
                  co.googleRating !== null ? `★${Number(co.googleRating).toFixed(1)}${co.googleReviewCount ? ` (${co.googleReviewCount})` : ''}` : null,
                  co.phone ? 'phone on file' : null,
                ].filter(Boolean)
                return (
                  <li key={co.id}>
                    <a href={`/companies/${encodeURIComponent(co.domain)}`}>{co.name || co.domain}</a>
                    {facts.length > 0 ? <span className="muted"> · {facts.join(' · ')}</span> : null}
                    {needs.length > 0 ? <div className="muted today-detail">{needs.join(' · ')}</div> : null}
                  </li>
                )
              })}
            </ol>
          </>
        ) : null}

        <h2>Needs a look</h2>
        {look.waiting.length > 0 ? (
          <div className="cards">
            {look.waiting.map((i) => (
              <a key={i.id} className="card" href={i.href}>
                <div className="n" style={i.alarm ? { color: 'var(--warn)' } : undefined}>{i.n}</div>
                <div className="k">{i.label}</div>
                {i.detail ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>{i.detail}</div>
                ) : null}
              </a>
            ))}
          </div>
        ) : null}
        {look.clear.length > 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: look.waiting.length > 0 ? '10px 0 0' : 0 }}>
            {look.waiting.length > 0 ? 'No ' : 'Nothing is waiting on anybody: no '}
            {look.clear.map((i, n) => (
              <span key={i.id}>
                {n === 0 ? '' : n === look.clear.length - 1 ? ' or ' : ', '}
                <a href={i.href}>{i.none}</a>
              </span>
            ))}
            .
          </p>
        ) : null}

        <h2>Totals</h2>
        <div className="cards">
          <a className="card" href="/companies"><div className="n">{c.companies}</div><div className="k">Companies</div></a>
          <a className="card" href="/contacts"><div className="n">{c.contacts}</div><div className="k">Contacts</div></a>
          <div className="card"><div className="n">{c.findings}</div><div className="k">Findings</div></div>
          <a className="card" href="/pipeline"><div className="n">{c.deals}</div><div className="k">Deals</div></a>
          <a className="card" href="/campaigns"><div className="n">{c.campaigns}</div><div className="k">Campaigns</div></a>
          <a className="card" href="/approvals"><div className="n">{c.approvals}</div><div className="k">Pending agent approvals</div></a>
          <a className="card" href="/settings/connectors"><div className="n">{c.connectors}</div><div className="k">Enabled connectors</div></a>
        </div>

        {mayReadAudit ? (
          <>
            <h2>Recent activity</h2>
            {lines.length > 0 ? (
              <AuditLog lines={lines} />
            ) : (
              <div className="note"><strong>Nothing has been recorded yet.</strong></div>
            )}
            <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
              {quiet ? <>{quiet} </> : null}
              <a href="/audit">The whole audit log →</a>
            </p>
          </>
        ) : null}

        <h2>Active ICP</h2>
        <table>
          <thead><tr><th>Profile</th><th>Qualify at</th><th>Channels it describes</th><th>Daily cap it describes</th></tr></thead>
          <tbody>
            <tr>
              <td>{icp?.name ?? '— none seeded —'}</td>
              <td className="mono">{qualifyAt === undefined ? '—' : `${qualifyAt} / 100`}</td>
              <td className="mono">{channels?.join(', ') ?? '—'}</td>
              <td className="mono">{dailyCap ?? '—'}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
          {ICP_OUTREACH_NOTE} <a href="/campaigns">The caps in force are on Campaigns →</a>{' '}
          <a href="/settings/icp">The whole profile →</a>
        </p>

        <h2>What this instance can and cannot do</h2>
        <div className={headline.tone === 'ok' ? 'note' : 'note note-warn'}>
          <strong>{headline.text}</strong>
          <ul>
            {bullets.map((b) => (
              <li key={b.id}>
                <strong>{b.lead}</strong> {b.rest}
              </li>
            ))}
          </ul>
        </div>
    </Shell>
  )
}
