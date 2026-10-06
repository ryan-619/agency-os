/**
 * The proposals, meetings, deal-owner and task tools (2026-10-06): what chat
 * needs to run the back half of the pipeline the way a person does from the
 * company page, the proposal page, a meeting's brief, the board and /tasks.
 *
 * Two reads (`low`: `get_proposal`, `list_meetings`) and six internal writes
 * (`medium`, run at once: `runsWithoutApproval` lets internal writes through
 * without a card, granted single-use and audited).
 * Every write goes through the function the web route calls —
 * `generateProposal`, `rescheduleMeeting`, `cancelMeeting`,
 * `setMeetingOutcome`, `setDealOwner`, `tasksComplete` — so the agent's
 * write and a person's write are the same row, refused for the same reasons
 * in the same sentences. Where a route checks something before it calls the
 * function (a day rate, a real date, a LinkedIn step that may not be ticked)
 * the handler checks it too, in the route's words. Nothing here sends a
 * message, touches a calendar or tells anybody anything: every write's
 * summary ends "Nothing was sent."
 *
 * Each tool asks `can()` what its route or page asks — `deals:write` for
 * every write (the proposals, meetings, deals and tasks routes all gate on
 * it), `deals:read` for the two reads (the proposal print view and a
 * meeting's brief). `orgId` is the context's, never an argument's, and an id
 * or a domain that belongs to another org is answered exactly like one that
 * belongs to nobody: `not_found`, with nothing written.
 *
 * Only the summary reaches the model (the adapter in apps/agent hands it the
 * summary and nothing else), so every id the model may need for a later call
 * — a proposal's, a meeting's, a deal's, a task's — is printed in the
 * summary as well as returned in `data`.
 *
 * §2.2 governs the two proposal tools:
 *
 *  - a scope item is a gap the scanner OBSERVED, because the stored document
 *    was generated that way (`proposalFromFindings`); a signal it could not
 *    observe is printed as "not assessed", never as fine, and one observed
 *    with no gap is named by its key only — the ICP's `why` describes the
 *    gap, so it is never quoted as a strength;
 *  - freshness is derived from the scan's `ran_at` with `isStale`, at the
 *    threshold `staleAfterDaysOf` reads from the active ICP — never from
 *    `findings.stale`;
 *  - a proposal whose scan a newer SUCCESSFUL scan of the company has
 *    superseded is called superseded (`shareEvidenceSuperseded`, the share
 *    link's own reading), because only the latest scan is quoted outbound.
 *
 * Who a write is filed under. The agent has no users row. A generated
 * proposal therefore names no creator (`created_by` NULL, as an agent's task
 * does — any teammate may approve the card, so the person whose chat it is
 * may never have seen it), and its `proposal.generated` row names the actor
 * `agent`. A rescheduled meeting is recorded the way `book_meeting` records
 * one: `created_by` the person whose chat it is, actor `agent`. A task must
 * name who completed it (`tasks_done_has_who`), so it is completed in the
 * name of the person whose chat it is, and its `task.completed` row names
 * the actor `agent` — the summary says so, as `add_note`'s does.
 *
 * §2.3: `ctx.audit` details carry ids, counts, booleans, fixed words, a
 * company's domain and ISO instants. Never a title, a note or a name.
 */
