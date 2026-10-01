/**
 * SMS through DoveSoft, the database half (0019): drafting a message from a
 * registered template, recording what the operator said about delivering
 * it, and recording a text a contact sent back.
 *
 * Nothing here sends. A draft is an `awaiting_approval` row a person reads
 * in /approvals; the worker's provider (`channels: ['sms']`) takes it
 * through `dispatchTouch`, the one send path, which re-runs every rule —
 * the template steps included — at the moment of sending. SMS is opt-in
 * only (§2.1): every draft needs a granted SMS consent row, and no SMS
 * campaign can auto-send (`campaigns_no_auto_send_on_voice_or_sms`).
 *
 * The DLR and inbound PUSH formats are not public (DOVESOFT.md). These
 * functions take what a provider adapter has already read into named
 * fields — an E.164 number, a message id, a status word — and never parse a
 * provider payload themselves, so no guessed field name can reach the path
 * that decides an opt-out.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  normalisePhone, renderTemplate, smsOptOut,
  type ReplyKind, type SendRefusalCode,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { addSuppression } from './campaigns.js'
import { looksLikeOptOut, pauseContactOverriding, recordInboundReply, type InboundLog } from './outreach.js'
import { previewSend } from './send-preview.js'
import { isUniqueViolation } from './pg-errors.js'

const stderrLog: InboundLog = {
  error: (message, fields) => {
    console.error(JSON.stringify({ level: 'error', message, ...fields, at: new Date().toISOString() }))
  },
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export type SmsDraftRefusal =
  | 'no_such_contact'
  | 'no_phone'
  | 'no_such_campaign'
  | 'not_an_sms_campaign'
  | 'campaign_not_active'
  | 'no_such_template'
  | 'not_an_sms_template'
  | 'template_inactive'
  | 'render_failed'
  | 'already_queued'
  /** The send path's own dry run answered a refusal nobody may approve past; `code` says which. */
  | 'refused'

export type SmsDraftOutcome =
  | {
      readonly ok: true
      readonly touchId: string
      /** The rendered text, exactly as it will be sent. */
      readonly body: string
      /**
       * A refusal a person CAN resolve that the dry run met — quiet hours,
       * TRAI's band for a promotional SMS, the cap, a missing timezone. The
       * draft is written; the sender holds or refuses it at sending, and the
       * approver sees why now. `needs_approval` is never reported: every SMS
       * needs one.
       */
      readonly wouldHold: { readonly code: SendRefusalCode; readonly reason: string } | null
    }
  | {
      readonly ok: false
      readonly reason: SmsDraftRefusal
      /** One sentence for the person drafting. Never the phone number, never a value they typed. */
      readonly message: string
      /** For `refused`: the send path's code. */
      readonly code?: SendRefusalCode
      /** For `render_failed`: the 1-based slot that failed. */
      readonly slot?: number
    }

/** Statuses in which a drafted SMS is still on its way — one at a time per person per campaign. */
const LIVE_STATUSES = ['awaiting_approval', 'approved', 'queued', 'sending'] as const

/**
 * Draft one SMS to one contact from one registered template, for a person
 * to approve. Writes an `awaiting_approval` outbound row naming the
 * template, with the rendered text and the contact's E.164 number, and an
 * `sms.drafted` audit row (ids only). Sends nothing.
 *
 * Refused, with a sentence, when: the campaign is not an ACTIVE SMS
 * campaign; the template is not an active SMS template of this org; the
 * values do not render (a missing, extra, blank or over-long variable, or
 * a link in a plain `{#var#}`); the contact has no readable number; a draft
 * to them under this campaign is already on its way; or the send path's
 * own dry run (`previewSend`, over these exact words) answers a refusal
 * nobody may approve past — no SMS consent, a suppression, a pause, and the
 * rest. A refusal a person can resolve is written and reported as
 * `wouldHold`.
 */
