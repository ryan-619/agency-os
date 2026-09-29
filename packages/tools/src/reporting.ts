// STUB — filled in wave 3 by reporting-and-task-tools
/**
 * The reporting tools: the pipeline's numbers, a company's timeline, the
 * compliance page's counts, and text search across the CRM.
 *
 * All four are READS (`low`). Each reads the same rows the corresponding page
 * reads and nothing else — a number a tool reports that the page does not
 * would be a second opinion. `orgId` comes from the context, never from an
 * argument (spec.ts). The shapes below are final; the owner above fills in
 * the handlers and keeps them.
 */
import { z } from 'zod'
import { fail, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const NOT_YET = 'This tool is not available in this revision.'

const pipelineMetricsShape = {
  sinceDays: z.number().int().min(7).max(365).optional().describe('The window, in days. Default 90.'),
}

export const getPipelineMetrics: AgencyToolSpec<typeof pipelineMetricsShape> = {
  name: 'get_pipeline_metrics',
  description:
    'Read the pipeline’s own numbers over a window: how many deals reached each stage, conversion ' +
    'between stages, time spent in each, and the win rate — computed from the audit log’s record of ' +
    'every stage move, not from a counter. A read; nothing is sent.',
  shape: pipelineMetricsShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const companyTimelineShape = {
  domain: z.string().min(1).max(253).describe('The company.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many events, newest first. Default 25.'),
}

export const getCompanyTimeline: AgencyToolSpec<typeof companyTimelineShape> = {
  name: 'get_company_timeline',
  description:
    'Read everything that happened to one company, newest first: scans, messages in both directions, ' +
    'replies, deal moves, meetings, proposals, notes and tasks — from the records that hold each, ' +
    'never from a summary somebody wrote. A read; nothing is sent.',
  shape: companyTimelineShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

export const getComplianceSummary: AgencyToolSpec<Record<string, never>> = {
  name: 'get_compliance_summary',
  description:
    'Read the counts the compliance page shows: consent rows per channel, suppressions by source, ' +
    'refusals by rule, calls that did and did not disclose the AI, and how much evidence is stale. ' +
    'The same rows the page reads, so the two cannot disagree. A read; nothing is sent.',
  shape: {},
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const searchCrmShape = {
  query: z.string().min(2).max(100).describe('Text to look for: a name, a domain, a subject line.'),
  sections: z
    .array(z.enum(['companies', 'contacts', 'deals', 'campaigns', 'meetings', 'proposals', 'touches']))
    .optional()
    .describe('Which kinds of record to search. Default: all of them.'),
}

export const searchCrm: AgencyToolSpec<typeof searchCrmShape> = {
  name: 'search_crm',
  description:
    'Search companies, people, deals, campaigns, meetings, proposals and messages by text, within ' +
    'the org of the person you are helping and nothing beyond it. Use it when you have a name or a ' +
    'phrase and not a domain; use get_company once you have the domain. A read; nothing is sent.',
  shape: searchCrmShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}
