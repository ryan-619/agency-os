/**
 * The reporting tools: the pipeline's numbers, a company's timeline, the
 * compliance page's counts, and text search across the CRM.
 *
 * All four are READS (`low`). Each reads the same rows the corresponding page
 * reads and nothing else — a number a tool reports that the page does not
 * would be a second opinion. `orgId` comes from the context, never from an
 * argument (spec.ts).
 *
 * Three rules shape what reaches the model's context, because a read is never
 * put in front of a person to approve and so the handler is the only guard:
 *
 *  - **A figure travels with its denominator.** `pipelineMetrics` returns
 *    `null` below its minimum sample and the tool prints "insufficient data",
 *    never a ratio of two. §2.2's rule applied to arithmetic.
 *  - **A note is somebody's words, not evidence.** The timeline prints every
 *    note as "note by <name>:" in quotation marks and says so in the summary,
 *    so "they have no CSP" typed after a call cannot be repeated as a finding.
 *  - **Message bodies stay out.** A timeline line carries a message's subject
 *    and its FIRST LINE only, bounded — and for a LinkedIn message /tasks
 *    would not show, neither (`linkedinThreadWithheld`, /tasks' own rule);
 *    the compliance summary is counts with no rows at all; search returns
 *    the label and one line of context the search module already chose, and
 *    that module cannot name a connector or a chat (§2.3).
 *
 * Each tool asks `can()` the same question the page behind it asks, so a role
 * that could not open the page cannot read it through the agent either.
 */
