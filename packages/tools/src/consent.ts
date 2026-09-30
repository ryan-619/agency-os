/**
 * The consent tools: what the send path would say about one person, and what
 * §2.1 has on record about them.
 *
 * Both are READS (`low` in `AGENCY_TOOL_RISK`). `check_send` runs the same
 * `previewSend` the contacts ledger reads — the sender's own facts and the
 * sender's own decision — and queues nothing; a "yes" from it is not a send
 * and not an approval. `get_consent` reads `consentLedgerFor`, the function
 * the /contacts page reads, so the model and the page cannot describe one
 * person two ways.
 *
 * Neither puts an address, a number or a profile into the model's context
 * that the model did not already give it. A suppression match is reported
 * by its KIND and the path that recorded it — "domain (reply)" — because the
 * value is somebody's opt-out, and the model has no use for it beyond the
 * fact that it exists.
 */
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { normaliseEmail } from '@agency/core'
import { consentLedgerFor, findCompanyByDomain, previewSend, type ConsentLedger } from '@agency/db'
import * as schema from '@agency/db/schema'
import { normaliseDomain } from '@agency/scanner'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

/** The words the /contacts page uses, so the model repeats the page's sentence. */
function consentWords(c: ConsentLedger['channels'][number]): string {
  if (c.state === 'granted') {
    const when = c.recordedAt ? `, ${c.recordedAt.toISOString().slice(0, 10)}` : ''
    return `granted (${c.source ?? 'no source'}${when})`
  }
  if (c.state === 'refused') return 'refused — will not be asked again'
  return c.channel === 'email' ? 'never asked — cold email allowed' : 'never asked — cannot be used'
}

/** `unparseable` is its own answer and never reads as clear (§2.1). */
const STANDING_WORDS: Record<ConsentLedger['suppression']['email'], string> = {
  suppressed: 'on the suppression list',
  clear: 'clear',
  unparseable: 'could not be parsed — treated as suppressed',
  none: 'nothing on file',
}

/**
 * A pause, in words the model can act on.
 *
 * The send path models a pause as a revoked consent — to this person, right
 * now, the answer is no — so the DECISION reads `consent_revoked`. Repeated
 * to the model as it stands, that told the agent an interested prospect who
 * had simply replied "declined email … nobody may approve past this", which
 * it then told the user. Found by review. A reply pause is lifted by a
 * person answering from /inbox or resuming them, and says so; any other
 * pause (an unsubscribe, an erasure that did not complete, a person's own)
 * is quoted with its reason and never called "not a refusal", because it
 * may be exactly that.
 */
function pauseWords(reason: string | null, channel: string): string {
  const why = (reason ?? 'no reason recorded').slice(0, 200)
  if (why.startsWith('replied')) {
    return (
      `paused: they replied (${why}); every campaign stops for them until a person answers from /inbox ` +
      `(which resumes them) or resumes them on /contacts. This is not a refusal of ${channel}. ` +
      'get_replies shows what they said.'
    )
  }
  return (
    `paused (${why}): every campaign stops for them until a person reads why and resumes them on /contacts. ` +
    'Approving a draft does not lift a pause.'
  )
}

/** The campaign by name, in this org. Names are unique per org (`campaigns_org_name_key`). */
async function campaignNamed(ctx: ToolContext, name: string) {
  const rows = await ctx.db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      channel: schema.campaigns.channel,
      status: schema.campaigns.status,
    })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, ctx.orgId), sql`lower(${schema.campaigns.name}) = lower(${name.trim()})`))
    .limit(5)
  // Exact spelling first; a case-insensitive match only when it is the only one.
  return rows.find((r) => r.name === name.trim()) ?? (rows.length === 1 ? rows[0]! : null)
}