export async function smsDraft(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly campaignId: string
    readonly templateId: string
    /** One value per `{#…#}` slot, in order. */
    readonly vars: readonly string[]
    /** A users.id, or 'agent' — the audit row's actor. */
    readonly createdBy: string
    readonly now?: Date
  },
): Promise<SmsDraftOutcome> {
  const now = args.now ?? new Date()
  const no = (reason: SmsDraftRefusal, message: string, extra: { code?: SendRefusalCode; slot?: number } = {}): SmsDraftOutcome => ({
    ok: false,
    reason,
    message,
    ...extra,
  })

  const [contact] = await db
    .select({ id: schema.contacts.id, companyId: schema.contacts.companyId, phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, args.contactId), eq(schema.contacts.orgId, args.orgId)))
    .limit(1)
  if (!contact) return no('no_such_contact', 'That contact is not in this org. Nothing was drafted.')
  const phone = contact.phone ? normalisePhone(contact.phone) : null
  if (!phone) {
    return no(
      'no_phone',
      'This contact has no phone number in international form (+91 98765 43210), so there is nobody to text and the suppression list cannot be checked. Fix the contact first.',
    )
  }

  const [campaign] = await db
    .select({ id: schema.campaigns.id, channel: schema.campaigns.channel, status: schema.campaigns.status })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, args.campaignId), eq(schema.campaigns.orgId, args.orgId)))
    .limit(1)
  if (!campaign) return no('no_such_campaign', 'That campaign is not in this org. Nothing was drafted.')
  if (campaign.channel !== 'sms') {
    return no('not_an_sms_campaign', `That is a ${campaign.channel} campaign. An SMS goes under an SMS campaign, where its cap and quiet hours live.`)
  }
  if (campaign.status !== 'active') {
    return no('campaign_not_active', `That campaign is ${campaign.status}. Set it active before drafting under it.`)
  }

  const [template] = await db
    .select({
      id: schema.messageTemplates.id,
      channel: schema.messageTemplates.channel,
      active: schema.messageTemplates.active,
      body: schema.messageTemplates.body,
    })
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.id, args.templateId), eq(schema.messageTemplates.orgId, args.orgId)))
    .limit(1)
  if (!template) return no('no_such_template', 'That template is not in this org. Nothing was drafted.')
  if (template.channel !== 'sms') {
    return no('not_an_sms_template', `That is a ${template.channel} template. An SMS is drafted from an SMS template registered on DLT.`)
  }
  if (!template.active) {
    return no('template_inactive', 'That template has been deactivated. Draft from an active one.')
  }

  const rendered = renderTemplate(template.body, args.vars)
  if (!rendered.ok) {
    return no('render_failed', `${rendered.message} Nothing was drafted.`, rendered.slot !== undefined ? { slot: rendered.slot } : {})
  }

  // The sender's own dry run, over THESE words: the template steps, and
  // every rule about the person, exactly as `dispatchTouch` will run them.
  const preview = await previewSend(db, {
    orgId: args.orgId,
    contactId: contact.id,
    campaignId: campaign.id,
    now,
    writtenAt: now,
    words: { templateId: template.id, body: rendered.text },
  })
  if (!preview.ok) return no('refused', `${preview.message}`)
  const decision = preview.decision
  if (!decision.allowed && !decision.humanCanResolve) {
    return no('refused', `${decision.reason} Nothing was drafted.`, { code: decision.code })
  }
  const wouldHold =
    !decision.allowed && decision.code !== 'needs_approval' ? { code: decision.code, reason: decision.reason } : null

  // One live draft per person per campaign, serialised on the contact: a
  // double click is two requests that would each read "none live" under
  // READ COMMITTED, so the read and the insert hold a transaction lock.
  const drafted = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sms.draft'), hashtext(${contact.id}))`)
    const live = await tx
      .select({ id: schema.touches.id })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.orgId, args.orgId),
          eq(schema.touches.contactId, contact.id),
          eq(schema.touches.campaignId, campaign.id),
          eq(schema.touches.channel, 'sms'),
          eq(schema.touches.direction, 'out'),
          inArray(schema.touches.status, [...LIVE_STATUSES]),
        ),
      )
      .limit(1)
    if (live.length > 0) return null
    const [row] = await tx
      .insert(schema.touches)
      .values({
        orgId: args.orgId,
        campaignId: campaign.id,
        contactId: contact.id,
        companyId: contact.companyId,
        channel: 'sms',
        direction: 'out',
        status: 'awaiting_approval',
        body: rendered.text,
        recipient: phone,
        templateId: template.id,
      })
      .returning({ id: schema.touches.id })
    if (!row) throw new Error('sms draft insert returned no row')
    return row.id
  })
  if (drafted === null) {
    return no('already_queued', 'An SMS to this contact under this campaign is already waiting to be approved or sent.')
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.createdBy,
    action: 'sms.drafted',
    subjectType: 'touch',
    subjectId: drafted,
    // §2.3: ids only — never the number, never the words.
    detail: { contactId: contact.id, campaignId: campaign.id, templateId: template.id },
  }).catch(() => {})

  return { ok: true, touchId: drafted, body: rendered.text, wouldHold }
}

