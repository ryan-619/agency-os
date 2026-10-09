/**
 * Quotes from chat (2026-10-08): a priced offer of the agency's services,
 * raised, read, edited and listed — the same functions the quote page calls.
 *
 * A quote is a DRAFT until a person marks it sent on its page, which is the
 * moment it can be shared; these tools never send one, never make its link
 * and never record a buyer's answer. So all four change only the agency's
 * own records, and run without a card.
 */
import { z } from 'zod'
import { QUOTE_UNITS, can, formatMoney, quoteLapsed, type QuoteItem } from '@agency/core'
import {
  findCompanyByDomain, quoteCreate, quoteItemsOf, quoteNeedsOf, quoteRead, quoteUpdate, quotesList, type QuoteRow,
} from '@agency/db'
import { normaliseDomain } from '@agency/scanner'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

const DRAFT_NOTE =
  'It is a DRAFT: nothing was sent. A person reviews it on its page (/quotes/<id>), marks it sent, then copies its link or ' +
  'drafts the email that carries it — that email waits on /approvals like every other.'

const lineShape = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).nullable().optional(),
  quantity: z.number().int().min(1).max(10_000).optional(),
  unit: z.enum(QUOTE_UNITS).optional(),
  unitPrice: z.number().int().min(0).max(100_000_000).describe('Whole rupees, before GST.'),
})

const linesFrom = (lines: readonly z.infer<typeof lineShape>[]): QuoteItem[] =>
  lines.map((l) => ({
    serviceId: null,
    name: l.name.trim(),
    description: l.description?.trim() ? l.description.trim() : null,
    quantity: l.quantity ?? 1,
    unit: l.unit ?? 'one_off',
    unitPrice: l.unitPrice,
  }))

function describe(q: QuoteRow, now: Date): string[] {
  const items = quoteItemsOf(q)
  const m = (n: number) => formatMoney(n, q.currency)
  return [
    `${q.number} · ${q.status}${q.status === 'sent' && quoteLapsed(q.validUntil, now) ? ' (validity passed)' : ''} · id ${q.id}`,
    `  "${q.title}" — valid until ${q.validUntil}`,
    ...items.map((i, n) => `  ${n + 1}. ${i.name} × ${i.quantity}${i.unit !== 'one_off' ? ` (${i.unit})` : ''} at ${m(i.unitPrice)} = ${m(i.quantity * i.unitPrice)}`),
    `  Subtotal ${m(q.subtotal)}${Number(q.taxRate) > 0 ? ` + GST ${Number(q.taxRate)}% ${m(q.taxAmount)}` : ' (no GST)'} = total ${m(q.total)}` +
      `${q.advanceAmount > 0 ? `; advance ${q.advancePercent}% = ${m(q.advanceAmount)}` : ''}`,
  ]
}

async function companyFor(ctx: ToolContext, domain: string) {
  return findCompanyByDomain(ctx.db, ctx.orgId, normaliseDomain(domain))
}

const createShape = {
  domain: z.string().min(1).max(253).describe('The company the quote is for, by its domain as the CRM has it.'),
  contactId: z.string().uuid().optional().describe('A contact at that company (from list_contacts) the quote is addressed to.'),
  title: z.string().max(200).optional(),
  intro: z.string().max(4000).optional().describe('Opening words above the lines.'),
  serviceIds: z.array(z.string().uuid()).max(30).optional().describe('Catalogue services (list_services) to quote, at their prices.'),
  lines: z.array(lineShape).max(30).optional().describe('Lines typed out instead, in whole rupees before GST.'),
}

export const createQuote: AgencyToolSpec<typeof createShape> = {
  name: 'create_quote',
  description:
    'Raise a DRAFT quote — a priced offer of the agency’s services — for a company. Lines come from `lines`, else the ' +
    'catalogue services named, else the services its observed needs point at (get_opportunities), at the catalogue’s ' +
    'prices; GST, the advance, validity and terms come from the business profile. It sends nothing: a person marks it ' +
    'sent and shares it from its page. Never invent a price — use the catalogue’s, or ask.',
  shape: createShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:write')) return fail('not_permitted', 'Your role cannot raise quotes.')
    const company = await companyFor(ctx, input.domain)
    if (!company) return fail('not_found', `No company with domain "${input.domain}" is in the CRM.`)
    const r = await quoteCreate(ctx.db, {
      orgId: ctx.orgId,
      companyId: company.id,
      contactId: input.contactId ?? null,
      title: input.title ?? null,
      intro: input.intro ?? null,
      serviceIds: input.serviceIds ?? null,
      items: input.lines ? linesFrom(input.lines) : null,
      createdBy: null,
      actor: 'agent',
      now: ctx.now(),
    })
    if (!r.ok) return fail(r.reason === 'not_found' || r.reason === 'no_company' ? 'not_found' : 'invalid_state', r.message)
    await ctx.audit('agent.create_quote', { quoteId: r.quote.id, companyId: company.id, lines: quoteItemsOf(r.quote).length })
    const empty = quoteItemsOf(r.quote).length === 0
    return ok(
      { quoteId: r.quote.id, number: r.quote.number },
      bounded([
        `Raised ${r.quote.number} for ${company.name || company.domain}:`,
        ...describe(r.quote, ctx.now()),
        ...(empty ? ['  It has no lines yet: no catalogue service answers what is on record. Add lines with update_quote, or on its page.'] : []),
        DRAFT_NOTE.replace('<id>', r.quote.id),
      ]),
    )
  },
}

