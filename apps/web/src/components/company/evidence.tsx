import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm'
import { isStale } from '@agency/core'
import {
  auditForSubject, auditResolveActors, callsForCompany, companyThread, latestEvidenceChanges, meetingsForCompany,
  notesAuthorLabel, notesFor, proposalsForCompany, scanHistory, schema, type AgencyDb, type AuditRow,
} from '@agency/db/queries'
import { EvidenceDiff } from '@/components/evidence/diff'
import { ScoreHistory } from '@/components/evidence/history'
import { Timeline } from '@/components/evidence/timeline'
import { getDb } from '@/lib/db'
import { completeSince, mergeTimeline, unreachableBetween } from '@/lib/timeline'
import type { CompanySlotProps } from './slot'

/**
 * Score history, the diff between the two latest successful scans, and one
 * timeline of everything that happened to the company (PROMPT.md §2.2).
 * Mounted after the scan table and before the actions.
 *
 * This file only READS. What each panel says is decided in `lib/timeline.ts`,
 * which is pure and tested; the panels in `components/evidence/` are layout.
 *
 * Every source is read newest first up to a limit, because nothing prunes
 * any of these tables. Merged, a source that hit its limit would stop while
 * the others carried on and the gap would read as a quiet month — so the
 * timeline is cut at the point it stops being whole (`completeSince`) and
 * says where the rest is.
 */

/** Scans in the history table and the timeline. `scanHistory` caps at 100. */
const HISTORY_LIMIT = 25
/** Messages, both directions. */
const TOUCH_LIMIT = 60
/** `notesFor` caps at 200. */
const NOTE_LIMIT = 100
/** A company has one open deal at a time; these are its most recent, closed ones included. */
const DEAL_LIMIT = 20
/** Audit rows per deal. */
const DEAL_AUDIT_LIMIT = 100
/** Rows that carry a move inside them (a reply, a booking, an acceptance). */
const EMBEDDED_LIMIT = 200

/**
 * The rows that record a deal move inside their own detail — `contact.replied`
 * and `meeting.booked` carry `deal: '<outcome>:<stage>'`, and accepting a
 * proposal closes the deal as won without a deal row of its own.
 *
 * Their subject is the contact, the meeting or the proposal, never the deal,
 * so `auditForSubject('deal', …)` cannot see them. One query over the three
 * subject sets rather than one `auditForSubject` per contact: the subject
 * index serves both, and a company with forty contacts is one round trip
 * instead of forty. Org-scoped like every audit reader.
 */
async function embeddedMoveRows(
  db: AgencyDb,
  orgId: string,
  ids: { readonly contacts: readonly string[]; readonly meetings: readonly string[]; readonly proposals: readonly string[] },
): Promise<AuditRow[]> {
  const t = schema.auditLog
  const bySubject: SQL[] = []
  const add = (clause: SQL | undefined): void => {
    if (clause) bySubject.push(clause)
  }
  if (ids.contacts.length) {
    add(and(eq(t.subjectType, 'contact'), inArray(t.subjectId, [...ids.contacts]), eq(t.action, 'contact.replied')))
  }
  if (ids.meetings.length) {
    add(and(eq(t.subjectType, 'meeting'), inArray(t.subjectId, [...ids.meetings]), eq(t.action, 'meeting.booked')))
  }
  if (ids.proposals.length) {
    add(and(
      eq(t.subjectType, 'proposal'),
      inArray(t.subjectId, [...ids.proposals]),
      inArray(t.action, ['proposal.accepted', 'proposal.accepted_via_share']),
    ))
  }
  if (bySubject.length === 0) return []
  return db
    .select()
    .from(t)
    .where(and(eq(t.orgId, orgId), or(...bySubject)))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(EMBEDDED_LIMIT)
}

const oldestOf = (dates: readonly Date[]): Date | null =>
  dates.reduce<Date | null>((min, d) => (!min || d.getTime() < min.getTime() ? d : min), null)