// ---------------------------------------------------------------------------
// Delivery reports
// ---------------------------------------------------------------------------

/** What an operator's delivery report said, as the provider adapter read it (`DELIVRD` is `delivered`). */
export type SmsDeliveryStatus = 'pending' | 'delivered' | 'failed'

export type SmsDeliveryOutcome =
  | {
      readonly matched: true
      readonly orgId: string
      readonly touchId: string
      /** False when the report changed nothing: a repeat, or a later word arriving after a final one. */
      readonly changed: boolean
      /** The delivery status as stored now. */
      readonly deliveryStatus: SmsDeliveryStatus
    }
  | {
      readonly matched: false
      /** `unknown_id`: no SMS this system sent has that id. `ambiguous`: more than one does. */
      readonly why: 'blank_id' | 'unknown_id' | 'ambiguous'
    }

/** 0019's bound on `delivery_error`. */
const MAX_DELIVERY_ERROR = 300

/**
 * Record what the operator said about delivering one SMS, matched by the id
 * the provider gave it when it was sent (`touches.provider_id`, exactly one
 * outbound SMS row). Sets the delivery columns 0019 added, and never
 * `status`, which stays the send path's word.
 *
 * Idempotent, and monotonic: `pending` is recorded only over nothing; a
 * final word (`delivered`, `failed`) only over nothing or `pending`; and a
 * final word is never replaced — the first one stands, so a duplicate or a
 * late report changes nothing and says so (`changed: false`).
 *
 * A failed delivery is evidence about one attempt to one number, never an
 * opt-out (as a bounce is not): it writes no suppression and pauses nobody.
 *
 * An id no SMS this system sent carries is audited `sms.delivery_unmatched`
 * in `orgId` — the org this provider account belongs to, when the
 * deployment names one — and changes nothing. Without `orgId` there is no
 * org to file it under, and it is returned for the caller to log.
 */
export async function recordSmsDelivery(
  db: AgencyDb,
  args: {
    readonly providerMessageId: string
    readonly status: SmsDeliveryStatus
    /** The report's own reason (DoveSoft's `errorreason`). Required words for a failure; bounded. */
    readonly reason?: string | null
    /** When the report says it happened. Defaults to now. */
    readonly at?: Date
    readonly orgId?: string | null
  },
): Promise<SmsDeliveryOutcome> {
  const id = args.providerMessageId.trim()
  if (!id) return { matched: false, why: 'blank_id' }

  const hits = await db
    .select({ id: schema.touches.id, orgId: schema.touches.orgId })
    .from(schema.touches)
    .where(and(eq(schema.touches.providerId, id), eq(schema.touches.direction, 'out'), eq(schema.touches.channel, 'sms')))
    .limit(2)
  if (hits.length !== 1) {
    const why = hits.length === 0 ? 'unknown_id' : 'ambiguous'
    const orgs = hits.length === 0 ? (args.orgId ? [args.orgId] : []) : [...new Set(hits.map((h) => h.orgId))]
    for (const orgId of orgs) {
      await appendAudit(db, {
        orgId,
        actor: 'system',
        action: 'sms.delivery_unmatched',
        subjectType: null,
        subjectId: null,
        // The status and why — never the provider's id, which names the
        // message to anybody who can query the provider.
        detail: { why, status: args.status },
      }).catch(() => {})
    }
    return { matched: false, why }
  }
  const hit = hits[0]!

  const reason = (args.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DELIVERY_ERROR)
  const at = args.at ?? new Date()
  const set =
    args.status === 'delivered'
      ? { deliveryStatus: 'delivered', deliveredAt: at, deliveryError: null }
      : args.status === 'failed'
        ? { deliveryStatus: 'failed', deliveredAt: null, deliveryError: reason || 'failed (the report gave no reason)' }
        : { deliveryStatus: 'pending', deliveredAt: null, deliveryError: null }
  // What each word may be written over — the monotonic rule, in the UPDATE
  // itself so two reports racing cannot both win.
  const over =
    args.status === 'pending'
      ? sql`${schema.touches.deliveryStatus} IS NULL`
      : sql`(${schema.touches.deliveryStatus} IS NULL OR ${schema.touches.deliveryStatus} = 'pending')`
  const [updated] = await db
    .update(schema.touches)
    .set(set)
    .where(and(eq(schema.touches.id, hit.id), over))
    .returning({ deliveryStatus: schema.touches.deliveryStatus })
  if (updated) {
    return { matched: true, orgId: hit.orgId, touchId: hit.id, changed: true, deliveryStatus: args.status }
  }
  const [current] = await db
    .select({ deliveryStatus: schema.touches.deliveryStatus })
    .from(schema.touches)
    .where(eq(schema.touches.id, hit.id))
    .limit(1)
  return {
    matched: true,
    orgId: hit.orgId,
    touchId: hit.id,
    changed: false,
    deliveryStatus: (current?.deliveryStatus ?? args.status) as SmsDeliveryStatus,
  }
}

