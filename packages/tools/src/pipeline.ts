/**
 * The pipeline tools (PROMPT.md §6, §8.6) — the three Phase 2 withheld.
 *
 * `get_pipeline`, `update_deal` and `book_meeting` are listed in §6. Phase 2
 * did not ship them because nothing wrote the deals table yet, and a tool
 * that reliably returns `[]` teaches the model a false shape of the business.
 * Phase 4's send path writes deals now, and Phase 5 is the pipeline.
 *
 * Risk, from `AGENCY_TOOL_RISK`: `get_pipeline` is low (a read); the other
 * two are medium — they change internal state, nothing leaves the building —
 * so the gate raises a card and a person decides, without the turn parking
 * for long. `book_meeting` RECORDS a meeting and moves the deal. It does not
 * send an invitation and it does not touch a calendar: the calendar is a
 * connector (§8.6), reached like any other connector, through the gate.
 */
import { z } from 'zod'
import { DEAL_STAGES, type DealStage } from '@agency/db'
import {
  advanceDeal, createMeeting, findCompanyByDomain, openDealFor, setDealStage, type AgencyDb,
} from '@agency/db'
import { normaliseDomain } from '@agency/scanner'
import * as schema from '@agency/db/schema'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { bounded, fail, ok, type AgencyToolSpec, type ToolOutcome } from './spec.js'
import { instantFrom } from './instant.js'

// ---------------------------------------------------------------------------
// get_pipeline
// ---------------------------------------------------------------------------

const pipelineShape = {
  stage: z.enum(DEAL_STAGES as [DealStage, ...DealStage[]]).optional().describe('Only deals at this stage.'),
  limit: z.number().int().min(1).max(100).optional(),
}

export const getPipeline: AgencyToolSpec<typeof pipelineShape> = {
  name: 'get_pipeline',
  description:
    'Read the deal pipeline: every open deal with its company, stage, next action and when it was ' +
    'last touched. A company with no deal is a company nobody has done anything about yet — it is ' +
    'not listed here; use search_companies for those.',
  shape: pipelineShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const rows = await ctx.db
      .select({
        dealId: schema.deals.id,
        domain: schema.companies.domain,
        name: schema.companies.name,
        stage: schema.deals.stage,
        nextAction: schema.deals.nextAction,
        nextActionAt: schema.deals.nextActionAt,
        valueCents: schema.deals.valueCents,
        updatedAt: schema.deals.updatedAt,
        createdAt: schema.deals.createdAt,
      })
      .from(schema.deals)
      .innerJoin(schema.companies, eq(schema.companies.id, schema.deals.companyId))
      .where(
        and(
          eq(schema.deals.orgId, ctx.orgId),
          isNull(schema.deals.closedAt),
          ...(input.stage ? [eq(schema.deals.stage, input.stage)] : []),
        ),
      )
      .orderBy(asc(schema.deals.stage), asc(schema.deals.createdAt))
      .limit(input.limit ?? 50)

    await ctx.audit('agent.get_pipeline', { stage: input.stage ?? null, returned: rows.length })
    const lines = rows.map(
      (r) =>
        `${r.stage.padEnd(9)} ${r.domain}${r.name ? ` (${r.name})` : ''}${r.nextAction ? ` — next: ${r.nextAction}` : ''}`,
    )
    return ok(
      rows.map((r) => ({
        dealId: r.dealId,
        domain: r.domain,
        name: r.name,
        stage: r.stage,
        nextAction: r.nextAction,
        nextActionAt: r.nextActionAt?.toISOString() ?? null,
        valueCents: r.valueCents,
        lastTouched: (r.updatedAt ?? r.createdAt).toISOString(),
      })),
      rows.length === 0
        ? 'No open deals. Nothing has been sent to anyone yet, or everything is closed.'
        : bounded(lines),
    )
  },
}

// ---------------------------------------------------------------------------
// update_deal
// ---------------------------------------------------------------------------

const updateDealShape = {
  domain: z.string().min(1).max(253).describe('The company whose deal to change.'),
  stage: z.enum(DEAL_STAGES as [DealStage, ...DealStage[]]).optional().describe('Move to this stage.'),
  nextAction: z.string().max(300).optional().describe('What should happen next, in one line.'),
  lostReason: z.string().max(500).optional().describe('Required when the stage is "lost".'),
}