import { z } from 'zod'
import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm'
import {
  PROPOSAL_RESCORE_SENTENCE, can, isStale, normaliseEmail, staleAfterDaysOf,
  type Proposal, type ProposalRefusal,
} from '@agency/core'
import {
  activeIcpProfile, appendAudit, cancelMeeting, findCompanyByDomain, generateProposal, meetingRescheduleLinks,
  openDealFor, proposalsForCompany, readMeetingWithCompany, readProposal, rescheduleMeeting, setDealOwner,
  setMeetingOutcome, shareEvidenceSuperseded, tasksComplete, upcomingMeetings,
  type AgencyDb, type DealRow, type MeetingLink, type MeetingRow, type ProposalRow,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { normaliseDomain } from '@agency/scanner'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'
import { instantFrom } from './instant.js'

const NOTHING_SENT = 'Nothing was sent.'
const NOTHING_CHANGED = 'Nothing was changed.'
const READ_ONLY = 'A read; nothing was changed or sent.'
const DAY_MS = 86_400_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Words and lookups the eight share
// ---------------------------------------------------------------------------

/** "2026-09-15 12:00 UTC". */
function when(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * A meeting's time as its own zone tells it, with the instant in UTC beside
 * it — the reading `get_company_timeline` gives a meeting. A meeting is a
 * wall-clock commitment somewhere; printing the UTC time next to the zone's
 * NAME is how a 15:00 London call once read as 14:00.
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

/** Whitespace collapsed and cut to `max` characters (code points), marked when cut. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** As the proposal document prints money: "USD 9,600". */
function money(currency: string, n: number): string {
  return `${currency} ${n.toLocaleString('en-US')}`
}

/** The company by domain in this org, or the sentence to fail with. */
async function companyFor(
  ctx: ToolContext,
  raw: string,
): Promise<{ ok: true; id: string; domain: string; name: string | null } | { ok: false; message: string }> {
  const domain = normaliseDomain(raw)
  if (!domain) return { ok: false, message: `"${raw}" is not a domain.` }
  const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
  if (!company) return { ok: false, message: `No company with domain "${domain}" is in the CRM.` }
  return { ok: true, id: company.id, domain: company.domain, name: company.name }
}

/** The active ICP's freshness window, read only through `staleAfterDaysOf`. */
async function staleDaysFor(db: AgencyDb, orgId: string): Promise<number> {
  return staleAfterDaysOf((await activeIcpProfile(db, orgId))?.definition)
}

/** A teammate's name as a list prints it. */
function personLabel(u: { readonly name: string | null; readonly email: string }): string {
  return u.name?.trim() || u.email
}

/** A meeting's title, quoted, or nothing. Free text: printed, never audited. */
function titled(title: string | null): string {
  return title ? ` “${oneLine(title, 100)}”` : ''
}

function minutesOf(m: Pick<MeetingRow, 'startsAt' | 'endsAt'>): number | null {
  return m.endsAt ? Math.round((m.endsAt.getTime() - m.startsAt.getTime()) / 60_000) : null
}

/**
 * The deal line `createMeeting` hands back — `created:meeting`,
 * `advanced:meeting`, `unchanged:proposal`, or `not moved` — in words.
 */
function dealWords(label: string): string {
  if (label === 'not moved') return 'The deal was not moved: the original booking never moved it.'
  const [outcome, stage] = label.split(':')
  if (outcome === 'created') return `A deal was opened for the company at ${stage ?? 'meeting'}.`
  if (outcome === 'advanced') return `The deal moved forward to ${stage ?? 'meeting'}.`
  return `The deal stays at ${stage ?? 'its stage'}.`
}

/** The person whose chat it is, as a `users.id` a column can hold — or null. */
function principalUserId(ctx: ToolContext): string | null {
  return UUID.test(ctx.principal.id) ? ctx.principal.id : null
}

// ---------------------------------------------------------------------------
// generate_proposal
// ---------------------------------------------------------------------------

const generateProposalShape = {
  domain: z.string().min(1).max(253).describe('The company to write a proposal for, by its domain.'),
  dayRate: z
    .number()
    .positive()
    .max(1_000_000)
    .optional()
    .describe('The agency’s day rate in whole currency units, e.g. 1200. Leave it out for an effort band with no total.'),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .describe('A three-letter currency code for the day rate, like USD, EUR or GBP. Default USD.'),
}

const NOT_WRITTEN = `No proposal was written. ${NOTHING_SENT}`

/**
 * A refusal in the words the company page's Generate button uses to say why
 * it is disabled — the same facts, checked in the same order — with the
 * tool that fixes it. `no_scan` with no active ICP keeps the generator's own
 * sentence, because "scan the company first" would not fix that one.
 */
function generateRefusal(
  reason: ProposalRefusal,
  generatorMessage: string,
  staleAfter: number,
  hasIcp: boolean,
): ToolOutcome<never> {
  switch (reason) {
    case 'no_scan':
      return hasIcp
        ? fail('no_fresh_evidence', `Scan the company first — a proposal is written from findings. scan_company scans it. ${NOT_WRITTEN}`)
        : fail('invalid_state', `${generatorMessage} ${NOT_WRITTEN}`)
    case 'unreachable':
      return fail(
        'unreachable',
        `The last scan never reached the site; nothing was observed to propose from. scan_company tries again. ${NOT_WRITTEN}`,
      )
    case 'stale':
      return fail(
        'no_fresh_evidence',
        `The findings are stale (older than ${staleAfter} days). Re-scan before generating (§2.2) — scan_company ` +
          `re-scans it. ${NOT_WRITTEN}`,
      )
    case 'rescore':
      return fail(
        'no_fresh_evidence',
        `The last scan was ${PROPOSAL_RESCORE_SENTENCE} before generating: the active ICP scores signals it did ` +
          `not. scan_company re-scans it. ${NOT_WRITTEN}`,
      )
    case 'no_gaps':
      return fail('invalid_state', `No gaps were observed. There is nothing to propose. ${NOT_WRITTEN}`)
  }
}

/** Effort, day rate and total, as the proposal stores them. */
function pricingWords(
  row: Pick<ProposalRow, 'currency' | 'totalLow' | 'totalHigh'>,
  pricing: Proposal['pricing'] | undefined,
): string {
  const effort = pricing ? `effort ${pricing.effortDays.low}–${pricing.effortDays.high} days` : 'no effort recorded'
  if (!pricing || pricing.dayRate === null || pricing.dayRate === undefined) {
    return `${effort}; no day rate was set, so there is no total — effort only`
  }
  const total =
    row.totalLow !== null && row.totalHigh !== null
      ? `${money(row.currency, row.totalLow)} – ${money(row.currency, row.totalHigh)}`
      : 'none recorded'
  return `${effort}; day rate ${money(row.currency, pricing.dayRate)}; total ${total}`
}

export const generateProposalTool: AgencyToolSpec<typeof generateProposalShape> = {
  name: 'generate_proposal',
  description:
    'Write a draft proposal for a company from its latest scan: one scope item per gap the scanner ' +
    'observed, grouped into workstreams, with an effort band and — given a day rate — a price range. It ' +
    'refuses a scan that is stale, never reached the site or was scored under another ICP profile, and a ' +
    'company never scanned. The draft is for the team: nothing is sent, and marking it sent or sharing a ' +
    'link is a person’s act on its page.',
  shape: generateProposalShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // POST /api/proposals' own gate.
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot generate proposals. ${NOT_WRITTEN}`)
    }
    const company = await companyFor(ctx, input.domain)
    if (!company.ok) return fail('not_found', `${company.message} ${NOT_WRITTEN}`)

    const icpRow = await activeIcpProfile(ctx.db, ctx.orgId)
    const r = await generateProposal(ctx.db, {
      orgId: ctx.orgId,
      companyId: company.id,
      // The agent has no users row; `proposal.generated` names the actor.
      createdBy: null,
      actor: 'agent',
      dayRate: input.dayRate ?? null,
      currency: input.currency?.toUpperCase() ?? 'USD',
      now: ctx.now(),
    })
    if (!r.ok) return generateRefusal(r.reason, r.message, staleAfterDaysOf(icpRow?.definition), icpRow !== null)

    const { proposal, document: doc } = r
    const scopeItems = doc.workstreams.reduce((n, w) => n + w.items.length, 0)
    // Writing a proposal moves the deal forward to `proposal`; read back
    // what it is now rather than assume the move landed.
    const deal = await openDealFor(ctx.db, ctx.orgId, company.id)

    await ctx.audit('agent.generate_proposal', {
      domain: company.domain,
      proposalId: proposal.id,
      scanId: proposal.scanId,
      workstreams: doc.workstreams.length,
      scopeItems,
    })

    const streams = doc.workstreams
      .map((w) => `${w.name} (${plural(w.items.length, 'item')}, ${w.effortDays.low}–${w.effortDays.high} days)`)
      .join('; ')
    const notAssessed = doc.notAssessed.length
    return ok(
      {
        proposalId: proposal.id,
        domain: company.domain,
        status: proposal.status,
        title: proposal.title,
        scanId: proposal.scanId,
        scanRanAt: doc.basedOn.scanRanAt,
        workstreams: doc.workstreams.map((w) => ({
          name: w.name,
          effortDays: w.effortDays,
          items: w.items.map((i) => i.signalKey),
        })),
        scopeItems,
        notAssessed: doc.notAssessed.map((n) => n.signalKey),
        pricing: {
          currency: proposal.currency,
          dayRate: doc.pricing.dayRate,
          effortDays: doc.pricing.effortDays,
          totalLow: proposal.totalLow,
          totalHigh: proposal.totalHigh,
        },
        dealStage: deal?.stage ?? null,
      },
      [
        `Generated a draft proposal for ${company.domain} from its scan of ${day(new Date(doc.basedOn.scanRanAt))}: ` +
          `proposal ${proposal.id}, “${oneLine(proposal.title, 160)}”.`,
        `${plural(scopeItems, 'scope item')} in ${plural(doc.workstreams.length, 'workstream')}, one item per gap ` +
          `the scan observed: ${streams}.`,
        `Pricing as stored: ${pricingWords(proposal, doc.pricing)}.`,
        ...(notAssessed > 0
          ? [
              `${plural(notAssessed, 'signal')} could not be observed from the outside and ${notAssessed === 1 ? 'is' : 'are'} ` +
                'listed as not assessed — excluded from scope, not assumed fine.',
            ]
          : []),
        ...(deal ? [`Its deal is at ${deal.stage}.`] : []),
        'It is a draft for the team: marking it sent and sharing a link are a person’s acts on its page.',
        NOTHING_SENT,
      ].join(' '),
    )
  },
}

// ---------------------------------------------------------------------------
// get_proposal
// ---------------------------------------------------------------------------

const getProposalShape = {
  proposalId: z.uuid().optional().describe('The proposal, by the id generate_proposal or get_proposal printed.'),
  domain: z
    .string()
    .min(1)
    .max(253)
    .optional()
    .describe('Or a company, by its domain, for its most recent proposal. Give one of the two.'),
}

type EvidenceStanding = 'fresh' | 'stale' | 'superseded'

/**
 * Where the proposal's evidence stands, in the words the proposal page's two
 * banners use. Aged AND superseded is worded as the deadline — the plainer
 * of two true reasons — with the newer scan said beside it, and the fix is a
 * fresh proposal from the latest scan, re-scanning first only if that one
 * has aged out too.
 */
function evidenceWords(
  domain: string,
  ranAt: Date | null,
  staleAfter: number,
  stale: boolean,
  superseded: boolean,
): string {
  const scanned = ranAt ? `the scan of ${day(ranAt)}` : 'the scan it was written from'
  if (stale && superseded) {
    return (
      `Evidence: STALE — ${scanned} is past its ${staleAfter}-day re-verification deadline, and a newer successful ` +
      `scan of ${domain} has run since, so it is superseded as well. Stale findings are re-verified before they ` +
      'appear in anything outbound (§2.2): generate a fresh proposal from the latest scan rather than sending this ' +
      'one — re-scan first (scan_company) only if that scan has aged out too.'
    )
  }
  if (stale) {
    return (
      `Evidence: STALE — ${scanned} is past its ${staleAfter}-day re-verification deadline. Stale findings are ` +
      `re-verified before they appear in anything outbound (§2.2): re-scan ${domain} (scan_company) and generate a ` +
      'fresh proposal rather than sending this one.'
    )
  }
  if (superseded) {
    return (
      `Evidence: SUPERSEDED — a newer scan of ${domain} exists, so this proposal quotes evidence that is no longer ` +
      'the latest; the newer scan may show a gap closed, or a new one. Generate a fresh proposal from it rather ' +
      'than sending this copy; a buyer link to this one reads “being re-verified”.'
    )
  }
  return (
    `Evidence: current — ${scanned} is inside its ${staleAfter}-day re-verification window and is still the ` +
    `latest successful scan of ${domain}.`
  )
}

function statusWords(status: string, needsRegenerating: boolean): string {
  switch (status) {
    case 'draft':
      return (
        'It is a draft for the team: marking it sent and sharing a link are a person’s acts on its page' +
        (needsRegenerating ? ' — and this one should be regenerated before anybody marks it sent.' : '.')
      )
    case 'sent':
      return 'A person marked it sent; what the buyer said is recorded on its page, or through their link.'
    case 'accepted':
      return 'It was accepted, which closed the deal as won.'
    default:
      return `It was ${status}.`
  }
}

export const getProposal: AgencyToolSpec<typeof getProposalShape> = {
  name: 'get_proposal',
  description:
    'Read a proposal — by its id, or the most recent one for a company’s domain: its status, the scope ' +
    'items with the observed detail each was written from, workstreams, effort and price range, the ' +
    'signals listed as not assessed, and whether its evidence is current, stale or superseded by a newer ' +
    'scan. A read; it changes nothing and sends nothing.',
  shape: getProposalShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The proposal print view's and the Markdown export's gate.
    if (!can(ctx.principal, 'deals:read')) {
      return fail('not_permitted', 'The person you are helping cannot read proposals.')
    }
    const byId = input.proposalId !== undefined
    const byDomain = input.domain !== undefined && input.domain.trim() !== ''
    if (byId === byDomain) {
      return fail(
        'invalid_state',
        'Say which proposal: a proposalId, or a domain for that company’s most recent one — one of the two.',
      )
    }

    let row: ProposalRow | null
    if (input.proposalId !== undefined) {
      row = await readProposal(ctx.db, ctx.orgId, input.proposalId)
      if (!row) {
        return fail(
          'not_found',
          'No proposal with that id is in the CRM. get_proposal with a domain reads a company’s most recent one.',
        )
      }
    } else {
      const found = await companyFor(ctx, input.domain ?? '')
      if (!found.ok) return fail('not_found', found.message)
      row = (await proposalsForCompany(ctx.db, ctx.orgId, found.id))[0] ?? null
      if (!row) {
        return fail(
          'not_found',
          `No proposal has been generated for ${found.domain}. generate_proposal writes one from its latest scan.`,
        )
      }
    }
    const proposal = row

    const [[company], [scan], staleAfter, superseded] = await Promise.all([
      ctx.db
        .select({ domain: schema.companies.domain, name: schema.companies.name })
        .from(schema.companies)
        .where(and(eq(schema.companies.orgId, ctx.orgId), eq(schema.companies.id, proposal.companyId)))
        .limit(1),
      ctx.db
        .select({ ranAt: schema.scans.ranAt })
        .from(schema.scans)
        .where(and(eq(schema.scans.orgId, ctx.orgId), eq(schema.scans.id, proposal.scanId)))
        .limit(1),
      staleDaysFor(ctx.db, ctx.orgId),
      // The share link's own reading: a newer SUCCESSFUL scan, compared in SQL.
      shareEvidenceSuperseded(ctx.db, ctx.orgId, proposal.id),
    ])
    // The FK forbids a proposal without its company; one with none is not a proposal.
    if (!company) return fail('not_found', 'No proposal with that id is in the CRM.')

    // §2.2: derived from when the scan RAN, on this read — never a stored flag.
    const ranAt = scan?.ranAt ?? null
    const stale = isStale(ranAt, staleAfter, ctx.now())
    const standing: EvidenceStanding = stale ? 'stale' : superseded ? 'superseded' : 'fresh'

    // The stored document, never regenerated: what a buyer may have been sent.
    const doc = (proposal.document ?? {}) as Partial<Proposal>
    const workstreams = doc.workstreams ?? []
    const notAssessed = doc.notAssessed ?? []
    const inPlace = doc.alreadyInPlace ?? []
    const scopeItems = workstreams.reduce((n, w) => n + w.items.length, 0)

    await ctx.audit('agent.get_proposal', { proposalId: proposal.id, companyId: proposal.companyId, stale, superseded })

    const scopeLines: string[] = []
    for (const w of workstreams) {
      scopeLines.push(`${w.name} — ${w.effortDays.low}–${w.effortDays.high} days`)
      for (const item of w.items) {
        // The first evidence line is the finding's own detail when it had one.
        const seen = item.evidence[0]
        scopeLines.push(`  - ${item.signalKey} (weight ${item.weight}): ${seen ? oneLine(seen, 160) : 'no detail recorded'}`)
      }
    }
    const score =
      doc.basedOn && doc.basedOn.score !== null && doc.basedOn.score !== undefined
        ? `Score when it was generated: ${doc.basedOn.score}/100${doc.basedOn.tier ? `, tier “${doc.basedOn.tier}”` : ''}. ` +
          'That is the team’s ranking, as the team’s copy shows it; the buyer’s copy leaves it and each item’s weight out.'
        : null

    const lines = [
      `Proposal ${proposal.id} for ${company.domain} — ${proposal.status}, generated ${when(proposal.generatedAt)}` +
        `${proposal.decidedAt ? `, decided ${when(proposal.decidedAt)}` : ''}: “${oneLine(proposal.title, 160)}”.`,
      evidenceWords(company.domain, ranAt, staleAfter, stale, superseded),
      ...(score ? [score] : []),
      `${plural(scopeItems, 'scope item')} in ${plural(workstreams.length, 'workstream')}, each a gap the scan observed:`,
      bounded(scopeLines, 5_000),
      `Pricing: ${pricingWords(proposal, doc.pricing)}.`,
      notAssessed.length > 0
        ? 'Not assessed — could not be observed from the outside, so excluded from scope and not assumed fine: ' +
          `${notAssessed.map((n) => n.signalKey).join(', ')}.`
        : 'Not assessed: none — every signal the ICP scores was observed.',
      ...(inPlace.length > 0
        ? [`Observed and not a gap, so out of scope: ${inPlace.map((s) => s.signalKey).join(', ')}.`]
        : []),
      statusWords(proposal.status, standing !== 'fresh'),
      READ_ONLY,
    ]
    return ok(
      {
        proposalId: proposal.id,
        domain: company.domain,
        status: proposal.status,
        title: proposal.title,
        generatedAt: proposal.generatedAt.toISOString(),
        decidedAt: proposal.decidedAt?.toISOString() ?? null,
        evidence: {
          scanId: proposal.scanId,
          scanRanAt: ranAt?.toISOString() ?? null,
          staleAfterDays: staleAfter,
          stale,
          superseded,
          standing,
        },
        score: doc.basedOn?.score ?? null,
        tier: doc.basedOn?.tier ?? null,
        workstreams: workstreams.map((w) => ({
          name: w.name,
          effortDays: w.effortDays,
          items: w.items.map((i) => ({ signalKey: i.signalKey, weight: i.weight, detail: i.evidence[0] ?? null })),
        })),
        pricing: {
          currency: proposal.currency,
          dayRate: doc.pricing?.dayRate ?? null,
          effortDays: doc.pricing?.effortDays ?? null,
          totalLow: proposal.totalLow,
          totalHigh: proposal.totalHigh,
        },
        notAssessed: notAssessed.map((n) => n.signalKey),
        alreadyInPlace: inPlace.map((s) => s.signalKey),
      },
      lines.join('\n'),
    )
  },
}

// ---------------------------------------------------------------------------
// list_meetings
// ---------------------------------------------------------------------------

const listMeetingsShape = {
  days: z
    .number()
    .int()
    .min(1)
    .max(366)
    .optional()
    .describe('How far ahead to look, in days (at most a year) — and how far back with includePast. Default 14.'),
  includePast: z
    .boolean()
    .optional()
    .describe('Also list the meetings of the last `days` days that have started and have no outcome recorded.'),
  limit: z.number().int().min(1).max(50).optional().describe('At most this many of each list. Default 20.'),
}

interface MeetingView {
  readonly meetingId: string
  readonly domain: string
  readonly title: string | null
  readonly startsAt: string
  readonly timeZone: string
  readonly local: string
  readonly durationMinutes: number | null
  readonly source: string
  readonly cancelled: boolean
  readonly outcome: string | null
  readonly needsReview: boolean
  readonly rescheduledFrom: { meetingId: string; startsAt: string; timeZone: string } | null
  readonly rescheduledTo: { meetingId: string; startsAt: string; timeZone: string } | null
}

function linkView(link: MeetingLink | null): MeetingView['rescheduledFrom'] {
  return link ? { meetingId: link.id, startsAt: link.startsAt.toISOString(), timeZone: link.timeZone } : null
}

async function meetingView(ctx: ToolContext, m: MeetingRow, domain: string): Promise<MeetingView> {
  const links = await meetingRescheduleLinks(ctx.db, ctx.orgId, m.id)
  return {
    meetingId: m.id,
    domain,
    title: m.title,
    startsAt: m.startsAt.toISOString(),
    timeZone: m.timeZone,
    local: inZone(m.startsAt, m.timeZone),
    durationMinutes: minutesOf(m),
    source: m.source,
    cancelled: m.cancelledAt !== null,
    outcome: m.outcome,
    needsReview: m.needsReview,
    rescheduledFrom: linkView(links.from),
    rescheduledTo: linkView(links.to),
  }
}

function meetingLine(v: MeetingView, state: string): string {
  const length = v.durationMinutes !== null ? `${v.durationMinutes} min` : 'no end time recorded'
  const extra = [
    v.needsReview ? 'needs review: a public booking matched records already on file, and a person confirms who booked' : null,
    v.rescheduledFrom
      ? `rescheduled from ${inZone(new Date(v.rescheduledFrom.startsAt), v.rescheduledFrom.timeZone)} (meeting ${v.rescheduledFrom.meetingId})`
      : null,
    v.rescheduledTo
      ? `rescheduled to ${inZone(new Date(v.rescheduledTo.startsAt), v.rescheduledTo.timeZone)} (meeting ${v.rescheduledTo.meetingId})`
      : null,
  ].filter((e): e is string => e !== null)
  return (
    `meeting ${v.meetingId} · ${v.domain}${titled(v.title)} · ${v.local} · ${length} · ` +
    `${v.source.replace(/_/g, ' ')} · ${state}${extra.map((e) => ` · ${e}`).join('')}`
  )
}

export const listMeetings: AgencyToolSpec<typeof listMeetingsShape> = {
  name: 'list_meetings',
  description:
    'Read the meetings coming up in the next few days and, if asked, the recent ones still waiting for an ' +
    'outcome — each with its id, company, title, time in its own zone with UTC beside it, length, source, ' +
    'outcome and any reschedule link. Cancelled meetings are not listed. A read; it changes nothing and ' +
    'sends nothing.',
  shape: listMeetingsShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // A meeting's brief, and its calendar file, are gated on deals:read.
    if (!can(ctx.principal, 'deals:read')) {
      return fail('not_permitted', 'The person you are helping cannot read meetings.')
    }
    const days = input.days ?? 14
    const limit = input.limit ?? 20
    const includePast = input.includePast === true
    const now = ctx.now()
    const until = new Date(now.getTime() + days * DAY_MS)
    const since = new Date(now.getTime() - days * DAY_MS)

    // The pipeline page's own read: from now on, not cancelled, soonest
    // first. One more than the limit, so a cut list says so.
    const ahead = (await upcomingMeetings(ctx.db, ctx.orgId, now, limit + 1)).filter(
      (m) => m.startsAt.getTime() < until.getTime(),
    )
    // Started, inside the window, not cancelled, and nobody has said what
    // happened — the meetings record_meeting_outcome is for.
    const behind = includePast
      ? await ctx.db
          .select({ meeting: schema.meetings, domain: schema.companies.domain })
          .from(schema.meetings)
          .innerJoin(
            schema.companies,
            and(eq(schema.companies.id, schema.meetings.companyId), eq(schema.companies.orgId, schema.meetings.orgId)),
          )
          .where(
            and(
              eq(schema.meetings.orgId, ctx.orgId),
              isNull(schema.meetings.cancelledAt),
              isNull(schema.meetings.outcome),
              lt(schema.meetings.startsAt, now),
              gte(schema.meetings.startsAt, since),
            ),
          )
          .orderBy(desc(schema.meetings.startsAt))
          .limit(limit + 1)
      : null

    const upcoming = await Promise.all(ahead.slice(0, limit).map((m) => meetingView(ctx, m, m.companyDomain)))
    const past = behind
      ? await Promise.all(behind.slice(0, limit).map((r) => meetingView(ctx, r.meeting, r.domain)))
      : null
    const omitted = {
      upcoming: ahead.length > limit,
      past: behind !== null && behind.length > limit,
    }

    await ctx.audit('agent.list_meetings', {
      days,
      includePast,
      upcoming: upcoming.length,
      past: past?.length ?? null,
    })

    const lines: string[] = []
    if (upcoming.length === 0) {
      lines.push(`No meetings in the next ${plural(days, 'day')}.`)
    } else {
      lines.push(`Upcoming in the next ${plural(days, 'day')}, soonest first${omitted.upcoming ? ` (the first ${limit}; more are booked)` : ''}:`)
      for (const v of upcoming) lines.push(meetingLine(v, 'upcoming'))
    }
    if (past) {
      if (past.length === 0) {
        lines.push(`No meeting of the last ${plural(days, 'day')} is waiting for an outcome.`)
      } else {
        lines.push(
          `Started in the last ${plural(days, 'day')} with no outcome recorded, newest first` +
            `${omitted.past ? ` (the first ${limit}; there are more)` : ''}:`,
        )
        for (const v of past) lines.push(meetingLine(v, 'no outcome recorded'))
      }
    }
    const footer =
      'Cancelled meetings are not listed. Each time is the meeting’s own zone, with UTC beside it. ' +
      'record_meeting_outcome records held or no-show once a meeting has started, and reschedule_meeting moves ' +
      'one that has started; one that has not is moved with cancel_meeting and then book_meeting. ' +
      READ_ONLY
    return ok(
      { days, upcoming, past, omitted },
      `${bounded(lines, 7_000)}\n${footer}`,
    )
  },
}

// ---------------------------------------------------------------------------
// reschedule_meeting, cancel_meeting, record_meeting_outcome
// ---------------------------------------------------------------------------

const NO_SUCH_MEETING = 'No such meeting. list_meetings lists them with their ids.'

/** `setMeetingOutcome`'s and `rescheduleMeeting`'s `not_yet`, pointed at the two tools that do it here. */
const NOT_YET_HERE = 'Here, that is cancel_meeting, then book_meeting at the new time.'

/**
 * The meeting page takes the new time as a wall-clock time in the meeting's
 * zone and converts it with `wallClockToInstant`, which lives in apps/web and
 * which nothing in packages/ may import. So this takes the instant the model
 * means, offset and all — as `book_meeting` does — and the zone, defaulting
 * to the meeting's own as the page's form does. The summary prints the new
 * time back in that zone with UTC beside it, so an offset the model got
 * wrong reads as the wrong local time rather than passing unnoticed.
 */
const rescheduleMeetingShape = {
  meetingId: z.uuid().describe('The meeting that moved, by the id list_meetings printed.'),
  startsAt: z
    .string()
    .min(1)
    .max(40)
    .describe(
      'When it happens instead, as an ISO 8601 instant WITH its offset, e.g. 2026-10-20T15:00:00+01:00 or ' +
        '2026-10-20T14:00:00Z. A time with no offset is refused, never guessed.',
    ),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('The IANA zone the new time was agreed in, e.g. Europe/London. Default: the meeting’s own zone.'),
}

export const rescheduleMeetingTool: AgencyToolSpec<typeof rescheduleMeetingShape> = {
  name: 'reschedule_meeting',
  description:
    'Record that a meeting which has started happened, or will happen, at another time: it is marked ' +
    'rescheduled and a new meeting is recorded at the new time, linked to it. Only for a meeting whose ' +
    'start has passed — one that has not started is moved with cancel_meeting and then book_meeting. No ' +
    'invitation or message is sent, and no calendar is touched.',
  shape: rescheduleMeetingShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // PATCH /api/meetings/[id]'s gate.
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot change meetings. ${NOTHING_CHANGED}`)
    }
    const startsAt = instantFrom(input.startsAt)
    if (!startsAt) {
      return fail(
        'invalid_state',
        `"${oneLine(input.startsAt, 40)}" is not an ISO 8601 instant with its offset on a date that exists, like ` +
          `2026-10-20T15:00:00+01:00 or 2026-10-20T14:00:00Z. ${NOTHING_CHANGED}`,
      )
    }
    const found = await readMeetingWithCompany(ctx.db, ctx.orgId, input.meetingId)
    if (!found) return fail('not_found', `${NO_SUCH_MEETING} ${NOTHING_CHANGED}`)
    const { meeting: current, company } = found
    // The meeting page enters the new time in the meeting's own zone.
    const timeZone = input.timeZone?.trim() || current.timeZone

    const r = await rescheduleMeeting(ctx.db, {
      orgId: ctx.orgId,
      id: current.id,
      startsAt,
      timeZone,
      actor: 'agent',
      // As `book_meeting` records a meeting: the person whose chat it is.
      createdBy: principalUserId(ctx),
      now: ctx.now(),
    })
    if (!r.ok) {
      switch (r.reason) {
        case 'not_found':
          return fail('not_found', `${NO_SUCH_MEETING} ${NOTHING_CHANGED}`)
        case 'not_yet':
          return fail('invalid_state', `${r.message} ${NOT_YET_HERE} ${NOTHING_CHANGED}`)
        case 'cancelled':
        case 'already_rescheduled':
        case 'invalid':
          return fail('invalid_state', `${r.message} ${NOTHING_CHANGED}`)
      }
    }

    const old = r.meeting
    const next = r.replacement
    await ctx.audit('agent.reschedule_meeting', {
      meetingId: old.id,
      replacementId: next.id,
      startsAt: next.startsAt.toISOString(),
      timeZone: next.timeZone,
    })
    const length = minutesOf(next)
    return ok(
      {
        meetingId: old.id,
        replacementId: next.id,
        domain: company.domain,
        was: { startsAt: old.startsAt.toISOString(), timeZone: old.timeZone },
        now: { startsAt: next.startsAt.toISOString(), timeZone: next.timeZone, durationMinutes: length },
        deal: r.deal,
      },
      `Rescheduled the meeting with ${company.domain}${titled(old.title)}: it was ${inZone(old.startsAt, old.timeZone)} ` +
        `(meeting ${old.id}, now recorded as rescheduled); the new meeting is ${inZone(next.startsAt, next.timeZone)}` +
        `${length !== null ? `, ${length} min` : ''} (meeting ${next.id}), linked to it. ${dealWords(r.deal)} ` +
        `No invitation or message was sent — tell the people involved from your own calendar. ${NOTHING_SENT}`,
    )
  },
}