// ---------------------------------------------------------------------------
// A text a contact sent back
// ---------------------------------------------------------------------------

export type InboundSmsOutcome =
  | {
      readonly matched: 'contact'
      readonly orgId: string
      readonly contactId: string
      readonly touchId: string
      /** True when this message id had already been recorded, so nothing was written this time. */
      readonly duplicate: boolean
      readonly paused: boolean
      readonly suppressed: boolean
      readonly cancelled: number
      readonly replyKind: ReplyKind
      /**
       * The text asked to stop and the suppression could NOT be written —
       * already audited `contact.opt_out_not_recorded`, logged `OPT-OUT NOT
       * RECORDED` and the contact paused saying so. A caller with a way to
       * reach a person raises the alarm. False on a duplicate.
       */
      readonly optOutNotRecorded: boolean
      readonly companyId: string | null
      readonly companyDomain: string | null
    }
  | {
      readonly matched: 'none'
      /**
       * `unreadable_number`: the sender's number is not E.164 (the provider
       * adapter must hand it over as `+<country><number>`).
       * `no_contact`: no contact has it. `ambiguous`: more than one contact
       * does, so nothing says whose text it is. `duplicate`: this message id
       * was recorded before, for a contact who is gone now.
       */
      readonly why: 'unreadable_number' | 'no_contact' | 'ambiguous' | 'duplicate'
      /** The text read as an opt-out (`smsOptOut` or `looksLikeOptOut`). */
      readonly optOut: boolean
      /** An opt-out was written as a phone suppression in every org it could be. */
      readonly suppressed: boolean
      /** An opt-out could not be recorded somewhere it needed to be — loud, as above. */
      readonly optOutNotRecorded: boolean
    }

/**
 * Record a text a contact sent back.
 *
 * The number is read as E.164 (`normalisePhone`) and matched against
 * contacts' phones — across every org, or within `orgId` when the
 * deployment names the org its DoveSoft account belongs to (as
 * `VOICE_ORG_ID` does for calls). Then:
 *
 *  - EXACTLY ONE contact: the reply is recorded through `recordInboundReply`,
 *    the same function an email reply goes through — an inbound `sms` touch
 *    with its kind, the contact paused, what was queued for them cancelled,
 *    the deal moved forward to `replied`, and an opt-out (the SMS keyword
 *    reader `smsOptOut`, or the prose reader `looksLikeOptOut`) written as a
 *    PHONE suppression with source `reply`, or the loud
 *    `opt_out_not_recorded` path when it cannot be. One set of rules.
 *  - NONE, or MORE THAN ONE: nothing is filed under a guessed person — the
 *    text is dropped and audited `sms.inbound_unmatched` (ids and counts,
 *    never the number or the words) in every org involved, as an email
 *    reply from an address two orgs hold is dropped. But an OPT-OUT is not
 *    dropped: a phone suppression is keyed by the number, not the person,
 *    so it is written in every org whose contacts carry the number (or in
 *    `orgId`, when no contact does) — the person at that number asked us to
 *    stop, whoever they are on file as. Where it cannot be written, the
 *    loud path runs.
 *
 * Deduplicated by `providerMessageId`: a provider's retry of a message
 * already recorded writes nothing (0019's unique index settles a race
 * between two deliveries). Never throws on a text it cannot place.
 */
