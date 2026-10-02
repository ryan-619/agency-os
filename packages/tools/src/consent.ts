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
import { normaliseEmail, type PauseReasonClass } from '@agency/core'
import { consentLedgerFor, findCompanyByDomain, isSharedNumberOptOutPause, previewSend, type ConsentLedger } from '@agency/db'
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
 * A pause, in words the model can act on, by what paused them.
 *
 * The send path refuses a paused contact as `paused` — its own code, not a
 * revoked consent — and the summary leads with these words when that is the
 * reason. Which pause it is decides what lifts it, so the class comes from
 * `pauseReasonClass`, the same exact reading the inbox uses: only a reason
 * that is exactly `replied <ISO instant>` is ended by answering the reply. A
 * prefix test called a teammate's "replied on the phone (by …)" a reply
 * pause, promising an /inbox answer the inbox then refused; and an opt-out
 * that could not be recorded, or an erasure that did not finish, was told
 * "resumes them on /contacts". Found by review. Neither of those two is ever
 * a thing to resume: the fix is to record the opt-out, or finish the
 * erasure. Only a reply pause is called "not a refusal" — any other is
 * quoted with its reason, because it may be exactly that.
 *
 * `sharedNumberHold` is previewSend's fact (review round 10, [2]): they hold
 * a number whose STOP could not be recorded, and their own pause stood
 * instead of the hold, so Resume refuses it until the number is recorded —
 * whatever its class says. Said after the class's own words — except for a
 * reply's pause, whose /inbox promise `replyQueueDraft` refuses then too,
 * where the words go in place of that promise (review round 13).
 */
function pauseWords(pausedFor: PauseReasonClass, reason: string | null, channel: string, sharedNumberHold = false): string {
  const why = (reason ?? 'no reason recorded').slice(0, 200)
  const noApprove = 'Approving a draft does not lift a pause.'
  const held = sharedNumberHold ? ` ${SHARED_NUMBER_HOLD_WORDS}` : ''
  switch (pausedFor) {
    case 'replied':
      // Held for a shared number too (review round 13): /inbox refuses the
      // answer as Resume refuses the pause, so neither is offered.
      if (sharedNumberHold) {
        return (
          `paused: they replied (${why}); every campaign stops for them. This is not a refusal of ${channel}. ` +
          `get_replies shows what they said. ${SHARED_NUMBER_HOLD_REPLIED_WORDS}`
        )
      }
      return (
        `paused: they replied (${why}); every campaign stops for them until a person answers from /inbox ` +
        `(which resumes them) or resumes them on /contacts. This is not a refusal of ${channel}. ` +
        `get_replies shows what they said.`
      )
    case 'manual':
      return (
        `paused by a teammate (${why}): every campaign stops for them until a person resumes them on /contacts. ` +
        `Answering a reply from /inbox does not lift this pause. ${noApprove}${held}`
      )
    case 'unsubscribed':
      return (
        `paused: they unsubscribed (${why}). That is their opt-out — do not suggest resuming them. ${noApprove}${held}`
      )
    case 'opt_out_not_recorded':
      // A shared number's holder (review round 8): a text from a number they
      // share asked to stop, maybe not theirs, and recording the NUMBER is
      // what lets a person lift it — never "they asked to stop".
      if (isSharedNumberOptOutPause(reason)) {
        return (
          `paused: a text from a phone number they share with another contact asked to stop, and it could not be ` +
          `recorded (${why}). It may not have been them. A person records the number on /suppressions; then the ` +
          `pause can be lifted on /contacts. Until then do not suggest resuming them. ${noApprove}`
        )
      }
      return (
        `paused: they asked to stop, and the opt-out could not be recorded (${why}), so there is no suppression ` +
        'row yet. A person must first record the opt-out by hand on /suppressions — do not suggest resuming ' +
        `them. ${noApprove}`
      )
    case 'erasure':
      return (
        `paused: they asked to be erased, and the erasure did not complete (${why}). A person must first ` +
        `complete the erasure from their record on /contacts — do not suggest resuming them. ${noApprove}`
      )
    case 'other':
      return (
        `paused (${why}): every campaign stops for them until a person reads why on /contacts and resumes them ` +
        `there if that is right. ${noApprove}${held}`
      )
  }
}

/**
 * A shared number's holder whose own pause stood (review round 10, [2]):
 * what Resume waits for, never that they asked. The /contacts ledger, the
 * paused block on /approvals and the send path's own sentence say the same.
 */
const SHARED_NUMBER_HOLD_WORDS =
  'They also hold a phone number a text came from that asked to stop, and it could not be recorded — it may not ' +
  'have been them — so Resume is refused until a person records the number on /suppressions; do not suggest ' +
  'resuming them before that.'

/**
 * The same for a holder paused by their own reply (review round 13):
 * answering it from /inbox would resume them, and /inbox refuses that
 * answer until the number is recorded, as Resume refuses the pause.
 */
const SHARED_NUMBER_HOLD_REPLIED_WORDS =
  'They also hold a phone number a text came from that asked to stop, and it could not be recorded — it may not ' +
  'have been them — so neither answering their reply from /inbox nor Resume on /contacts lifts the pause until a ' +
  'person records the number on /suppressions; do not suggest either before that.'

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
    // The pause speaks first when it IS the reason — the send path's own
    // `paused` code. A suppression or a recorded refusal outranks it and is
    // reported as itself, with the pause beside it.
    const pauseIsTheReason = !decision.allowed && decision.code === 'paused'
    const summary = decision.allowed
      ? `send_now: every rule passes for ${email} under "${campaign.name}" right now. ${approval} Nothing was queued.`
      : pauseIsTheReason
        ? `${pauseWords(facts.pausedFor ?? 'other', facts.pausedReason, campaign.channel, facts.sharedNumberHold)} Nothing was queued.`
        : `${decision.code}: ${decision.reason.replace(/[.\s]+$/, '')}. ` +
          (decision.humanCanResolve ? 'A person could resolve this. ' : 'Nobody may approve past this. ') +
          (facts.paused ? `They are also paused (${(facts.pausedReason ?? 'no reason recorded').slice(0, 200)}). ` : '') +
          (facts.sharedNumberHold
            ? `${facts.pausedFor === 'replied' ? SHARED_NUMBER_HOLD_REPLIED_WORDS : SHARED_NUMBER_HOLD_WORDS} `
            : '') +
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
          pausedFor: facts.pausedFor,
          sharedNumberHold: facts.sharedNumberHold,
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
      `${email} at ${contact.domain}${
        !contact.pausedAt
          ? ''
          : ledger.sharedNumberHold
            ? ' — paused: nothing is sent to them, and they cannot be resumed until a person records a phone number ' +
              'they share on /suppressions — a text from it asked to stop and could not be recorded, and it may not ' +
              'have been them'
            : ' — paused: nothing is sent to them until a person resumes them'
      }`,
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
        sharedNumberHold: ledger.sharedNumberHold,
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
