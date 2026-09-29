// STUB — filled in wave 2 by consent-ledger-and-check-send
/**
 * The consent tools: what the send path would say about one person, and what
 * §2.1 has on record about them.
 *
 * Both are READS (`low` in `AGENCY_TOOL_RISK`). `check_send` runs the same
 * `previewSend` the contacts ledger reads — the sender's own facts and the
 * sender's own decision — and queues nothing; a "yes" from it is not a send
 * and not an approval. The shapes below are final; the owner above fills in
 * the handlers and keeps them.
 */
import { z } from 'zod'
import { fail, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const NOT_YET = 'This tool is not available in this revision.'

const checkSendShape = {
  domain: z.string().min(1).max(253).describe('The company the person is at.'),
  contactEmail: z.email().max(254).describe('Who, by their address on file.'),
  campaignName: z.string().min(1).max(120).describe('The campaign whose cap and quiet hours apply.'),
  /** Email and LinkedIn only: SMS and voice are refused here, below the gate, as well as by the classifier. */
  channel: z.enum(['email', 'linkedin']).optional().describe('Defaults to the campaign’s channel.'),
}

export const checkSend: AgencyToolSpec<typeof checkSendShape> = {
  name: 'check_send',
  description:
    'Run the send rules for one person under one campaign — suppression, consent, quiet hours in ' +
    'their timezone, the daily cap, the campaign status — and report the answer with the reason. ' +
    'A dry run: nothing is queued, nothing is sent, and a "yes" here is not an approval.',
  shape: checkSendShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const getConsentShape = {
  contactEmail: z.email().max(254).describe('The person, by their address on file.'),
}

export const getConsent: AgencyToolSpec<typeof getConsentShape> = {
  name: 'get_consent',
  description:
    'Read what is recorded about one person under §2.1: their consent per channel (granted, refused, ' +
    'or never asked — absence means no), and every suppression-list row that matches their address, ' +
    'domain, number or LinkedIn profile. A read; it changes nothing and sends nothing.',
  shape: getConsentShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}