export async function recordInboundSms(
  db: AgencyDb,
  args: {
    /** The sender's number, as the provider adapter read it. Must be E.164 (or 00-prefixed). */
    readonly from: string
    /**
     * The number it was sent to — the agency's own. Not used to match (it is
     * the same for every contact) and not stored; accepted so an adapter
     * hands over what it read, and so a later multi-number deployment can
     * route by it.
     */
    readonly to?: string | null
    readonly text: string | null
    readonly providerMessageId: string | null
    readonly receivedAt?: Date
    readonly orgId?: string | null
    readonly log?: InboundLog
  },
): Promise<InboundSmsOutcome> {
  const now = args.receivedAt ?? new Date()
  const log = args.log ?? stderrLog
  const text = args.text ?? ''
  const optOut = smsOptOut(text) || looksLikeOptOut(text)
  const messageId = args.providerMessageId?.trim() || null
  const none = (
    why: Extract<InboundSmsOutcome, { matched: 'none' }>['why'],
    suppressed = false,
    optOutNotRecorded = false,
  ): InboundSmsOutcome => ({ matched: 'none', why, optOut, suppressed, optOutNotRecorded })

  const e164 = normalisePhone(args.from)
  if (!e164) {
    // A number nobody can read could never have matched a suppression row,
    // and none can be written for it. An opt-out from it is lost unless a
    // person records it — so it is loud, never quiet.
    if (args.orgId) {
      await auditUnmatched(db, args.orgId, { why: 'unreadable_number', optOut })
    }
    if (optOut) {
      await optOutLost(db, log, { orgId: args.orgId ?? null, contactId: null, why: 'unparseable_number', now })
      return none('unreadable_number', false, true)
    }
    return none('unreadable_number')
  }

  // Seen before. The kind comes off the stored row, never from re-reading.
  if (messageId) {
    const dup = await findInbound(db, messageId)
    if (dup) return dup
  }

  const candidates = await db
    .select({ id: schema.contacts.id, orgId: schema.contacts.orgId, phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(
      and(
        args.orgId ? eq(schema.contacts.orgId, args.orgId) : undefined,
        // Narrowed in SQL by digits, confirmed below by the same normaliser
        // the suppression list uses, so `+91 98765 43210` on file matches.
        sql`regexp_replace(coalesce(${schema.contacts.phone}, ''), '[^0-9]', '', 'g') IN (${e164.slice(1)}, ${`00${e164.slice(1)}`})`,
      ),
    )
    .limit(50)
  const matches = candidates.filter((c) => c.phone !== null && normalisePhone(c.phone) === e164)

  if (matches.length === 1) {
    const only = matches[0]!
    try {
      const r = await recordInboundReply(db, {
        orgId: only.orgId,
        contactId: only.id,
        channel: 'sms',
        from: e164,
        subject: null,
        body: args.text,
        providerId: messageId,
        now,
        log,
      })
      return {
        matched: 'contact',
        orgId: only.orgId,
        contactId: only.id,
        touchId: r.touchId,
        duplicate: false,
        paused: r.paused,
        suppressed: r.suppressed,
        cancelled: r.cancelled,
        replyKind: r.replyKind,
        optOutNotRecorded: r.optOutNotRecorded,
        companyId: r.companyId,
        companyDomain: r.companyDomain,
      }
    } catch (err) {
      // Two deliveries of one message raced past the read above; the unique
      // index let one insert, and the insert is `recordInboundReply`'s FIRST
      // write, so the loser wrote nothing. Answer as the duplicate it is.
      if (messageId && isUniqueViolation(err)) {
        const dup = await findInbound(db, messageId)
        if (dup) return dup
      }
      throw err
    }
  }

  // Nobody, or more than one person: file nothing under a guess.
  const orgs = matches.length === 0 ? (args.orgId ? [args.orgId] : []) : [...new Set(matches.map((m) => m.orgId))]
  const why = matches.length === 0 ? 'no_contact' : 'ambiguous'
  /** Per org: whether the opt-out's phone suppression was written there. */
  const recorded = new Map<string, boolean>()
  if (optOut && orgs.length === 0) {
    // No contact anywhere and no org named: there is nowhere to record it.
    await optOutLost(db, log, { orgId: null, contactId: null, why: 'no_org', now })
  }
  for (const orgId of optOut ? orgs : []) {
    const added = await suppressPhone(db, orgId, e164, now)
    recorded.set(orgId, added.ok)
    if (added.ok) continue
    const inOrg = matches.filter((m) => m.orgId === orgId)
    if (inOrg.length === 0) await optOutLost(db, log, { orgId, contactId: null, why: added.why, now })
    for (const m of inOrg) await optOutLost(db, log, { orgId, contactId: m.id, why: added.why, now })
  }
  for (const orgId of orgs) {
    await auditUnmatched(db, orgId, {
      why,
      optOut,
      contacts: matches.filter((m) => m.orgId === orgId).length,
      ...(optOut ? { suppressed: recorded.get(orgId) === true } : {}),
    })
  }
  const everywhere = orgs.length > 0 && orgs.every((o) => recorded.get(o) === true)
  return none(why, optOut && everywhere, optOut && !everywhere)
}

/** An inbound SMS already recorded under this message id, as the outcome a redelivery gets. */
async function findInbound(db: AgencyDb, messageId: string): Promise<InboundSmsOutcome | null> {
  const [dup] = await db
    .select({
      id: schema.touches.id,
      orgId: schema.touches.orgId,
      contactId: schema.touches.contactId,
      replyKind: schema.touches.replyKind,
      companyId: schema.touches.companyId,
      companyDomain: schema.companies.domain,
    })
    .from(schema.touches)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.touches.companyId))
    .where(and(eq(schema.touches.direction, 'in'), eq(schema.touches.channel, 'sms'), eq(schema.touches.providerId, messageId)))
    .limit(1)
  if (!dup) return null
  if (!dup.contactId) {
    return { matched: 'none', why: 'duplicate', optOut: dup.replyKind === 'opted_out', suppressed: false, optOutNotRecorded: false }
  }
  return {
    matched: 'contact',
    orgId: dup.orgId,
    contactId: dup.contactId,
    touchId: dup.id,
    duplicate: true,
    paused: false,
    suppressed: false,
    cancelled: 0,
    replyKind: (dup.replyKind as ReplyKind | null) ?? 'other',
    optOutNotRecorded: false,
    companyId: dup.companyId,
    companyDomain: dup.companyDomain ?? null,
  }
}