const meetingIdShape = {
  meetingId: z.uuid().describe('The meeting, by the id list_meetings printed.'),
}

export const cancelMeetingTool: AgencyToolSpec<typeof meetingIdShape> = {
  name: 'cancel_meeting',
  description:
    'Call off a recorded meeting in the CRM. Nobody is told: no invitation was sent from here, so none is ' +
    'withdrawn — whoever sent one from a calendar cancels it there. A meeting whose outcome is already ' +
    'recorded cannot be cancelled. The deal is not moved, and nothing is sent.',
  shape: meetingIdShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot change meetings. ${NOTHING_CHANGED}`)
    }
    const found = await readMeetingWithCompany(ctx.db, ctx.orgId, input.meetingId)
    if (!found) return fail('not_found', `${NO_SUCH_MEETING} ${NOTHING_CHANGED}`)
    const { meeting, company } = found

    if (!(await cancelMeeting(ctx.db, ctx.orgId, meeting.id, 'agent'))) {
      // The UPDATE decided; this re-read only names why it matched nothing,
      // in the route's words.
      const now = await readMeetingWithCompany(ctx.db, ctx.orgId, meeting.id)
      if (!now) return fail('not_found', `${NO_SUCH_MEETING} ${NOTHING_CHANGED}`)
      return fail(
        'invalid_state',
        now.meeting.cancelledAt
          ? `This meeting is already cancelled. ${NOTHING_CHANGED}`
          : 'What happened at this meeting is already recorded, so it cannot be called off. Correct the outcome ' +
              `instead (record_meeting_outcome). ${NOTHING_CHANGED}`,
      )
    }

    await ctx.audit('agent.cancel_meeting', { meetingId: meeting.id, companyId: meeting.companyId })
    return ok(
      { meetingId: meeting.id, domain: company.domain, cancelled: true },
      `Cancelled the meeting with ${company.domain}${titled(meeting.title)} at ${inZone(meeting.startsAt, meeting.timeZone)} ` +
        `(meeting ${meeting.id}) in the CRM. Nobody is told by this — if an invitation went out from a calendar, ` +
        `cancel it there. The deal stays where it is. ${NOTHING_SENT}`,
    )
  },
}

const recordMeetingOutcomeShape = {
  meetingId: z.uuid().describe('The meeting, by the id list_meetings printed. It must have started.'),
  outcome: z
    .enum(['held', 'no_show'])
    .describe('held: it happened. no_show: they did not turn up. A meeting that moved is reschedule_meeting.'),
}

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  held: 'held',
  no_show: 'a no-show',
  rescheduled: 'rescheduled',
}

export const recordMeetingOutcome: AgencyToolSpec<typeof recordMeetingOutcomeShape> = {
  name: 'record_meeting_outcome',
  description:
    'Record what happened at a meeting that has started: held, or a no-show. Neither moves the deal — a ' +
    'no-show is not a lost deal. A wrong outcome is corrected by recording the other one; a meeting that ' +
    'moved to another time is recorded with reschedule_meeting instead. Nothing is sent.',
  shape: recordMeetingOutcomeShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot change meetings. ${NOTHING_CHANGED}`)
    }
    const found = await readMeetingWithCompany(ctx.db, ctx.orgId, input.meetingId)
    if (!found) return fail('not_found', `${NO_SUCH_MEETING} ${NOTHING_CHANGED}`)
    const previous = found.meeting.outcome

    const r = await setMeetingOutcome(ctx.db, {
      orgId: ctx.orgId,
      id: found.meeting.id,
      outcome: input.outcome,
      actor: 'agent',
      now: ctx.now(),
    })
    if (!r.ok) {
      switch (r.reason) {
        case 'not_found':
          return fail('not_found', `${NO_SUCH_MEETING} ${NOTHING_CHANGED}`)
        case 'not_yet':
          return fail('invalid_state', `${r.message} ${NOT_YET_HERE} ${NOTHING_CHANGED}`)
        case 'cancelled':
        case 'already_rescheduled':
          return fail('invalid_state', `${r.message} ${NOTHING_CHANGED}`)
      }
    }

    const m = r.meeting
    await ctx.audit('agent.record_meeting_outcome', {
      meetingId: m.id,
      companyId: m.companyId,
      outcome: input.outcome,
      previous,
    })
    const corrected =
      previous === null
        ? ''
        : previous === input.outcome
          ? ' (it already was; recorded again)'
          : ` (it was recorded as ${OUTCOME_WORDS[previous] ?? previous}; corrected)`
    const deal =
      input.outcome === 'no_show'
        ? 'A no-show does not move the deal — it is not a lost deal.'
        : 'It does not move the deal: where it goes next is a person’s call on the board, or update_deal.'
    return ok(
      { meetingId: m.id, domain: found.company.domain, outcome: m.outcome, previous },
      `Recorded the meeting with ${found.company.domain}${titled(m.title)} at ${inZone(m.startsAt, m.timeZone)} ` +
        `(meeting ${m.id}) as ${OUTCOME_WORDS[input.outcome] ?? input.outcome}${corrected}. ${deal} ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// set_deal_owner
// ---------------------------------------------------------------------------

const setDealOwnerShape = {
  domain: z.string().min(1).max(253).optional().describe('The company whose OPEN deal to assign, by its domain.'),
  dealId: z.uuid().optional().describe('Or the deal itself, by its id. Give a domain or a dealId, not both.'),
  ownerEmail: z.email().optional().describe('The teammate who takes it, by their sign-in address.'),
  clear: z.literal(true).optional().describe('Unassign the deal instead. Give an ownerEmail or clear, not both.'),
}

/**
 * A teammate by sign-in address, in THIS org and not revoked — `create_task`'s
 * lookup. `users.email` is stored normalised, so one equality is exact. A
 * revoked teammate cannot sign in to see the board, so a deal handed to them
 * is a deal nobody owns.
 */
async function assignableTeammate(
  ctx: ToolContext,
  raw: string,
): Promise<{ id: string; label: string } | null> {
  const email = normaliseEmail(raw)
  if (!email) return null
  const rows = await ctx.db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, ctx.orgId), eq(schema.users.email, email), isNull(schema.users.revokedAt)))
    .limit(1)
  const u = rows[0]
  return u ? { id: u.id, label: personLabel(u) } : null
}

/** Whoever a users.id names in this org, for a sentence — revoked included. */
async function teammateLabel(ctx: ToolContext, id: string): Promise<string> {
  const rows = await ctx.db
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, ctx.orgId), eq(schema.users.id, id)))
    .limit(1)
  return rows[0] ? personLabel(rows[0]) : 'a former teammate'
}

export const setDealOwnerTool: AgencyToolSpec<typeof setDealOwnerShape> = {
  name: 'set_deal_owner',
  description:
    'Assign a company’s deal to a teammate by their sign-in address, or clear its owner — the open deal ' +
    'for a domain, or a deal by its id. The teammate must be on this team with their access intact. It ' +
    'changes the owner the board shows; nobody is notified, and nothing is sent.',
  shape: setDealOwnerShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The board's route, PATCH /api/deals/[id].
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot assign deals. ${NOTHING_CHANGED}`)
    }
    const byDomain = input.domain !== undefined && input.domain.trim() !== ''
    if (byDomain === (input.dealId !== undefined)) {
      return fail('invalid_state', `Say which deal: a domain for the company’s open deal, or a dealId — one of the two. ${NOTHING_CHANGED}`)
    }
    if ((input.ownerEmail !== undefined) === (input.clear === true)) {
      return fail('invalid_state', `Say who owns it: an ownerEmail, or clear: true to unassign it — one of the two. ${NOTHING_CHANGED}`)
    }

    let current: DealRow
    let domain: string
    if (input.dealId !== undefined) {
      const rows = await ctx.db
        .select({ deal: schema.deals, domain: schema.companies.domain })
        .from(schema.deals)
        .innerJoin(
          schema.companies,
          and(eq(schema.companies.id, schema.deals.companyId), eq(schema.companies.orgId, schema.deals.orgId)),
        )
        .where(and(eq(schema.deals.orgId, ctx.orgId), eq(schema.deals.id, input.dealId)))
        .limit(1)
      const row = rows[0]
      if (!row) return fail('not_found', `No such deal. ${NOTHING_CHANGED}`)
      current = row.deal
      domain = row.domain
    } else {
      const company = await companyFor(ctx, input.domain ?? '')
      if (!company.ok) return fail('not_found', `${company.message} ${NOTHING_CHANGED}`)
      const open = await openDealFor(ctx.db, ctx.orgId, company.id)
      if (!open) {
        return fail(
          'invalid_state',
          `${company.domain} has no open deal to assign; update_deal opens one. ${NOTHING_CHANGED}`,
        )
      }
      current = open
      domain = company.domain
    }

    let owner: { id: string; label: string } | null = null
    if (input.ownerEmail !== undefined) {
      owner = await assignableTeammate(ctx, input.ownerEmail)
      if (!owner) {
        // One sentence for nobody, another org's user and a revoked teammate:
        // the address is the only thing that crossed the boundary.
        return fail(
          'not_found',
          `Nobody with the address ${input.ownerEmail} can own a deal here: they are not on this team, or their ` +
            `access is revoked. ${NOTHING_CHANGED}`,
        )
      }
    }

    // The org check on the owner lives in setDealOwner too; it is the writer.
    const r = await setDealOwner(ctx.db, { orgId: ctx.orgId, dealId: current.id, ownerUserId: owner?.id ?? null })
    if (!r.ok) return fail('not_found', `${r.message} ${NOTHING_CHANGED}`)
    const deal = r.deal

    // The board's route writes this row beside the change, naming who: the
    // deal, the stage it is at, and the owner it now has.
    await appendAudit(ctx.db, {
      orgId: ctx.orgId,
      actor: 'agent',
      action: 'deal.updated',
      subjectType: 'deal',
      subjectId: deal.id,
      detail: { companyId: deal.companyId, from: current.stage, to: deal.stage, ownerUserId: deal.ownerUserId },
    }).catch(() => {})

    const previousOwnerUserId = current.ownerUserId
    await ctx.audit('agent.set_deal_owner', {
      dealId: deal.id,
      companyId: deal.companyId,
      ownerUserId: deal.ownerUserId,
      previousOwnerUserId,
    })

    const before =
      previousOwnerUserId === null
        ? 'it had no owner'
        : previousOwnerUserId === deal.ownerUserId
          ? 'it already was'
          : `it was ${await teammateLabel(ctx, previousOwnerUserId)}’s`
    const where = deal.closedAt ? `closed ${deal.stage}` : `at ${deal.stage}`
    const did = owner ? `Assigned the deal for ${domain} (deal ${deal.id}, ${where}) to ${owner.label}` : `Unassigned the deal for ${domain} (deal ${deal.id}, ${where})`
    return ok(
      { dealId: deal.id, domain, stage: deal.stage, closed: deal.closedAt !== null, ownerUserId: deal.ownerUserId, previousOwnerUserId },
      `${did} — ${before}. It changes the owner the board shows; nobody is notified. ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// complete_task
// ---------------------------------------------------------------------------

const completeTaskShape = {
  taskId: z.uuid().describe('The task, by its id.'),
}

/** PATCH /api/tasks/[id]'s 409, verbatim, with where it is done instead. */
const LINKEDIN_STEP =
  'A LinkedIn step is completed by sending the message and pressing "I sent it", which checks every send rule ' +
  'first. A person does that on /tasks; ticking it here would say the message went when no rule checked that it ' +
  `could. ${NOTHING_CHANGED}`

export const completeTask: AgencyToolSpec<typeof completeTaskShape> = {
  name: 'complete_task',
  description:
    'Mark a task done, by its id, in the name of the person you are helping. A task already done is left as ' +
    'it is. A LinkedIn step is never closed this way: it is done when a person sends the message and presses ' +
    '“I sent it” on /tasks, which checks every send rule first. Nothing is sent.',
  shape: completeTaskShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // PATCH /api/tasks/[id]'s gate.
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot change tasks. ${NOTHING_CHANGED}`)
    }
    // `done_by` names a person in this org (`tasks_done_has_who`, a same-org
    // key): the person whose chat this is — never an id the model gave.
    const me = principalUserId(ctx)
    const members = me
      ? await ctx.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.id, me), eq(schema.users.orgId, ctx.orgId), isNull(schema.users.revokedAt)))
          .limit(1)
      : []
    const member = members[0]
    if (!member) {
      return fail(
        'not_permitted',
        `The person you are helping is not an active member of this team, so a task cannot be marked done in their name. ${NOTHING_CHANGED}`,
      )
    }
    const byUserId = member.id

    const rows = await ctx.db
      .select({
        id: schema.tasks.id,
        kind: schema.tasks.kind,
        title: schema.tasks.title,
        companyId: schema.tasks.companyId,
        domain: schema.companies.domain,
      })
      .from(schema.tasks)
      .leftJoin(
        schema.companies,
        and(eq(schema.companies.id, schema.tasks.companyId), eq(schema.companies.orgId, schema.tasks.orgId)),
      )
      .where(and(eq(schema.tasks.orgId, ctx.orgId), eq(schema.tasks.id, input.taskId)))
      .limit(1)
    const task = rows[0]
    if (!task) return fail('not_found', `No such task. ${NOTHING_CHANGED}`)
    // Checked before anything is written, done or not, as the route does.
    if (task.kind === 'linkedin_send') return fail('invalid_state', LINKEDIN_STEP)

    const r = await tasksComplete(ctx.db, { orgId: ctx.orgId, id: task.id, byUserId, actor: 'agent', now: ctx.now() })
    if (!r.ok) return fail('not_found', `${r.message} ${NOTHING_CHANGED}`)

    await ctx.audit('agent.complete_task', { taskId: task.id, companyId: task.companyId, alreadyDone: r.alreadyDone })
    const named = `the task “${oneLine(task.title, 120)}”${task.domain ? ` about ${task.domain}` : ''} (task ${task.id})`
    const data = {
      taskId: task.id,
      domain: task.domain,
      alreadyDone: r.alreadyDone,
      doneAt: r.task.doneAt?.toISOString() ?? null,
      doneBy: r.task.doneBy,
    }
    if (r.alreadyDone) {
      return ok(
        data,
        `${named.charAt(0).toUpperCase()}${named.slice(1)} was already done` +
          `${r.task.doneAt ? ` (${when(r.task.doneAt)})` : ''}, so it was left as it was. ${NOTHING_SENT}`,
      )
    }
    return ok(
      data,
      `Marked ${named} done, in the name of the person you are helping: it shows as done by them, and the audit ` +
        `log records that the agent did it. ${NOTHING_SENT}`,
    )
  },
}