import { z } from 'zod'
import { can, pipelineMetrics, staleAfterDaysOf, type PipelineMetrics } from '@agency/core'
import {
  activeIcpProfile, analyticsTransitions, auditForSubject, callsForCompany, companyThread,
  complianceSummary, findCompanyByDomain, linkedinThreadWithheld, listDeals, meetingsForCompany, notesAuthorLabel,
  notesFor, proposalsForCompany, scanHistory, searchOrg, searchQueryFrom, searchSectionsFor, tasksList,
  type AgencyDb, type AuditRow, type LinkedinThreadWithheld, type SearchSections,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { normaliseDomain } from '@agency/scanner'
import { and, eq, inArray } from 'drizzle-orm'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

const DAY_MS = 86_400_000

/** "2026-09-15 12:00 UTC": a moment a person can read, in the one zone the org has. */
function when(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * A meeting's time as its own zone tells it, with the instant in UTC beside
 * it. A meeting is a wall-clock commitment somewhere; printing the UTC time
 * next to the zone's NAME is how a 15:00 London call once read as 14:00.
 */
function inZone(d: Date, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d)
    const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '??'
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${zone} (${when(d)})`
  } catch {
    return when(d)
  }
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Whitespace collapsed and cut to `max` characters (code points), marked when cut. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

/**
 * The first line of a text that has words on it, bounded — and nothing after
 * it. A message body or a note can hold a whole thread; the timeline is a
 * list of what happened, not the record.
 */
function firstLineOf(text: string | null | undefined, max = 160): string | null {
  const lines = (text ?? '').split(/\r\n|\r|\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return null
  const cut = oneLine(lines[0]!, max)
  // A marker when there was more, so a reader knows this is not the whole of it.
  return lines.length > 1 && !cut.endsWith('…') ? `${cut} …` : cut
}

/**
 * The ICP's freshness window, the way the compliance page reads it: through
 * `staleAfterDaysOf`, which `readIcp` delegates to. The raw value made this
 * tool throw on a `0` that the page answered at the default.
 */
async function staleDaysFor(db: AgencyDb, orgId: string): Promise<number> {
  return staleAfterDaysOf((await activeIcpProfile(db, orgId))?.definition)
}

// ---------------------------------------------------------------------------
// get_pipeline_metrics
// ---------------------------------------------------------------------------

const pipelineMetricsShape = {
  sinceDays: z.number().int().min(7).max(365).optional().describe('The window, in days. Default 90.'),
}

/** A rate as the page prints it, or the page's words for "not enough to say". */
function rateWords(rate: number | null, part: number, whole: number, floor: number, of: string): string {
  return rate === null
    ? `${part} of ${whole} ${of} — insufficient data (< ${floor})`
    : `${Math.round(rate * 100)}% (${part} of ${whole} ${of})`
}

function metricsLines(m: PipelineMetrics, days: number, since: Date, moves: number, skipped: number): string[] {
  const floor = m.minSample
  const lines: string[] = [
    `Pipeline metrics over the last ${days} days (moves recorded since ${day(since)}; deals open now or ` +
      `closed since then), as of ${when(m.asOf)}. Below ${floor} a figure is not a figure.`,
    `Win rate: ${rateWords(m.winRate.rate, m.winRate.won, m.winRate.closed, floor, 'closed deals won')}.`,
    `Median days from a deal's creation to won: ${
      m.velocityDays === null ? `insufficient data (< ${floor}; ${m.velocitySample} won)` : `${m.velocityDays} over ${m.velocitySample} won`
    }.`,
    `Deals by stage now: ${m.perStage.map((s) => `${s.stage} ${s.open} open${s.total !== s.open ? ` / ${s.total} all` : ''}`).join(', ')}.`,
    'Conversion (of the deals known to have entered a stage, how many are known to have gone further):',
    ...m.conversion.map((c) => `  ${c.from} → ${c.to} or further: ${rateWords(c.rate, c.advanced, c.entered, floor, 'went on')}`),
    'Median time in stage (only stays whose arrival and departure were both recorded):',
    ...m.medianDaysInStage.map((s) =>
      `  ${s.stage}: ${s.days === null ? `insufficient data (< ${floor}; ${s.sample} measured)` : `${s.days} days over ${s.sample} stays`}`,
    ),
    `Read from ${moves} recorded move${moves === 1 ? '' : 's'}${
      skipped > 0 ? `; ${skipped} audit row${skipped === 1 ? '' : 's'} named as a move could not be read as one and ${skipped === 1 ? 'is' : 'are'} not counted` : ''
    }.`,
    m.note,
  ]
  return lines
}

export const getPipelineMetrics: AgencyToolSpec<typeof pipelineMetricsShape> = {
  name: 'get_pipeline_metrics',
  description:
    'Read the pipeline’s own numbers over a window: how many deals reached each stage, conversion ' +
    'between stages, time spent in each, and the win rate — computed from the audit log’s record of ' +
    'every stage move, not from a counter. A read; nothing is sent.',
  shape: pipelineMetricsShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:read')) {
      return fail('not_permitted', 'The person you are helping cannot read the pipeline.')
    }
    const days = input.sinceDays ?? 90
    const now = ctx.now()
    const since = new Date(now.getTime() - days * DAY_MS)

    const [all, moves] = await Promise.all([
      listDeals(ctx.db, ctx.orgId),
      analyticsTransitions(ctx.db, ctx.orgId, { sinceDays: days, now }),
    ])
    // The window applies to the table as well as to the moves: a deal that
    // closed a year ago is not part of this quarter's win rate. A deal still
    // open is live inside any window that ends now, so it always counts.
    const deals = all.filter((d) => d.closedAt === null || d.closedAt.getTime() >= since.getTime())
    const m = pipelineMetrics(deals, moves, now)

    await ctx.audit('agent.get_pipeline_metrics', { sinceDays: days, deals: deals.length, moves: moves.length })
    return ok(
      {
        sinceDays: days,
        since: since.toISOString(),
        asOf: m.asOf.toISOString(),
        minSample: m.minSample,
        deals: deals.length,
        movesRead: moves.length,
        movesUnreadable: moves.skipped,
        perStage: m.perStage,
        conversion: m.conversion,
        medianDaysInStage: m.medianDaysInStage,
        winRate: m.winRate,
        velocityDays: m.velocityDays,
        velocitySample: m.velocitySample,
        note: m.note,
      },
      bounded(metricsLines(m, days, since, moves.length, moves.skipped)),
    )
  },
}

// ---------------------------------------------------------------------------
// get_company_timeline
// ---------------------------------------------------------------------------

const companyTimelineShape = {
  domain: z.string().min(1).max(253).describe('The company.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many events, newest first. Default 25.'),
}

type TimelineKind = 'message' | 'scan' | 'deal' | 'meeting' | 'proposal' | 'call' | 'note' | 'task'

interface TimelineEvent {
  readonly at: Date
  readonly kind: TimelineKind
  /** The row the event came from — a touch, scan, audit row, meeting, proposal, call, note or task. */
  readonly id: string
  readonly text: string
}

/** Newest first; one instant is broken by kind, then id, so the same rows give the same list. */
function byNewest(a: TimelineEvent, b: TimelineEvent): number {
  return (
    b.at.getTime() - a.at.getTime() ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

const LITERAL_ACTORS: Readonly<Record<string, string>> = {
  agent: 'the agent',
  voice: 'the phone line',
  booking_page: 'the booking page',
  share_link: 'a shared link',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Teammates named by an audit row's actor, resolved inside the org only. */
async function actorNames(ctx: ToolContext, rows: readonly AuditRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.actor).filter((a) => UUID.test(a)))]
  if (ids.length === 0) return new Map()
  const users = await ctx.db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, ctx.orgId), inArray(schema.users.id, ids)))
  return new Map(users.map((u) => [u.id, notesAuthorLabel({ authorName: u.name, authorEmail: u.email })]))
}

/** " by Priya", ", automatically" — appended straight onto the line. */
function byActor(actor: string, names: ReadonlyMap<string, string>): string {
  if (actor === 'system') return ', automatically'
  if (Object.prototype.hasOwnProperty.call(LITERAL_ACTORS, actor)) return ` by ${LITERAL_ACTORS[actor]}`
  if (UUID.test(actor)) return ` by ${names.get(actor) ?? 'a former teammate'}`
  return ` by ${actor}`
}

/** A deal's audit row as one line. Only the stages are read out of `detail`; a lost reason or a next action is somebody's words. */
function dealLine(row: AuditRow, names: ReadonlyMap<string, string>): string {
  const d = (typeof row.detail === 'object' && row.detail !== null && !Array.isArray(row.detail)
    ? row.detail
    : {}) as { from?: unknown; to?: unknown }
  const from = typeof d.from === 'string' ? d.from : null
  const to = typeof d.to === 'string' ? d.to : null
  const who = byActor(row.actor, names)
  if (to && from && from !== to) return `deal moved from ${from} to ${to}${who}`
  if (to && row.action === 'deal.created') return `deal opened at ${to}${who}`
  return `deal ${row.action.replace(/^deal\./, '').replace(/_/g, ' ')}${who}`
}

/**
 * Why a LinkedIn message's words are not in the timeline, in the company
 * page's words for the same reasons. The rule is /tasks' own
 * (`linkedinThreadWithheld`); this only words it.
 */
const LINKEDIN_HELD: Record<LinkedinThreadWithheld, string> = {
  not_handed: 'Start has not handed them over',
  refused: 'the send rules now refuse this person',
  paused: 'the contact is paused',
  unchecked: 'the rules cannot be checked — the contact or the campaign is gone',
  expired: 'they were handed over more than a day ago',
}

export const getCompanyTimeline: AgencyToolSpec<typeof companyTimelineShape> = {
  name: 'get_company_timeline',
  description:
    'Read everything that happened to one company, newest first: scans, messages in both directions, ' +
    'replies, deal moves, meetings, proposals, notes and tasks — from the records that hold each, ' +
    'never from a summary somebody wrote. A read; nothing is sent.',
  shape: companyTimelineShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The search sections are the read capabilities per kind of record, so
    // the timeline shows a role exactly what its pages would.
    const may = searchSectionsFor(ctx.principal)
    if (!may?.companies) return fail('not_permitted', 'The person you are helping cannot read companies.')

    const domain = normaliseDomain(input.domain)
    if (!domain) return fail('not_found', `"${input.domain}" is not a domain.`)
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)
    const limit = input.limit ?? 25

    // A section the role may not read is not queried at all.
    const none = async (): Promise<never[]> => []
    const [touches, scans, deals, meetings, proposals, calls, notes, tasks] = await Promise.all([
      may.touches ? companyThread(ctx.db, ctx.orgId, company.id, limit) : none(),
      scanHistory(ctx.db, ctx.orgId, company.id, limit),
      may.deals
        ? ctx.db
            .select({ id: schema.deals.id, stage: schema.deals.stage, closedAt: schema.deals.closedAt })
            .from(schema.deals)
            .where(and(eq(schema.deals.orgId, ctx.orgId), eq(schema.deals.companyId, company.id)))
        : none(),
      may.meetings ? meetingsForCompany(ctx.db, ctx.orgId, company.id) : none(),
      may.proposals ? proposalsForCompany(ctx.db, ctx.orgId, company.id) : none(),
      may.contacts ? callsForCompany(ctx.db, ctx.orgId, company.id) : none(),
      notesFor(ctx.db, ctx.orgId, company.id, limit),
      may.deals ? tasksList(ctx.db, ctx.orgId, { companyId: company.id, limit }) : none(),
    ])
    const dealRows = (await Promise.all(deals.map((d) => auditForSubject(ctx.db, ctx.orgId, 'deal', d.id, limit)))).flat()
    const names = await actorNames(ctx, dealRows)
    // A LinkedIn message's words reach the model only where /tasks would
    // print them (review round 5, [10]): never before Start hands them over,
    // and not while the step is open and its re-check withholds them. A
    // person could otherwise copy them into LinkedIn from a chat, past every
    // rule Start runs — to somebody suppressed on LinkedIn since, say.
    const withheld = await linkedinThreadWithheld(ctx.db, ctx.orgId, touches, ctx.now())

    const events: TimelineEvent[] = []
    for (const t of touches) {
      const held = withheld.get(t.id)
      if (held) {
        const status = t.status === 'refused' && t.refusalCode ? `refused by the send path (${t.refusalCode})` : t.status
        events.push({
          at: t.sentAt ?? t.createdAt,
          kind: 'message',
          id: t.id,
          text: `${t.channel} message out, ${status} — words withheld (${LINKEDIN_HELD[held]})`,
        })
        continue
      }
      const subject = t.subject ? ` “${oneLine(t.subject, 120)}”` : ''
      const first = firstLineOf(t.body)
      const opening = first ? ` — first line: “${first}”` : ''
      if (t.direction === 'in') {
        const kind = t.replyKind ? ` (${t.replyKind})` : ' (not classified)'
        const handled = t.handledAt ? ', handled' : ''
        events.push({ at: t.createdAt, kind: 'message', id: t.id, text: `reply received by ${t.channel}${kind}${handled}${subject}${opening}` })
      } else {
        const status = t.status === 'refused' && t.refusalCode ? `refused by the send path (${t.refusalCode})` : t.status
        events.push({ at: t.sentAt ?? t.createdAt, kind: 'message', id: t.id, text: `${t.channel} message out, ${status}${subject}${opening}` })
      }
    }
    for (const s of scans) {
      const text = !s.scan.ok
        ? `scan: unreachable${s.scan.error ? ` (${oneLine(s.scan.error, 80)})` : ''} — nothing was observed, so there is no score`
        : s.score
          ? `scan reached the site — score ${s.score.score}/100${s.score.tier ? `, tier ${s.score.tier}` : ''}, ${
              s.score.qualified ? 'qualified' : `not qualified${s.score.disqualifiedReason ? ` (${oneLine(s.score.disqualifiedReason, 80)})` : ''}`
            }`
          : 'scan reached the site — no score recorded for it'
      events.push({ at: s.scan.ranAt, kind: 'scan', id: s.scan.id, text })
    }
    for (const row of dealRows) events.push({ at: row.createdAt, kind: 'deal', id: row.id, text: dealLine(row, names) })
    for (const m of meetings) {
      const state = m.cancelledAt ? 'cancelled' : m.outcome ? m.outcome.replace(/_/g, ' ') : m.startsAt.getTime() > ctx.now().getTime() ? 'upcoming' : 'no outcome recorded'
      const title = m.title ? ` “${oneLine(m.title, 120)}”` : ''
      events.push({ at: m.createdAt, kind: 'meeting', id: m.id, text: `meeting${title} booked for ${inZone(m.startsAt, m.timeZone)} — ${state}` })
    }
    for (const p of proposals) {
      const range = p.totalLow !== null && p.totalHigh !== null ? `, ${p.currency} ${p.totalLow.toLocaleString('en-US')}–${p.totalHigh.toLocaleString('en-US')}` : ''
      events.push({ at: p.generatedAt, kind: 'proposal', id: p.id, text: `proposal “${oneLine(p.title, 120)}” generated from a scan${range} — now ${p.status}` })
      if (p.decidedAt) events.push({ at: p.decidedAt, kind: 'proposal', id: `${p.id}:decided`, text: `proposal “${oneLine(p.title, 120)}” ${p.status}` })
    }
    for (const c of calls) {
      const length = c.durationS !== null ? `, ${Math.floor(c.durationS / 60)}m ${c.durationS % 60}s` : ''
      const disclosed = c.answeredAt ? (c.disclosedAiAt ? ', disclosed the AI' : ', did NOT disclose the AI') : ''
      events.push({
        at: c.startedAt ?? c.createdAt,
        kind: 'call',
        id: c.id,
        text: `${c.direction === 'in' ? 'inbound' : 'outbound'} call, ${c.status}${c.outcome ? `, outcome ${c.outcome.replace(/_/g, ' ')}` : ''}${length}${disclosed}`,
      })
    }
    for (const n of notes) {
      const about = n.contactName ? ` about ${n.contactName}` : ''
      events.push({ at: n.createdAt, kind: 'note', id: n.id, text: `note by ${notesAuthorLabel(n)}${about}: “${firstLineOf(n.body, 200) ?? ''}”` })
    }
    for (const t of tasks) {
      const who = t.assigneeUserId ? `assigned to ${t.assigneeName?.trim() || t.assigneeEmail || 'a former teammate'}` : 'unassigned'
      const due = t.dueAt ? `, due ${when(t.dueAt)}` : ''
      const done = t.doneAt ? `, done ${when(t.doneAt)}` : ', open'
      events.push({ at: t.createdAt, kind: 'task', id: t.id, text: `task “${oneLine(t.title, 120)}” — ${who}${due}${done}` })
    }

    events.sort(byNewest)
    const shown = events.slice(0, limit)
    const open = deals.find((d) => d.closedAt === null)
    const dealNow = !may.deals
      ? null
      : open
        ? `Deal now: open at ${open.stage}.`
        : deals.length > 0
          ? `Deal now: closed (${deals.map((d) => d.stage).join(', ')}).`
          : 'Deal now: none — nobody has opened one.'

    await ctx.audit('agent.get_company_timeline', { companyId: company.id, returned: shown.length })
    const header = `${domain}: ${shown.length} of ${events.length} event${events.length === 1 ? '' : 's'}, newest first.`
    const footer =
      'Notes are a teammate’s words, not evidence — never repeat one as something the scanner found. ' +
      'Messages show the subject and the first line only.' +
      (shown.some((e) => withheld.has(e.id))
        ? ' A LinkedIn message’s words are shown only where /tasks would show them — Start checks every send rule first.'
        : '')
    return ok(
      {
        domain,
        companyId: company.id,
        deal: open ? { stage: open.stage, open: true } : null,
        events: shown.map((e) => ({ at: e.at.toISOString(), kind: e.kind, id: e.id, text: e.text })),
        omitted: events.length - shown.length,
      },
      shown.length === 0
        ? `${domain}: nothing has happened to this company yet — no scan, message, meeting, note or task. ${dealNow ?? ''}`.trim()
        : [header, ...(dealNow ? [dealNow] : []), bounded(shown.map((e) => `${when(e.at)}  ${e.kind.padEnd(8)} ${e.text}`), 7_000), footer].join('\n'),
    )
  },
}

// ---------------------------------------------------------------------------
// get_compliance_summary
// ---------------------------------------------------------------------------

export const getComplianceSummary: AgencyToolSpec<Record<string, never>> = {
  name: 'get_compliance_summary',
  description:
    'Read the counts the compliance page shows: consent rows per channel, suppressions by source, ' +
    'refusals by rule, calls that did and did not disclose the AI, and how much evidence is stale. ' +
    'The same rows the page reads, so the two cannot disagree. A read; nothing is sent.',
  shape: {},
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    // The page's own gate.
    if (!can(ctx.principal, 'audit:read')) {
      return fail('not_permitted', 'The person you are helping cannot read the compliance counts.')
    }
    const staleDays = await staleDaysFor(ctx.db, ctx.orgId)
    const s = await complianceSummary(ctx.db, ctx.orgId, { staleDays, now: ctx.now() })

    // Counts only. Every block of the summary also carries rows — domains,
    // ids, dates — for the page to link; none of them is passed on.
    const counts = {
      generatedAt: s.generatedAt.toISOString(),
      windowDays: s.windowDays,
      since: s.since.toISOString(),
      disclosure: {
        calls: s.disclosure.calls,
        answeredInbound: s.disclosure.answeredInbound,
        undisclosed: s.disclosure.undisclosed.length,
      },
      optOutsWithoutSuppression: {
        total: s.optOuts.withoutSuppression.count,
        replies: s.optOuts.withoutSuppression.replies,
        calls: s.optOuts.withoutSuppression.calls,
      },
      optOutsNotRecorded: { lastWindow: s.optOuts.notRecorded.lastWindow.count, allTime: s.optOuts.notRecorded.allTime },
      coldWithoutOptIn: {
        contacts: s.coldOptIn.contacts,
        touches: s.coldOptIn.touches,
        stoppedBySendPath: s.coldOptIn.stoppedBySendPath,
      },
      draftsOnStaleEvidence: {
        count: s.draftsOnStaleEvidence.count,
        byStatus: s.draftsOnStaleEvidence.byStatus,
        byWhy: s.draftsOnStaleEvidence.byWhy,
        refusedAtSending: s.draftsOnStaleEvidence.refusedAtSending,
        notJudgedAtSending: s.draftsOnStaleEvidence.notJudgedAtSending,
        notJudgedNoFurtherLook: s.draftsOnStaleEvidence.notJudgedNoFurtherLook,
        awaiting: s.draftsOnStaleEvidence.awaiting,
        unsent: s.draftsOnStaleEvidence.unsent,
      },
      consents: s.consents,
      suppressions: {
        lastWindow: s.suppressions.lastWindow,
        allTime: s.suppressions.allTime,
      },
      refusals: {
        total: s.refusals.total,
        humanCanResolve: s.refusals.humanCanResolve,
        noOneCanOverride: s.refusals.noOneCanOverride,
        unknownCode: s.refusals.unknownCode,
        byCode: s.refusals.byCode,
      },
      freshness: {
        staleDays: s.freshness.staleDays,
        companies: s.freshness.total,
        fresh: s.freshness.fresh,
        stale: s.freshness.stale,
        unreachable: s.freshness.unreachable,
        neverScanned: s.freshness.neverScanned,
        staleColumnSaysFresh: s.freshness.staleColumnSaysFresh,
      },
      lateApprovals: s.lateApprovals.count,
      autoSendOffCold: s.autoSendOffCold.count,
    }

    const d = counts.draftsOnStaleEvidence
    const w = `the last ${s.windowDays} days`
    const tally = (xs: readonly { readonly granted: number; readonly refused: number }[], label: (i: number) => string) =>
      xs.map((x, i) => `${label(i)} ${x.granted} granted / ${x.refused} refused`).join(', ')
    const sources = (xs: readonly { readonly source: string; readonly n: number }[]) =>
      xs.filter((x) => x.n > 0).map((x) => `${x.source} ${x.n}`).join(', ') || 'none'
    const lines = [
      `Compliance counts as of ${when(s.generatedAt)}; "${w}" means since ${day(s.since)}. Counts only — the ` +
        'compliance page lists the rows behind each.',
      `AI disclosure: ${counts.disclosure.undisclosed} of ${counts.disclosure.answeredInbound} answered inbound ` +
        `call${counts.disclosure.answeredInbound === 1 ? '' : 's'} did not disclose (must be 0); ${counts.disclosure.calls} calls on record.`,
      `Opt-outs the send path would not stop (no matching suppression row): ${counts.optOutsWithoutSuppression.total} ` +
        `(${counts.optOutsWithoutSuppression.replies} replies, ${counts.optOutsWithoutSuppression.calls} calls) — must be 0.`,
      `Opt-outs that failed to store: ${counts.optOutsNotRecorded.lastWindow} in ${w}, ${counts.optOutsNotRecorded.allTime} all time.`,
      `Messages that went out on an opt-in-only channel with no opt-in: ${counts.coldWithoutOptIn.touches} to ` +
        `${counts.coldWithoutOptIn.contacts} contacts (must be 0); ${counts.coldWithoutOptIn.stoppedBySendPath} stopped by the send path.`,
      // The send path refuses a message whose words were written from a stale
      // scan (`stale_evidence`), whoever approved it; saying these "go with no
      // further look" told the model the opposite of what the sender does.
      // It refuses one written from a fresh scan a newer one has superseded
      // too (r4), and those are said apart: "a scan that is stale now" would
      // be false about them. Every superseded row is refused at sending.
      `Outbound messages not yet sent on stale or missing evidence: ${d.count} of ${d.unsent} not yet sent ` +
        `(must be 0) — ${d.byStatus.awaiting_approval} awaiting approval, ${d.byStatus.approved} approved, ` +
        `${d.byStatus.queued} queued, ${d.byStatus.sending} sending. ${d.refusedAtSending - d.byWhy.superseded} were written from a scan ` +
        'that is stale now and are refused at sending (stale_evidence) — waiting to be refused, or to be re-drafted ' +
        `after a re-scan; ${d.byWhy.superseded} were written from a scan a newer successful scan has superseded, ` +
        'and are refused at sending too (stale_evidence) — waiting to be refused, or to be re-drafted from the latest ' +
        `scan; ${d.notJudgedAtSending} have no successful scan behind them or answer a reply, so the send ` +
        `path does not judge them by evidence and they go as written unless another rule stops them — ` +
        `${d.notJudgedNoFurtherLook} of those with nobody looking again (approved, queued or sending).`,
      `Consent rows: ${tally(s.consents.byChannel, (i) => s.consents.byChannel[i]!.channel)}; ` +
        `${s.consents.total.granted} granted and ${s.consents.total.refused} refused in all.`,
      `Suppressions: ${s.suppressions.lastWindow.total} added in ${w} (${sources(s.suppressions.lastWindow.bySource)}); ` +
        `${s.suppressions.allTime.total} all time (${sources(s.suppressions.allTime.bySource)}).`,
      `Refusals in ${w}: ${s.refusals.total}${
        s.refusals.byCode.length > 0 ? ` — ${s.refusals.byCode.map((r) => `${r.code} ${r.n}`).join(', ')}` : ''
      }; ${s.refusals.humanCanResolve} a person could resolve, ${s.refusals.noOneCanOverride} nobody may approve past` +
        `${s.refusals.unknownCode > 0 ? `, ${s.refusals.unknownCode} with a code this revision does not know` : ''}.`,
      `Evidence (stale after ${s.freshness.staleDays} days, from each company's latest scan): of ${s.freshness.total} ` +
        `companies, ${s.freshness.fresh} fresh, ${s.freshness.stale} stale, ${s.freshness.unreachable} unreachable, ` +
        `${s.freshness.neverScanned} never scanned. The cached stale column still calls ${s.freshness.staleColumnSaysFresh} ` +
        'of the stale ones fresh.',
      `Approvals decided after they expired: ${s.lateApprovals.count} (informational — the decision path answers these as expired).`,
      `Campaigns with auto-send on a channel other than email or LinkedIn: ${s.autoSendOffCold.count} ` +
        `(the ${s.autoSendOffCold.constraint} CHECK makes this 0).`,
    ]

    await ctx.audit('agent.get_compliance_summary', { staleDays })
    return ok(counts, bounded(lines))
  },
}