/**
 * The phone suppression an SMS opt-out writes, with the reason CLASS when it
 * cannot be: a THROW is what a database fault does and `{ ok: false }` what
 * an unreadable number does, and both are the same failure to the person
 * who asked (the lesson `recordOptOut` in calls.ts learned).
 */
async function suppressPhone(
  db: AgencyDb,
  orgId: string,
  phone: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    const added = await addSuppression(db, {
      orgId,
      kind: 'phone',
      value: phone,
      reason: `replied asking to stop, ${now.toISOString().slice(0, 10)}`,
      source: 'reply',
    })
    return added.ok ? { ok: true } : { ok: false, why: 'unparseable_number' }
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.name : 'UnknownError' }
  }
}

/**
 * §2.1's Phase 4 obligation for a text nobody could file under one person:
 * the same loud path `recordInboundReply` takes for a reply it could file —
 * the contact (when there is one) paused OVER any earlier reason with
 * `opt-out not recorded: reply <ISO> (<why>)`, a `contact.opt_out_not_recorded`
 * audit row the compliance page and the digest count, and an `OPT-OUT NOT
 * RECORDED` line at error. Ids and a reason class only (§2.3).
 */
async function optOutLost(
  db: AgencyDb,
  log: InboundLog,
  args: { orgId: string | null; contactId: string | null; why: string; now: Date },
): Promise<void> {
  if (args.orgId && args.contactId) {
    try {
      await pauseContactOverriding(
        db, args.orgId, args.contactId, `opt-out not recorded: reply ${args.now.toISOString()} (${args.why})`, args.now,
      )
    } catch (err) {
      log.error('an opt-out that was not recorded could not pause the contact', {
        contactId: args.contactId,
        orgId: args.orgId,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }
  if (args.orgId) {
    await appendAudit(db, {
      orgId: args.orgId,
      actor: 'system',
      action: 'contact.opt_out_not_recorded',
      subjectType: args.contactId ? 'contact' : null,
      subjectId: args.contactId,
      detail: { channel: 'sms', why: args.why },
    }).catch(() => {})
  }
  log.error('OPT-OUT NOT RECORDED — follow up by hand', {
    channel: 'sms',
    orgId: args.orgId,
    contactId: args.contactId,
    why: args.why,
  })
}

async function auditUnmatched(db: AgencyDb, orgId: string, detail: Record<string, unknown>): Promise<void> {
  await appendAudit(db, {
    orgId,
    actor: 'system',
    action: 'sms.inbound_unmatched',
    subjectType: null,
    subjectId: null,
    // §2.3: why, and counts — never the number, never the words.
    detail,
  }).catch(() => {})
}
