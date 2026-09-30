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
import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm'
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

export async function cancelMeeting(db: AgencyDb, orgId: string, id: string, actor: string): Promise<boolean> {
  const rows = await db
    .update(schema.meetings)
    .set({ cancelledAt: new Date() })
    .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.id, id), isNull(schema.meetings.cancelledAt)))
    .returning({ id: schema.meetings.id })
  if (rows.length === 1) {
    await appendAudit(db, {
      orgId, actor, action: 'meeting.cancelled', subjectType: 'meeting', subjectId: id, detail: {},
    }).catch(() => {})
  }
  return rows.length === 1
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
      signalKey: f.signalKey, observed: f.observed, gap: f.gap, weight: f.weight, detail: f.detail, scored: f.scored,
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
