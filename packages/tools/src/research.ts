/**
 * Research about a company, with its sources (0028), from chat.
 *
 * `record_research` writes what the assistant found out — through a
 * research connector, a search, a page it read — as claims with the page
 * each came from, so a person reads the claim beside its source and opens
 * it. An internal write that runs at once: nothing is sent, nothing is
 * scored, and nothing here is evidence (§2.2) — the prompt says so, the
 * company page says so above the list, and `get_company` names it apart
 * from the scan. `get_research` reads it back. A claim is bounded, a source
 * is an https page on the public web, and a claim already on file from the
 * same page is skipped, not written twice.
 */
import { z } from 'zod'
import { RESEARCH_CLAIM_MAX, RESEARCH_PER_CALL, RESEARCH_SOURCE_MAX, RESEARCH_TITLE_MAX, can } from '@agency/core'
import { findCompanyByDomain, researchFor, researchRecord } from '@agency/db'
import { normaliseDomain } from '@agency/scanner'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

const NOT_EVIDENCE =
  'Research is what a page said, not what the scanner observed: show it as research with its source, never as a finding, and quote none of it to the company.'

async function companyFor(ctx: ToolContext, input: string) {
  const domain = normaliseDomain(input)
  if (!domain) return null
  return findCompanyByDomain(ctx.db, ctx.orgId, domain)
}

const recordShape = {
  domain: z.string().min(1).max(253).describe('The company, by domain.'),
  facts: z
    .array(
      z.object({
        claim: z.string().min(1).max(RESEARCH_CLAIM_MAX).describe('What the page says, in one sentence, in your own words.'),
        sourceUrl: z.string().min(8).max(RESEARCH_SOURCE_MAX).describe('The https address of the page it came from.'),
        sourceTitle: z.string().max(RESEARCH_TITLE_MAX).optional().describe('The page’s title, if known.'),
      }),
    )
    .min(1)
    .max(RESEARCH_PER_CALL)
    .describe(`Up to ${RESEARCH_PER_CALL} claims, each with the page it came from.`),
}

export const recordResearch: AgencyToolSpec<typeof recordShape> = {
  name: 'record_research',
  description:
    'Record what you found out about a company — from a research connector, a search or a page you read — as ' +
    'claims each with the https page it came from, so a person can read the claim beside its source. Research, ' +
    'never evidence: it is shown apart from the scan and quoted to nobody. A claim already on file from the same ' +
    'page is skipped. Changes the agency’s own records only; nothing is sent.',
  shape: recordShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:write')) return fail('not_permitted', 'The person you are helping cannot change companies.')
    const company = await companyFor(ctx, input.domain)
    if (!company) return fail('not_found', `No company with domain "${input.domain}" is in the CRM. Add it first (add_company).`)
    const r = await researchRecord(ctx.db, { orgId: ctx.orgId, companyId: company.id, facts: input.facts, recordedBy: null, actor: 'agent' })
    if (!r.ok) return fail(r.reason === 'not_found' ? 'not_found' : 'invalid_state', `${r.message} Nothing was recorded.`)
    await ctx.audit('agent.record_research', { companyId: company.id, recorded: r.recorded, skipped: r.skipped })
    return ok(
      { domain: company.domain, recorded: r.recorded, skipped: r.skipped, ids: r.ids },
      `Recorded ${r.recorded} research claim${r.recorded === 1 ? '' : 's'} on ${company.domain}` +
        `${r.skipped ? ` (${r.skipped} already on file from the same page, skipped)` : ''}. ${NOT_EVIDENCE} Nothing was sent.`,
    )
  },
}

const getShape = {
  domain: z.string().min(1).max(253).describe('The company, by domain.'),
}

export const getResearch: AgencyToolSpec<typeof getShape> = {
  name: 'get_research',
  description:
    'Read the research on file about a company: each claim with the page it came from, who recorded it and when. ' +
    'Research, never evidence — quote none of it to the company. A read.',
  shape: getShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:read')) return fail('not_permitted', 'The person you are helping cannot read companies.')
    const company = await companyFor(ctx, input.domain)
    if (!company) return fail('not_found', `No company with domain "${input.domain}" is in the CRM.`)
    const rows = await researchFor(ctx.db, ctx.orgId, company.id)
    await ctx.audit('agent.get_research', { companyId: company.id, returned: rows.length })
    if (rows.length === 0) return ok({ domain: company.domain, research: [] }, `No research is on file about ${company.domain}. A read; nothing was changed.`)
    return ok(
      {
        domain: company.domain,
        research: rows.map((r) => ({ id: r.id, claim: r.claim, sourceUrl: r.sourceUrl, sourceTitle: r.sourceTitle, recordedAt: r.createdAt.toISOString(), recordedBy: r.recordedBy ? 'person' : 'agent' })),
      },
      bounded([
        `${rows.length} research claim${rows.length === 1 ? '' : 's'} on file about ${company.domain}, newest first:`,
        ...rows.map((r) => `  ${r.createdAt.toISOString().slice(0, 10)}  ${r.claim} — ${r.sourceTitle ? `${r.sourceTitle}, ` : ''}${r.sourceUrl} (${r.recordedBy ? r.recordedByName || r.recordedByEmail || 'a teammate' : 'the agent'})`),
        `${NOT_EVIDENCE} A read; nothing was changed.`,
      ]),
    )
  },
}
