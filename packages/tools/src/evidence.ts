// STUB — filled in wave 3 by evidence-and-reply-tools
/**
 * The evidence tools: a company's scan history, what changed between its two
 * most recent scans, and which companies' evidence can no longer be quoted.
 *
 * All three are READS (`low`). §2.2 governs them as it governs `get_company`:
 * a signal a scan could not observe is "not compared", never "changed", and
 * freshness is derived from the scan's `ran_at`, never read from the cached
 * `findings.stale`. The shapes below are final; the owner above fills in the
 * handlers and keeps them.
 */
import { z } from 'zod'
import { fail, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const NOT_YET = 'This tool is not available in this revision.'

const scanHistoryShape = {
  domain: z.string().min(1).max(253).describe('The company.'),
  limit: z.number().int().min(1).max(20).optional().describe('How many scans, newest first. Default 10.'),
}

export const getScanHistory: AgencyToolSpec<typeof scanHistoryShape> = {
  name: 'get_scan_history',
  description:
    'Read every scan of a company, newest first, with the score that was computed from each one and ' +
    'whether the scan reached the site. Use it to see how a company’s posture has moved over time; ' +
    'use get_company for the current findings. A read; nothing is sent.',
  shape: scanHistoryShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const evidenceChangesShape = {
  domain: z.string().min(1).max(253).describe('The company.'),
}

export const getEvidenceChanges: AgencyToolSpec<typeof evidenceChangesShape> = {
  name: 'get_evidence_changes',
  description:
    'Compare the two most recent SUCCESSFUL scans of a company signal by signal: what was fixed, what ' +
    'appeared, and what could not be observed on one of them and so is not compared. Only what the ' +
    'scanner actually saw is reported (§2.2). A read; nothing is sent.',
  shape: evidenceChangesShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const staleCompaniesShape = {
  limit: z.number().int().min(1).max(100).optional().describe('How many companies. Default 25.'),
}

export const getStaleCompanies: AgencyToolSpec<typeof staleCompaniesShape> = {
  name: 'get_stale_companies',
  description:
    'List the companies whose evidence may not be quoted — stale by the ICP’s freshness window, ' +
    'unreachable on the last scan, or never scanned — and why, so a re-scan can be asked for before ' +
    'anything is drafted from them. A read; it scans nothing and sends nothing.',
  shape: staleCompaniesShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}