// ---------------------------------------------------------------------------
// check_send
// ---------------------------------------------------------------------------

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
    'Run the send rules for one person under one campaign — suppression, consent, a paused contact, a ' +
    'bounced address, stale evidence, quiet hours in their timezone, the daily cap, the campaign status — ' +
    'and report the answer with the reason, for a message written now. ' +
    'A dry run that queues nothing: nothing is sent, and a "yes" here is not an approval.',
  shape: checkSendShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const domain = normaliseDomain(input.domain)
    if (!domain) return fail('not_found', `"${input.domain}" is not a domain.`)
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)

    const email = normaliseEmail(input.contactEmail)
    if (!email) return fail('not_found', `"${input.contactEmail}" could not be read as an email address.`)
    const contacts = await ctx.db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.orgId, ctx.orgId),
          eq(schema.contacts.companyId, company.id),
          sql`lower(${schema.contacts.email}) = ${email}`,
        ),
      )
      .limit(1)
    const contact = contacts[0]
    if (!contact) return fail('not_found', `Nobody with the address ${email} is recorded at ${domain}.`)

    const campaign = await campaignNamed(ctx, input.campaignName)
    if (!campaign) return fail('not_found', `No campaign named "${input.campaignName}" is in the CRM.`)
    if (input.channel && input.channel !== campaign.channel) {
      return fail(
        'invalid_state',
        `"${campaign.name}" is a ${campaign.channel} campaign, so it cannot answer for ${input.channel}: ` +
          'the cap, the quiet hours and the consent that apply are the campaign’s channel’s. Nothing was queued.',
      )
    }

    const preview = await previewSend(ctx.db, {
      orgId: ctx.orgId,
      contactId: contact.id,
      campaignId: campaign.id,
      now: ctx.now(),
    })
    if (!preview.ok) return fail('not_found', preview.message)
    const { decision, wouldNeedApproval, facts } = preview

    await ctx.audit('agent.check_send', { domain, contactId: contact.id, campaignId: campaign.id, code: decision.code })

    const approval = wouldNeedApproval
      ? 'A real message under this campaign would still wait for a person to approve it.'
      : 'This campaign sends without a per-message approval.'
    // The pause speaks first when it IS the reason: the decision's
    // consent_revoked is then the pause's stand-in, not a refusal anyone
    // recorded. A suppression, a recorded refusal or anything else earlier
    // in the order is reported as itself, with the pause beside it.
    const pauseIsTheReason =
      facts.paused && !decision.allowed && decision.code === 'consent_revoked' && facts.consentRecorded?.granted !== false
    const summary = decision.allowed
      ? `send_now: every rule passes for ${email} under "${campaign.name}" right now. ${approval} Nothing was queued.`
      : pauseIsTheReason
        ? `${pauseWords(facts.pausedReason, campaign.channel)} Nothing was queued.`
        : `${decision.code}: ${decision.reason.replace(/[.\s]+$/, '')}. ` +
          (decision.humanCanResolve ? 'A person could resolve this. ' : 'Nobody may approve past this. ') +
          (facts.paused ? `They are also paused (${(facts.pausedReason ?? 'no reason recorded').slice(0, 200)}). ` : '') +
          'Nothing was queued.'

    return ok(
      {
        domain,
        contactId: contact.id,
        campaign: { id: campaign.id, name: campaign.name, channel: campaign.channel, status: campaign.status },
        allowed: decision.allowed,
        code: decision.code,
        reason: decision.allowed ? null : decision.reason,
        humanCanResolve: decision.allowed ? null : decision.humanCanResolve,
        wouldNeedApproval,
        facts: {
          suppressed: facts.suppressed,
          recipientReadable: facts.suppressionKeys !== null,
          // As RECORDED — a pause is not somebody's answer, and get_consent
          // (and the /contacts ledger) would say "never asked" of the same person.
          consent: facts.consentRecorded ? (facts.consentRecorded.granted ? 'granted' : 'refused') : 'never_asked',
          paused: facts.paused,
          pausedReason: facts.pausedReason,
          evidenceStale: facts.evidenceStale,
          recipientTimeZone: facts.recipientTimeZone,
          zoneFrom: facts.zoneFrom,
          quietHours: `${facts.quietStart}–${facts.quietEnd}`,
          sentToday: facts.sentToday,
          dailyCap: facts.dailyCap,
        },
        queued: false,
      },
      summary,
    )
  },
}

// ---------------------------------------------------------------------------
// get_consent
// ---------------------------------------------------------------------------

const getConsentShape = {
  contactEmail: z.email().max(254).describe('The person, by their address on file.'),
}

export const getConsent: AgencyToolSpec<typeof getConsentShape> = {
  name: 'get_consent',
  description:
    'Read what is recorded about one person under §2.1: their consent per channel (granted, refused, ' +
    'or never asked — absence means no), and every suppression-list row that matches their address, ' +
    'domain, number or LinkedIn profile. A read that queues nothing; it changes nothing and sends nothing.',
  shape: getConsentShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const email = normaliseEmail(input.contactEmail)
    if (!email) return fail('not_found', `"${input.contactEmail}" could not be read as an email address.`)
    // One address is one contact per org: `contacts_org_email_key` is on (org_id, lower(email)).
    const rows = await ctx.db
      .select({
        id: schema.contacts.id,
        pausedAt: schema.contacts.pausedAt,
        domain: schema.companies.domain,
      })
      .from(schema.contacts)
      .innerJoin(
        schema.companies,
        and(eq(schema.companies.id, schema.contacts.companyId), eq(schema.companies.orgId, ctx.orgId)),
      )
      .where(and(eq(schema.contacts.orgId, ctx.orgId), sql`lower(${schema.contacts.email}) = ${email}`))
      .limit(1)
    const contact = rows[0]
    if (!contact) return fail('not_found', `Nobody with the address ${email} is in the CRM.`)

    const ledger = await consentLedgerFor(ctx.db, ctx.orgId, contact.id)
    if (!ledger) return fail('not_found', `Nobody with the address ${email} is in the CRM.`)

    await ctx.audit('agent.get_consent', { contactId: contact.id })

    const s = ledger.suppression
    const lines = [
      `${email} at ${contact.domain}${contact.pausedAt ? ' — paused: nothing is sent to them until a person resumes them' : ''}`,
      'Consent (absence is no):',
      ...ledger.channels.map((c) => `  ${c.channel}: ${consentWords(c)}`),
      'Suppression list:',
      `  email address: ${STANDING_WORDS[s.email]}`,
      `  phone: ${STANDING_WORDS[s.phone]}`,
      `  LinkedIn: ${STANDING_WORDS[s.linkedin]}`,
      ...(s.matches.length > 0
        ? [`  matched by: ${s.matches.map((m) => `${m.kind}${m.source ? ` (${m.source})` : ''}`).join(', ')}`]
        : []),
      'Nothing was changed and nothing was queued.',
    ]

    return ok(
      {
        contactId: contact.id,
        domain: contact.domain,
        paused: contact.pausedAt !== null,
        channels: ledger.channels.map((c) => ({
          channel: c.channel,
          state: c.state,
          source: c.source,
          recordedAt: c.recordedAt ? c.recordedAt.toISOString() : null,
        })),
        suppression: {
          email: s.email,
          phone: s.phone,
          linkedin: s.linkedin,
          // By kind and recording path only — never the value.
          matches: s.matches.map((m) => ({ kind: m.kind, source: m.source })),
        },
      },
      bounded(lines),
    )
  },
}