const getShape = { quoteId: z.string().uuid() }

export const getQuote: AgencyToolSpec<typeof getShape> = {
  name: 'get_quote',
  description: 'Read one quote: its lines, totals with GST, advance, validity, status and the needs it answers. A read.',
  shape: getShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:read')) return fail('not_permitted', 'Your role cannot read quotes.')
    const q = await quoteRead(ctx.db, ctx.orgId, input.quoteId)
    if (!q) return fail('not_found', 'No such quote.')
    await ctx.audit('agent.get_quote', { quoteId: q.id })
    const needs = quoteNeedsOf(q)
    return ok(
      { quoteId: q.id, status: q.status },
      bounded([
        ...describe(q, ctx.now()),
        ...(needs.length ? [`  Answers: ${needs.map((n) => n.label).join('; ')}`] : []),
        ...(q.terms ? [`  Terms: ${q.terms.slice(0, 300)}`] : []),
        'A read; nothing was changed.',
      ]),
    )
  },
}

const updateShape = {
  quoteId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  intro: z.string().max(4000).optional(),
  lines: z.array(lineShape).max(30).optional().describe('Replaces every line.'),
  advancePercent: z.number().int().min(0).max(100).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, not in the past.'),
  terms: z.string().max(4000).optional(),
}

export const updateQuote: AgencyToolSpec<typeof updateShape> = {
  name: 'update_quote',
  description:
    'Change a quote’s title, opening words, lines, advance, validity or terms. Totals are recomputed with the profile’s GST. ' +
    'A quote already SENT becomes a draft again and its links stop opening, so a person must send it again — say so. ' +
    'An accepted, declined or withdrawn quote cannot be changed.',
  shape: updateShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:write')) return fail('not_permitted', 'Your role cannot change quotes.')
    const r = await quoteUpdate(ctx.db, {
      orgId: ctx.orgId,
      quoteId: input.quoteId,
      patch: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.intro !== undefined ? { intro: input.intro } : {}),
        ...(input.lines ? { items: linesFrom(input.lines) } : {}),
        ...(input.advancePercent !== undefined ? { advancePercent: input.advancePercent } : {}),
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
        ...(input.terms !== undefined ? { terms: input.terms } : {}),
      },
      actor: 'agent',
      now: ctx.now(),
    })
    if (!r.ok) return fail(r.reason === 'not_found' ? 'not_found' : 'invalid_state', r.message)
    await ctx.audit('agent.update_quote', { quoteId: r.quote.id, revisedFromSent: r.revised === true })
    return ok(
      { quoteId: r.quote.id, revised: r.revised === true },
      bounded([
        `Updated ${r.quote.number}:`,
        ...describe(r.quote, ctx.now()),
        r.revised
          ? 'It had been sent: it is a DRAFT again and the link the buyer had no longer opens. A person must mark it sent again. Nothing was sent.'
          : 'Nothing was sent.',
      ]),
    )
  },
}

const listShape = {
  domain: z.string().max(253).optional(),
  status: z.enum(['draft', 'sent', 'accepted', 'declined', 'withdrawn']).optional(),
}

export const listQuotes: AgencyToolSpec<typeof listShape> = {
  name: 'list_quotes',
  description: 'List quotes, newest first — for one company, or of one status — with each one’s number, status, total and id. A read.',
  shape: listShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:read')) return fail('not_permitted', 'Your role cannot read quotes.')
    let companyId: string | undefined
    if (input.domain) {
      const company = await companyFor(ctx, input.domain)
      if (!company) return fail('not_found', `No company with domain "${input.domain}" is in the CRM.`)
      companyId = company.id
    }
    const rows = await quotesList(ctx.db, { orgId: ctx.orgId, ...(companyId ? { companyId } : {}), ...(input.status ? { status: input.status } : {}), limit: 30 })
    await ctx.audit('agent.list_quotes', { count: rows.length })
    if (rows.length === 0) return ok({ quotes: [] }, 'No quotes match. A read; nothing was changed.')
    const now = ctx.now()
    return ok(
      { quotes: rows.map((q) => ({ id: q.id, number: q.number, status: q.status })) },
      bounded([
        `${rows.length} ${rows.length === 1 ? 'quote' : 'quotes'}:`,
        ...rows.map(
          (q) =>
            `  ${q.number} · ${q.companyName || q.companyDomain} · ${q.status}${q.status === 'sent' && quoteLapsed(q.validUntil, now) ? ' (lapsed)' : ''}` +
            ` · ${formatMoney(q.total, q.currency)} · id ${q.id}`,
        ),
        'A read; nothing was changed.',
      ]),
    )
  },
}
