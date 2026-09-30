/**
 * Meetings, and the brief for one (PROMPT.md §8.6).
 *
 * A meeting is recorded here whether a person booked it, the agent's
 * `book_meeting` did, or an inbound lead did through the public booking page.
 * Recording one moves the company's deal forward to `meeting` — forward only,
 * so a second meeting with a company already at `proposal` changes nothing.
 *
 * `moveDeal: false` is the exception, and it exists for the one caller that
 * is not trusted: a public booking that recognised a company already on file.
 * The meeting is recorded so the team sees the request; the deal is theirs
 * and a stranger does not get to walk it forward. See booking.ts.
 *
 * The calendar event itself is not here. §8.6 puts the calendar behind the
 * Google Calendar MCP connector, which the agent reaches like any other
 * connector — through the gate, with a person approving — and `external_ref`
 * is where its event id is kept.
 */
import { and, asc, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm'
import {
  DEFAULT_STALE_AFTER_DAYS, isStale, meetingBrief, parseIcpDefinition,
  type Brief, type IcpDefinition,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { activeIcpProfile, latestScanWithFindings } from './repository.js'
import { appendAudit } from './approvals.js'
import { advanceDeal, openDealFor } from './deals.js'
import { companyThread } from './outreach.js'
import { isKnownTimeZone, listContactsForCompany } from './contacts.js'

export type MeetingRow = typeof schema.meetings.$inferSelect

export interface MeetingInput {
  readonly orgId: string
  readonly companyId: string
  readonly contactId?: string | null
  readonly title?: string | null
  readonly startsAt: Date
  readonly endsAt?: Date | null
  readonly timeZone: string
  readonly source: 'manual' | 'agent' | 'booking_page'
  readonly externalRef?: string | null
  readonly notes?: string | null
  readonly createdBy?: string | null
  /** Who or what is recording it, for the audit row. */
  readonly actor: string
  /**
   * An unauthenticated booking matched a contact or company already on file
   * (0015). The meeting is recorded and nothing else about them is touched;
   * a person confirms who booked before acting on it.
   */
  readonly needsReview?: boolean
  /**
   * Whether recording this moves the company's deal forward to `meeting`.
   * Default true — booking a meeting IS the deal reaching that stage.
   *
   * False for a booking that recognised an existing company: the deal is the
   * team's record of a real relationship, and a stranger who can guess an
   * address at that domain must not be able to walk it forward.
   */
  readonly moveDeal?: boolean
  /**
   * The meeting this one replaces, when it is recorded by `rescheduleMeeting`.
   * Written into the `meeting.booked` audit row so the new meeting can name
   * the one it came from — there is no column for it, and the audit log is
   * where the history of a meeting already lives.
   */
  readonly rescheduledFrom?: string | null
}

/**
 * Record a meeting and move the deal.
 *
 * Returns a result rather than throwing on a bad input, because two of the
 * three callers are a web form and the agent, and both want a sentence.
 */
export async function createMeeting(
  db: AgencyDb,
  input: MeetingInput,
): Promise<{ ok: true; meeting: MeetingRow; deal: string } | { ok: false; message: string }> {
  if (!isKnownTimeZone(input.timeZone)) {
    return { ok: false, message: `"${input.timeZone}" is not a timezone this system recognises.` }
  }
  if (input.endsAt && input.endsAt.getTime() <= input.startsAt.getTime()) {
    return { ok: false, message: 'The meeting has to end after it starts.' }
  }
  if (Number.isNaN(input.startsAt.getTime())) {
    return { ok: false, message: 'The start time could not be read.' }
  }

  const company = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, input.orgId), eq(schema.companies.id, input.companyId)))
    .limit(1)
  if (company.length === 0) return { ok: false, message: 'That company is not in the CRM.' }

  if (input.contactId) {
    const contact = await db
      .select({ companyId: schema.contacts.companyId })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, input.orgId), eq(schema.contacts.id, input.contactId)))
      .limit(1)
    if (contact.length === 0) return { ok: false, message: 'That contact is not in the CRM.' }
    if (contact[0]!.companyId !== input.companyId) {
      return { ok: false, message: 'That person is at a different company from the one this meeting is with.' }
    }
  }

  // The deal first, so the meeting row can point at it.
  const moved =
    input.moveDeal === false
      ? null
      : await advanceDeal(db, {
          orgId: input.orgId,
          companyId: input.companyId,
          to: 'meeting',
          nextAction: `Prepare for the meeting on ${input.startsAt.toISOString().slice(0, 10)}`,
        })
  const dealLabel = moved ? `${moved.outcome}:${moved.deal.stage}` : 'not moved'

  const rows = await db
    .insert(schema.meetings)
    .values({
      orgId: input.orgId,
      companyId: input.companyId,
      contactId: input.contactId ?? null,
      dealId: moved?.deal.id ?? null,
      title: input.title?.trim() || null,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      timeZone: input.timeZone,
      source: input.source,
      externalRef: input.externalRef ?? null,
      notes: input.notes?.trim() || null,
      createdBy: input.createdBy ?? null,
      needsReview: input.needsReview ?? false,
    })
    .returning()
  const meeting = rows[0]
  if (!meeting) throw new Error('meeting insert returned no row')

  await appendAudit(db, {
    orgId: input.orgId,
    actor: input.actor,
    action: 'meeting.booked',
    subjectType: 'meeting',
    subjectId: meeting.id,
    detail: {
      companyId: input.companyId,
      contactId: input.contactId ?? null,
      startsAt: input.startsAt.toISOString(),
      timeZone: input.timeZone,
      source: input.source,
      deal: dealLabel,
      needsReview: input.needsReview ?? false,
      ...(input.rescheduledFrom ? { rescheduledFrom: input.rescheduledFrom } : {}),
    },
  }).catch(() => {})

  return { ok: true, meeting, deal: dealLabel }
}