// ---------------------------------------------------------------------------
// search_crm
// ---------------------------------------------------------------------------

const SEARCH_SECTION_NAMES = ['companies', 'contacts', 'deals', 'campaigns', 'meetings', 'proposals', 'touches'] as const
type SearchSectionName = (typeof SEARCH_SECTION_NAMES)[number]

const searchCrmShape = {
  query: z.string().min(2).max(100).describe('Text to look for: a name, a domain, a subject line.'),
  sections: z
    .array(z.enum(['companies', 'contacts', 'deals', 'campaigns', 'meetings', 'proposals', 'touches']))
    .optional()
    .describe('Which kinds of record to search. Omitted or empty: all of them.'),
}

/** A hit's company, from the link the search module built — the domain `get_company` takes. */
function domainOfHref(href: string): string | null {
  const m = /^\/companies\/([^/?#]+)/.exec(href)
  if (!m) return null
  try {
    return decodeURIComponent(m[1]!)
  } catch {
    return null
  }
}

export const searchCrm: AgencyToolSpec<typeof searchCrmShape> = {
  name: 'search_crm',
  description:
    'Search companies, people, deals, campaigns, meetings, proposals and messages by text, within ' +
    'the org of the person you are helping and nothing beyond it. Use it when you have a name or a ' +
    'phrase and not a domain; use get_company once you have the domain. A read; nothing is sent.',
  shape: searchCrmShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The route's own rule: what the principal may read, never a wider set.
    // Asking for a section narrows it; it cannot open one `can()` closed.
    const allowed = searchSectionsFor(ctx.principal)
    if (!allowed) return fail('not_permitted', 'The person you are helping cannot search the CRM.')
    // An EMPTY list is read as an omitted one. The shape admits `[]`, and
    // `??` does not replace it, so it used to search nothing and then answer
    // "cannot read ." — telling the model an owner may not search the CRM.
    const asked = new Set<SearchSectionName>(input.sections?.length ? input.sections : SEARCH_SECTION_NAMES)
    const on = (s: SearchSectionName): boolean => asked.has(s) && allowed[s]
    const sections: SearchSections = {
      companies: on('companies'),
      contacts: on('contacts'),
      deals: on('deals'),
      campaigns: on('campaigns'),
      meetings: on('meetings'),
      proposals: on('proposals'),
      touches: on('touches'),
      draftBodies: on('touches') && allowed.draftBodies,
    }
    const searched = SEARCH_SECTION_NAMES.filter(on)
    const refused = [...asked].filter((s) => !allowed[s])
    // A refusal names what was refused; with `asked` never empty, nothing
    // searched means everything asked for was refused.
    if (searched.length === 0 && refused.length > 0) {
      return fail('not_permitted', `The person you are helping cannot read ${refused.join(', ')}.`)
    }

    const q = searchQueryFrom(input.query)
    if (!q.ok) return fail('invalid_state', 'Search for at least two characters that are not spaces.')
    const result = await searchOrg(ctx.db, ctx.orgId, q.q, sections)

    // The query is the person's text and may be a name, so it is not audited.
    await ctx.audit('agent.search_crm', { sections: searched, returned: result.hits.length, truncated: result.truncated })
    const hits = result.hits.map((h) => ({
      kind: h.kind,
      id: h.id,
      label: oneLine(h.label, 160),
      sub: h.sub === null ? null : oneLine(h.sub, 160),
      domain: domainOfHref(h.href),
    }))
    const scope = `Searched ${searched.join(', ')}${refused.length > 0 ? `; not permitted to read ${refused.join(', ')}` : ''}.`
    if (hits.length === 0) {
      return ok({ hits, truncated: false, searched }, `Nothing in this org matches "${q.q}". ${scope}`)
    }
    const lines = hits.map((h) =>
      `${h.kind.padEnd(8)} ${h.label}${h.sub ? ` — ${h.sub}` : ''}${h.domain && h.kind !== 'company' ? ` [${h.domain}]` : ''}`,
    )
    return ok(
      { hits, truncated: result.truncated, searched },
      [
        `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${q.q}". ${scope}`,
        bounded(lines, 7_000),
        ...(result.truncated ? ['More matched than are shown — narrow the query or pick a section.'] : []),
      ].join('\n'),
    )
  },
}