export const updateDeal: AgencyToolSpec<typeof updateDealShape> = {
  name: 'update_deal',
  description:
    'Move a company’s deal to another stage or set its next action. Creates the deal if the company ' +
    'has none. Moving to "lost" needs a reason. This changes nothing outside the CRM — it does not ' +
    'send anything or book anything.',
  shape: updateDealShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const domain = normaliseDomain(input.domain)
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)
    if (!input.stage && input.nextAction === undefined) {
      return fail('invalid_state', 'Say what to change: a stage, a next action, or both.')
    }
    if (input.stage === 'lost' && !input.lostReason?.trim()) {
      return fail('invalid_state', 'Moving a deal to lost needs a reason — it is the only thing anyone learns from one.')
    }

    let deal = await openDealFor(ctx.db, ctx.orgId, company.id)
    let moved = 'unchanged'
    if (input.stage) {
      const closes = input.stage === 'won' || input.stage === 'lost'
      if (!deal) {
        // `advanceDeal` moves a stage; it never stamps `closed_at`. Creating
        // straight at `won` or `lost` therefore left an OPEN deal reading a
        // closed stage — which `deals_one_open_per_company` then counts as
        // the company's open deal forever — and threw away `lostReason`,
        // the only thing anyone learns from a lost deal. So a company with
        // no deal is given an open one and it is closed below, in the same
        // call, by the function that owns closing.
        const created = await advanceDeal(ctx.db, {
          orgId: ctx.orgId,
          companyId: company.id,
          to: closes ? 'new' : input.stage,
          nextAction: input.nextAction ?? null,
        })
        deal = created.deal
        moved = created.outcome
      }
      if (closes || deal.stage !== input.stage) {
        const set = await setDealStage(ctx.db, {
          orgId: ctx.orgId, dealId: deal.id, stage: input.stage, lostReason: input.lostReason ?? null, now: ctx.now(),
        })
        deal = set ?? deal
        moved = moved === 'created' ? 'created' : 'set'
      }
    }
    if (input.nextAction !== undefined && deal) {
      const rows = await ctx.db
        .update(schema.deals)
        .set({ nextAction: input.nextAction.trim() || null })
        .where(and(eq(schema.deals.id, deal.id), eq(schema.deals.orgId, ctx.orgId)))
        .returning()
      deal = rows[0] ?? deal
    }
    if (!deal) return fail('invalid_state', 'The deal could not be updated.')

    await ctx.audit('agent.update_deal', {
      domain, dealId: deal.id, stage: deal.stage, moved, nextAction: deal.nextAction,
    })
    return ok(
      { dealId: deal.id, domain, stage: deal.stage, nextAction: deal.nextAction, closed: deal.closedAt !== null },
      `${domain}: stage ${deal.stage}${deal.nextAction ? `, next: ${deal.nextAction}` : ''}${
        deal.closedAt ? ' (closed)' : ''
      }.`,
    )
  },
}

// ---------------------------------------------------------------------------
// book_meeting
// ---------------------------------------------------------------------------

const bookMeetingShape = {
  domain: z.string().min(1).max(253).describe('The company the meeting is with.'),
  contactEmail: z.string().max(254).optional().describe('Who at the company, if known.'),
  startsAt: z.string().describe('When it starts, as an ISO 8601 instant, e.g. 2026-09-18T14:00:00Z.'),
  timeZone: z.string().min(1).max(64).describe('The IANA zone the time was agreed in, e.g. Europe/London.'),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  title: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
}

export const bookMeeting: AgencyToolSpec<typeof bookMeetingShape> = {
  name: 'book_meeting',
  description:
    'Record a meeting with a company and move its deal to the meeting stage. This does NOT send an ' +
    'invitation or create a calendar event — a person does that, or the calendar connector does when ' +
    'one is enabled. Use it once a time has actually been agreed with the person.',
  shape: bookMeetingShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const domain = normaliseDomain(input.domain)
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)

    // Insist on the ISO shape, and on a date that exists, before parsing:
    // V8's `new Date()` accepts a surprising range of strings ("Thursday at
    // 2" among them) and rolls 30 February to 2 March, each a real, wrong
    // instant (instant.ts).
    const startsAt = instantFrom(input.startsAt)
    if (startsAt === null) {
      return fail('invalid_state', `"${input.startsAt}" is not an ISO 8601 instant like 2026-09-18T14:00:00Z, on a date that exists.`)
    }

    let contactId: string | null = null
    if (input.contactEmail) {
      const wanted = input.contactEmail.trim().toLowerCase()
      const rows = await ctx.db
        .select({ id: schema.contacts.id, email: schema.contacts.email })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.orgId, ctx.orgId), eq(schema.contacts.companyId, company.id)))
      const match = rows.find((r) => r.email?.toLowerCase() === wanted)
      if (!match) {
        return fail('not_found', `No contact with the address ${wanted} is recorded at ${domain}. Add them first.`)
      }
      contactId = match.id
    }

    const result = await createMeeting(ctx.db, {
      orgId: ctx.orgId,
      companyId: company.id,
      contactId,
      title: input.title ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + (input.durationMinutes ?? 30) * 60_000),
      timeZone: input.timeZone,
      source: 'agent',
      notes: input.notes ?? null,
      createdBy: ctx.principal.id,
      actor: 'agent',
    })
    if (!result.ok) return fail('invalid_state', result.message)

    await ctx.audit('agent.book_meeting', {
      domain, meetingId: result.meeting.id, startsAt: startsAt.toISOString(), timeZone: input.timeZone,
    })
    return ok(
      { meetingId: result.meeting.id, domain, startsAt: startsAt.toISOString(), timeZone: input.timeZone, deal: result.deal },
      `Recorded a meeting with ${domain} at ${startsAt.toISOString()} (${input.timeZone}). The deal is at ` +
        `"${result.deal.split(':')[1]}". No invitation was sent.`,
    )
  },
}

export type { AgencyDb }