export async function readMeeting(db: AgencyDb, orgId: string, id: string): Promise<MeetingRow | null> {
  const rows = await db
    .select()
    .from(schema.meetings)
    .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.id, id)))
    .limit(1)
  return rows[0] ?? null
}

/** Meetings from now on, soonest first. */
export async function upcomingMeetings(
  db: AgencyDb,
  orgId: string,
  from: Date = new Date(),
  limit = 50,
): Promise<Array<MeetingRow & { companyDomain: string; companyName: string | null }>> {
  const rows = await db
    .select({ meeting: schema.meetings, companyDomain: schema.companies.domain, companyName: schema.companies.name })
    .from(schema.meetings)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.meetings.companyId))
    .where(and(eq(schema.meetings.orgId, orgId), gte(schema.meetings.startsAt, from), isNull(schema.meetings.cancelledAt)))
    .orderBy(asc(schema.meetings.startsAt))
    .limit(limit)
  return rows.map((r) => ({ ...r.meeting, companyDomain: r.companyDomain, companyName: r.companyName }))
}

export async function meetingsForCompany(db: AgencyDb, orgId: string, companyId: string): Promise<MeetingRow[]> {
  return db
    .select()
    .from(schema.meetings)
    .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.companyId, companyId)))
    .orderBy(desc(schema.meetings.startsAt))
}

/**
 * Call a meeting off. Nobody is told — no invitation was sent from here, so
 * there is none to withdraw; a person who sent one from their calendar
 * cancels it there.
 *
 * A meeting whose outcome is recorded cannot be cancelled: "it was held"
 * and "it was called off" are opposite facts, and `outcome IS NULL` in the
 * predicate (with `cancelled_at IS NULL` in `setMeetingOutcome`'s) is what
 * makes the two writers exclude each other in one statement each, rather
 * than by a read that a concurrent click can slip between.
 */