export async function EvidencePanelsSlot(props: CompanySlotProps): Promise<React.ReactNode> {
  const db = getDb() as unknown as AgencyDb
  const { orgId, companyId } = props
  const now = new Date()

  const [history, changes, touches, meetings, proposals, calls, notes, deals, contacts, companyRows] = await Promise.all([
    scanHistory(db, orgId, companyId, HISTORY_LIMIT),
    latestEvidenceChanges(db, orgId, companyId),
    companyThread(db, orgId, companyId, TOUCH_LIMIT),
    meetingsForCompany(db, orgId, companyId),
    proposalsForCompany(db, orgId, companyId),
    callsForCompany(db, orgId, companyId),
    notesFor(db, orgId, companyId, NOTE_LIMIT),
    db
      .select({ id: schema.deals.id, createdAt: schema.deals.createdAt })
      .from(schema.deals)
      .where(and(eq(schema.deals.orgId, orgId), eq(schema.deals.companyId, companyId)))
      .orderBy(desc(schema.deals.createdAt))
      .limit(DEAL_LIMIT),
    db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.companyId, companyId))),
    db
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, companyId)))
      .limit(1),
  ])
  const company = companyRows[0] ?? { domain: props.domain, name: null }

  const profileIds = [...new Set(history.flatMap((r) => (r.score ? [r.score.icpProfileId] : [])))]
  const [dealAudit, embedded, profileRows] = await Promise.all([
    Promise.all(deals.map((d) => auditForSubject(db, orgId, 'deal', d.id, DEAL_AUDIT_LIMIT))),
    embeddedMoveRows(db, orgId, {
      contacts: contacts.map((c) => c.id),
      meetings: meetings.map((m) => m.id),
      proposals: proposals.map((p) => p.id),
    }),
    profileIds.length
      ? db
          .select({ id: schema.icpProfiles.id, name: schema.icpProfiles.name })
          .from(schema.icpProfiles)
          .where(and(eq(schema.icpProfiles.orgId, orgId), inArray(schema.icpProfiles.id, profileIds)))
      : Promise.resolve([] as { id: string; name: string }[]),
  ])
  const audit = [...dealAudit.flat(), ...embedded]
  const profiles = new Map(profileRows.map((p) => [p.id, p.name] as const))
  const actors = await auditResolveActors(db, orgId, [
    ...audit.map((r) => r.actor),
    ...touches.flatMap((t) => (t.approvedBy ? [t.approvedBy] : [])),
    ...calls.flatMap((c) => (c.handoffToUserId ? [c.handoffToUserId] : [])),
  ])

  // Where the merged history stops being whole. Notes come back pinned
  // first, so the cut in that list is among the UNPINNED ones.
  const unpinned = notes.filter((n) => !n.pinned)
  const since = completeSince([
    { truncated: history.length >= HISTORY_LIMIT, oldest: oldestOf(history.map((r) => r.scan.ranAt)) },
    { truncated: touches.length >= TOUCH_LIMIT, oldest: oldestOf(touches.map((t) => t.createdAt)) },
    {
      truncated: notes.length >= NOTE_LIMIT,
      oldest: oldestOf((unpinned.length ? unpinned : notes).map((n) => n.createdAt)),
    },
    { truncated: deals.length >= DEAL_LIMIT, oldest: oldestOf(deals.map((d) => d.createdAt)) },
    ...dealAudit.map((rows) => ({ truncated: rows.length >= DEAL_AUDIT_LIMIT, oldest: oldestOf(rows.map((r) => r.createdAt)) })),
    { truncated: embedded.length >= EMBEDDED_LIMIT, oldest: oldestOf(embedded.map((r) => r.createdAt)) },
  ])

  const events = mergeTimeline({
    company,
    now,
    staleAfterDays: props.staleAfterDays,
    scans: history,
    touches,
    audit,
    meetings,
    proposals,
    calls,
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      author: notesAuthorLabel(n),
      contactName: n.contactName,
      pinned: n.pinned,
      createdAt: n.createdAt,
    })),
    actors,
    profiles,
    since,
  })

  // The diff's context, from the same history: whether the scans it skipped
  // are all in view (otherwise the count would be a guess), and whether the
  // most recent scan is one of them.
  const historyOldest = oldestOf(history.map((r) => r.scan.ranAt))
  const historyCovers =
    changes !== null &&
    (history.length < HISTORY_LIMIT || (historyOldest !== null && historyOldest.getTime() <= changes.older.ranAt.getTime()))
  const newest = history[0]

  return (
    <>
      {history.length > 0 ? (
        <>
          <ScoreHistory
            rows={history}
            profiles={profiles}
            staleAfterDays={props.staleAfterDays}
            now={now}
            truncated={history.length >= HISTORY_LIMIT}
          />
          <EvidenceDiff
            changes={changes}
            stale={changes ? isStale(changes.newer.ranAt, props.staleAfterDays, now) : false}
            staleAfterDays={props.staleAfterDays}
            skippedUnreachable={
              changes && historyCovers ? unreachableBetween(history, changes.older.ranAt, changes.newer.ranAt) : null
            }
            latestUnreachable={Boolean(newest && !newest.scan.ok && changes)}
            domain={props.domain}
          />
        </>
      ) : null}
      <Timeline events={events} since={since} />
    </>
  )
}