export async function cancelMeeting(db: AgencyDb, orgId: string, id: string, actor: string): Promise<boolean> {
  const rows = await db
    .update(schema.meetings)
    .set({ cancelledAt: new Date() })
    .where(and(
      eq(schema.meetings.orgId, orgId), eq(schema.meetings.id, id),
      isNull(schema.meetings.cancelledAt), isNull(schema.meetings.outcome),
    ))
    .returning({ id: schema.meetings.id })
  if (rows.length === 1) {
    await appendAudit(db, {
      orgId, actor, action: 'meeting.cancelled', subjectType: 'meeting', subjectId: id, detail: {},
    }).catch(() => {})
  }
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// What happened at it (0018's `meetings.outcome`)
// ---------------------------------------------------------------------------

/**
 * What happened, the one fact a pipeline learns from a meeting. NULL means
 * nobody has said yet; cancellation stays `cancelled_at`, because a meeting
 * that was called off did not happen and so has no outcome.
 *
 * None of the three moves the deal. A meeting that was held has already
 * moved it to `meeting`, and where it goes next is a person's call on the
 * board; a no-show is not a lost deal, and writing it as one would be the
 * product stating something nobody decided.
 */
export type MeetingOutcome = 'held' | 'no_show' | 'rescheduled'
export const MEETING_OUTCOMES: readonly MeetingOutcome[] = ['held', 'no_show', 'rescheduled']

export type MeetingOutcomeRefusal = 'not_found' | 'not_yet' | 'cancelled'

const OUTCOME_REFUSALS: Readonly<Record<MeetingOutcomeRefusal | 'already_rescheduled', string>> = {
  not_found: 'No such meeting.',
  not_yet:
    'This meeting has not started yet, so nothing has happened at it to record. ' +
    'To move it before then, cancel it and book the new time from the company page.',
  cancelled: 'This meeting was cancelled, so there is nothing to record about it.',
  already_rescheduled: 'This meeting was already rescheduled — change the new meeting instead.',
}

/**
 * Why the outcome UPDATE matched nothing, named by re-reading the row. The
 * UPDATE decides; this only explains, so a race between the two can make
 * the sentence imprecise but never makes a refused write succeed.
 */
async function outcomeRefusal(
  db: AgencyDb,
  orgId: string,
  id: string,
  now: Date,
): Promise<{ reason: MeetingOutcomeRefusal | 'already_rescheduled'; message: string }> {
  const m = await readMeeting(db, orgId, id)
  const reason: MeetingOutcomeRefusal | 'already_rescheduled' =
    !m ? 'not_found'
      : m.cancelledAt ? 'cancelled'
        : m.startsAt.getTime() > now.getTime() ? 'not_yet'
          : m.outcome === 'rescheduled' ? 'already_rescheduled'
            : 'not_found'
  return { reason, message: OUTCOME_REFUSALS[reason] }
}

/**
 * Record that a meeting was held, or that they did not turn up.
 *
 * One UPDATE decides, with the org, the id, `cancelled_at IS NULL` and
 * `starts_at <= now` in its predicate — a meeting that has not started has
 * no outcome yet, and saying "held" about next Tuesday is a claim about the
 * future. A second call overwrites the first on purpose: a person who
 * clicked "held" and meant "no-show" may correct it, and each write leaves
 * its own audit row, so the correction is visible rather than silent.
 *
 * "Rescheduled" is not written here. It names a new meeting, and an outcome
 * that says "moved" with nowhere it moved to is a claim with no evidence —
 * `rescheduleMeeting` writes it together with the meeting it points at.
 */
export async function setMeetingOutcome(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly id: string
    readonly outcome: Exclude<MeetingOutcome, 'rescheduled'>
    readonly actor: string
    readonly now?: Date
  },
): Promise<{ ok: true; meeting: MeetingRow } | { ok: false; reason: MeetingOutcomeRefusal; message: string }> {
  const now = args.now ?? new Date()
  const rows = await db
    .update(schema.meetings)
    .set({ outcome: args.outcome })
    .where(and(
      eq(schema.meetings.orgId, args.orgId), eq(schema.meetings.id, args.id),
      isNull(schema.meetings.cancelledAt), lte(schema.meetings.startsAt, now),
    ))
    .returning()
  const meeting = rows[0]
  if (!meeting) {
    const why = await outcomeRefusal(db, args.orgId, args.id, now)
    // `already_rescheduled` is not a refusal HERE — this write may correct it.
    // Reaching it means the row changed between the two statements.
    return why.reason === 'already_rescheduled'
      ? { ok: false, reason: 'not_found', message: OUTCOME_REFUSALS.not_found }
      : { ok: false, reason: why.reason, message: why.message }
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'meeting.outcome_recorded',
    subjectType: 'meeting',
    subjectId: meeting.id,
    detail: { outcome: args.outcome, companyId: meeting.companyId },
  }).catch(() => {})
  return { ok: true, meeting }
}

/**
 * The meeting happened at another time: mark this one `rescheduled` and
 * record the new one, in one transaction, so neither exists without the
 * other.
 *
 * The new meeting goes through `createMeeting`, so it passes every check a
 * booking does (a zone the runtime knows, a company and contact in this
 * org). It keeps the contact, title, length, notes and review flag of the
 * one it replaces — a reschedule does not confirm who booked — and not its
 * `external_ref`, which named the old calendar event. It moves the deal only
 * if the original did: a stranger's booking at a company already on file
 * never moved it, and a teammate moving the time is not the team deciding
 * that booking was genuine.
 *
 * The audit row on the OLD meeting names the new one (`rescheduledTo`), and
 * the new meeting's `meeting.booked` row names the old (`rescheduledFrom`),
 * which is how each page links to the other; there is no column for it.
 * Like the other outcomes it needs the meeting to have started; a meeting
 * that has not is moved by cancelling it and booking again. Rescheduling
 * the same meeting twice is refused, since the first new meeting would be
 * left on the books with nothing pointing at it.
 */
export async function rescheduleMeeting(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly id: string
    /** The new start, as an instant — the caller applies the zone. */
    readonly startsAt: Date
    readonly timeZone: string
    readonly actor: string
    readonly createdBy?: string | null
    readonly now?: Date
  },
): Promise<
  | { ok: true; meeting: MeetingRow; replacement: MeetingRow; deal: string }
  | { ok: false; reason: MeetingOutcomeRefusal | 'already_rescheduled' | 'invalid'; message: string }
> {
  const now = args.now ?? new Date()
  if (Number.isNaN(args.startsAt.getTime())) {
    return { ok: false, reason: 'invalid', message: 'The new time could not be read.' }
  }
  if (!isKnownTimeZone(args.timeZone)) {
    return { ok: false, reason: 'invalid', message: `"${args.timeZone}" is not a timezone this system recognises.` }
  }

  try {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as AgencyDb
      const rows = await txDb
        .update(schema.meetings)
        .set({ outcome: 'rescheduled' })
        .where(and(
          eq(schema.meetings.orgId, args.orgId), eq(schema.meetings.id, args.id),
          isNull(schema.meetings.cancelledAt), lte(schema.meetings.startsAt, now),
          or(isNull(schema.meetings.outcome), ne(schema.meetings.outcome, 'rescheduled')),
        ))
        .returning()
      const old = rows[0]
      if (!old) throw new RescheduleRefused(await outcomeRefusal(txDb, args.orgId, args.id, now))

      const created = await createMeeting(txDb, {
        orgId: args.orgId,
        companyId: old.companyId,
        contactId: old.contactId,
        title: old.title,
        startsAt: args.startsAt,
        endsAt: old.endsAt ? new Date(args.startsAt.getTime() + (old.endsAt.getTime() - old.startsAt.getTime())) : null,
        timeZone: args.timeZone,
        source: 'manual',
        notes: old.notes,
        createdBy: args.createdBy ?? null,
        actor: args.actor,
        needsReview: old.needsReview,
        moveDeal: old.dealId !== null,
        rescheduledFrom: old.id,
      })
      if (!created.ok) throw new RescheduleRefused({ reason: 'invalid', message: created.message })

      // Not `.catch`-ed: this row IS the link from the old meeting to the new
      // one, and a reschedule whose link failed to write should not happen.
      await appendAudit(txDb, {
        orgId: args.orgId,
        actor: args.actor,
        action: 'meeting.outcome_recorded',
        subjectType: 'meeting',
        subjectId: old.id,
        detail: {
          outcome: 'rescheduled',
          companyId: old.companyId,
          rescheduledTo: created.meeting.id,
          startsAt: args.startsAt.toISOString(),
          timeZone: args.timeZone,
        },
      })
      return { ok: true as const, meeting: old, replacement: created.meeting, deal: created.deal }
    })
  } catch (err) {
    if (err instanceof RescheduleRefused) return { ok: false, ...err.refusal }
    throw err
  }
}

/** Carries a refusal out through the transaction rollback. */
class RescheduleRefused extends Error {
  constructor(readonly refusal: { reason: MeetingOutcomeRefusal | 'already_rescheduled' | 'invalid'; message: string }) {
    super(refusal.message)
  }
}

/** One end of a reschedule, as the page links to it. */
export interface MeetingLink {
  readonly id: string
  readonly startsAt: Date
  readonly timeZone: string
}

/**
 * The meeting this one was rescheduled to, and the one it was rescheduled
 * from, read from the audit rows `rescheduleMeeting` writes. Both lookups
 * go by `subject_id` (indexed) and join back to `meetings` in the same org,
 * so an id in a row's detail that names nothing here is not linked to.
 */
export async function meetingRescheduleLinks(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<{ to: MeetingLink | null; from: MeetingLink | null }> {
  const a = schema.auditLog
  const m = schema.meetings
  const link = { id: m.id, startsAt: m.startsAt, timeZone: m.timeZone }
  const [to, from] = await Promise.all([
    db
      .select(link)
      .from(a)
      .innerJoin(m, and(eq(m.orgId, a.orgId), sql`${m.id}::text = ${a.detail}->>'rescheduledTo'`))
      .where(and(
        eq(a.orgId, orgId), eq(a.subjectType, 'meeting'), eq(a.subjectId, id),
        eq(a.action, 'meeting.outcome_recorded'), sql`${a.detail}->>'outcome' = 'rescheduled'`,
      ))
      .orderBy(desc(a.createdAt))
      .limit(1),
    db
      .select(link)
      .from(a)
      .innerJoin(m, and(eq(m.orgId, a.orgId), sql`${m.id}::text = ${a.detail}->>'rescheduledFrom'`))
      .where(and(
        eq(a.orgId, orgId), eq(a.subjectType, 'meeting'), eq(a.subjectId, id), eq(a.action, 'meeting.booked'),
      ))
      .limit(1),
  ])
  return { to: to[0] ?? null, from: from[0] ?? null }
}

/**
 * A meeting and the company it is with — what the `.ics` download needs and
 * nothing else. The contact is deliberately not resolved: the file leaves
 * for a laptop and a phone, and it names nobody.
 */
export async function readMeetingWithCompany(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<{ meeting: MeetingRow; company: { domain: string; name: string | null } } | null> {
  const rows = await db
    .select({ meeting: schema.meetings, domain: schema.companies.domain, name: schema.companies.name })
    .from(schema.meetings)
    .innerJoin(
      schema.companies,
      and(eq(schema.companies.id, schema.meetings.companyId), eq(schema.companies.orgId, schema.meetings.orgId)),
    )
    .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.id, id)))
    .limit(1)
  const row = rows[0]
  return row ? { meeting: row.meeting, company: { domain: row.domain, name: row.name } } : null
}

/**
 * Everything the brief needs, gathered, then the pure generator.
 *
 * Freshness is decided HERE from the scan's `ran_at`, the way every other
 * reader of findings does it (CLAUDE.md §1: `findings.stale` is a cache, not
 * the answer). The brief is then told, and says so on the page rather than
 * quoting aged-out findings (§2.2).
 */
export async function briefForMeeting(
  db: AgencyDb,
  orgId: string,
  meetingId: string,
  now: Date = new Date(),
): Promise<{ meeting: MeetingRow; company: { domain: string; name: string | null }; brief: Brief } | null> {
  const meeting = await readMeeting(db, orgId, meetingId)
  if (!meeting) return null

  const companyRows = await db
    .select({ domain: schema.companies.domain, name: schema.companies.name, country: schema.companies.country })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, meeting.companyId)))
    .limit(1)
  const company = companyRows[0]
  if (!company) return null

  const icpRow = await activeIcpProfile(db, orgId)
  let icp: IcpDefinition | null = null
  try {
    icp = icpRow ? parseIcpDefinition(icpRow.definition) : null
  } catch {
    icp = null
  }
  const staleAfter = icp?.freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS

  const [contacts, deal, found, thread] = await Promise.all([
    listContactsForCompany(db, orgId, meeting.companyId),
    openDealFor(db, orgId, meeting.companyId),
    latestScanWithFindings(db, orgId, meeting.companyId),
    companyThread(db, orgId, meeting.companyId, 20),
  ])

  const brief = meetingBrief({
    meeting: { startsAt: meeting.startsAt, timeZone: meeting.timeZone, title: meeting.title },
    company,
    contacts: contacts.map((c) => ({
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'unnamed',
      title: c.title,
      email: c.email,
    })),
    deal: deal ? { stage: deal.stage, nextAction: deal.nextAction, valueCents: deal.valueCents } : null,
    signals: icp?.signals ?? {},
    findings: (found?.findings ?? []).map((f) => ({
      signalKey: f.signalKey, observed: f.observed, gap: f.gap, weight: f.weight, detail: f.detail,
    })),
    scan: found ? { ranAt: found.scan.ranAt, ok: found.scan.ok, stale: isStale(found.scan.ranAt, staleAfter, now) } : null,
    score: found?.score ? { score: found.score.score, tier: found.score.tier } : null,
    thread: thread.map((t) => ({
      direction: t.direction as 'in' | 'out',
      status: t.status,
      subject: t.subject,
      body: t.body,
      at: t.sentAt ?? t.createdAt,
    })),
  })

  return { meeting, company: { domain: company.domain, name: company.name }, brief }
}
