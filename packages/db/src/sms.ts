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
import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  normalisePhone, renderTemplate, smsOptOut,
  type ReplyKind, type SendDecision, type SendRefusalCode,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { addSuppression } from './campaigns.js'
import { looksLikeOptOut, pauseContact, pauseContactOverriding, recordInboundReply, type InboundLog } from './outreach.js'
import { previewSend } from './send-preview.js'
import { isUniqueViolation } from './pg-errors.js'

const stderrLog: InboundLog = {
  error: (message, fields) => {
    console.error(JSON.stringify({ level: 'error', message, ...fields, at: new Date().toISOString() }))
  },
}

/**
 * Postgres refuses U+0000 in text, and some SMPP gateways decode GSM-7's `@`
 * (0x00) as exactly that — so a text carrying one failed its INSERT on every
 * retry, and a STOP sent that way was never recorded anywhere. It is kept
 * visible as U+FFFD rather than dropped: the stored words say a character
 * was there.
 */
function withoutNul(s: string): string {
  return s.replace(/\u0000/g, '\uFFFD')
}

/**
 * Whether a text a contact sent asks to stop: the SMS keyword reader
 * (`smsOptOut`) or the prose reader an email reply goes through
 * (`looksLikeOptOut`). The one reading `recordInboundSms` acts on, exported
 * so a caller whose recording FAILED can still tell a STOP it could not
 * record from an ordinary text, and raise the alarm for it.
 */
export function smsTextAsksToStop(text: string | null | undefined): boolean {
  const t = withoutNul(text ?? '')
  return smsOptOut(t) || looksLikeOptOut(t)
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

/**
 * `smsDraft`'s dry run (`dryRun: true`): the same checks, in the same order,
 * stopping before the insert — the composer's "Check".
 *
 * A refusal `smsDraft` would answer with a sentence comes back as that same
 * refusal, so the two cannot disagree (a paused campaign, a draft already on
 * its way). Past those, the answer is the send path's decision about these
 * exact words, with `wouldNeedApproval` beside it — including a refusal
 * nobody may approve past, which `smsDraft` turns into `refused`: the
 * question was "what would happen", and that decision is its answer.
 */
export type SmsDraftCheck =
  | {
      readonly ok: true
      /** The rendered text, exactly as it would be drafted. */
      readonly body: string
      readonly decision: SendDecision
      readonly wouldNeedApproval: boolean
    }
  | Extract<SmsDraftOutcome, { ok: false }>

/** Statuses in which a drafted SMS is still on its way — one at a time per person per campaign. */
const LIVE_STATUSES = ['awaiting_approval', 'approved', 'queued', 'sending'] as const

interface SmsDraftArgs {
  readonly orgId: string
  readonly contactId: string
  readonly campaignId: string
  readonly templateId: string
  /** One value per `{#…#}` slot, in order. */
  readonly vars: readonly string[]
  /** A users.id, or 'agent' — the audit row's actor. */
  readonly createdBy: string
  readonly now?: Date
}

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
 *
 * With `dryRun: true` it writes nothing and answers `SmsDraftCheck`: every
 * one of those checks, in this order, the live-draft read included — so the
 * composer's Check and its Draft give one answer.
 */
export async function smsDraft(db: AgencyDb, args: SmsDraftArgs & { readonly dryRun: true }): Promise<SmsDraftCheck>
export async function smsDraft(db: AgencyDb, args: SmsDraftArgs & { readonly dryRun?: false }): Promise<SmsDraftOutcome>
export async function smsDraft(
  db: AgencyDb,
  args: SmsDraftArgs & { readonly dryRun?: boolean },
): Promise<SmsDraftOutcome | SmsDraftCheck> {
  const now = args.now ?? new Date()
  const no = (
    reason: SmsDraftRefusal,
    message: string,
    extra: { code?: SendRefusalCode; slot?: number } = {},
  ): Extract<SmsDraftOutcome, { ok: false }> => ({
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
  const blocked = !decision.allowed && !decision.humanCanResolve
  const ALREADY_QUEUED = 'An SMS to this contact under this campaign is already waiting to be approved or sent.'
  const liveDraft = async (q: AgencyDb): Promise<boolean> => {
    const live = await q
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
    return live.length > 0
  }

  if (args.dryRun) {
    // The same order as below: a refusal nobody may approve past is the
    // answer before the live-draft read, as it is `refused` there.
    if (!blocked && (await liveDraft(db))) return no('already_queued', ALREADY_QUEUED)
    return { ok: true, body: rendered.text, decision, wouldNeedApproval: preview.wouldNeedApproval }
  }

  if (blocked) {
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
    if (await liveDraft(tx)) return null
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
  if (drafted === null) return no('already_queued', ALREADY_QUEUED)

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
  const id = withoutNul(args.providerMessageId).trim()
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

  const reason = withoutNul(args.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DELIVERY_ERROR)
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

/**
 * An org where a text's opt-out could not be written as a phone suppression
 * — already audited `contact.opt_out_not_recorded` there, logged, and each
 * of its contacts holding the number paused saying so (`optOutLost`) — and
 * one of those contacts, for the alarm to name: null where no contact there
 * holds the number (the org a number nobody holds is filed under).
 */
export interface SmsOptOutLost {
  readonly orgId: string
  readonly contactId: string | null
}

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
       * The text asked to stop and THIS contact's suppression — the one in
       * the org it was filed under — could NOT be written: already audited
       * `contact.opt_out_not_recorded`, logged `OPT-OUT NOT RECORDED` and
       * the contact paused saying so. A caller with a way to reach a person
       * raises the alarm. False on a duplicate. Another org's failure is
       * never folded in here (review round 6): it is `optOutNotRecordedIn`,
       * because an alarm naming this contact, whose number IS suppressed,
       * sent the person following up to the one org that was fine.
       */
      readonly optOutNotRecorded: boolean
      /** Every OTHER org whose contacts hold the number where the STOP could not be suppressed — an alarm each. */
      readonly optOutNotRecordedIn: readonly SmsOptOutLost[]
      readonly companyId: string | null
      readonly companyDomain: string | null
    }
  | {
      readonly matched: 'none'
      /**
       * `unreadable_number`: the sender's number is not E.164 (the provider
       * adapter must hand it over as `+<country><number>`).
       * `no_contact`: no contact has it. `ambiguous`: more than one contact
       * does, and nothing narrows it to one (`whoseText`), so nothing says
       * whose text it is — each of them was held instead. `duplicate`: this
       * message id was recorded before — for a contact who is gone now, or
       * filed under nobody, in which case nobody is held again and only an
       * opt-out's missing suppression is written.
       */
      readonly why: 'unreadable_number' | 'no_contact' | 'ambiguous' | 'duplicate'
      /** The text read as an opt-out (`smsOptOut` or `looksLikeOptOut`). */
      readonly optOut: boolean
      /** An opt-out was written as a phone suppression in every org it could be. */
      readonly suppressed: boolean
      /** An opt-out could not be recorded somewhere it needed to be — loud, as above. */
      readonly optOutNotRecorded: boolean
      /**
       * Where it could not be, org by org — an alarm each. Empty when there
       * was no org to record it in at all (no contact holds the number and
       * no fallback org is named), which `optOutNotRecorded` still says.
       */
      readonly optOutNotRecordedIn: readonly SmsOptOutLost[]
    }

/**
 * Record a text a contact sent back.
 *
 * The number is read as E.164 (`normalisePhone`) and matched against
 * contacts' phones across EVERY org, as a delivery report is matched by its
 * message id: drafting and sending an SMS are not scoped to one org, so a
 * reply must not be either — a STOP from a person another org texted, read
 * only inside `orgId`, was suppressed in the wrong org and left them on the
 * list that texted them. `orgId`, the org the deployment's DoveSoft account
 * belongs to, is the FALLBACK: where a text from a number no contact holds
 * is filed, and nothing else. Then:
 *
 *  - EXACTLY ONE contact — or several, of whom exactly one is whose text
 *    it is by the evidence (`whoseText`: the one this system TEXTED at that
 *    number): the reply is recorded through `recordInboundReply`, the same
 *    function an email reply goes through — an inbound `sms` touch with its
 *    kind, the contact paused, what was queued for them cancelled, the deal
 *    moved forward to `replied`, and an opt-out (the SMS keyword reader
 *    `smsOptOut`, or the prose reader `looksLikeOptOut`) written as a PHONE
 *    suppression with source `reply`, or the loud `opt_out_not_recorded`
 *    path when it cannot be. One set of rules. Every OTHER contact holding
 *    the number, in any org, is held (`holdEach`, review round 6) — a twin
 *    row in the same org, or another org's contact, would otherwise keep an
 *    approved text to the person who just replied — and a STOP is also
 *    suppressed in every other org whose contacts hold the number. When the
 *    filed contact's own suppression could not be written, the others in
 *    their org take the loud path with them: the one suppression row would
 *    have covered them too.
 *  - NONE, or SEVERAL that nothing narrows to one: nothing is filed under a
 *    guessed person — no inbound row is written, and `sms.inbound_unmatched`
 *    is audited (ids and counts, never the number or the words) in every
 *    org involved, as an email reply from an address two orgs hold is
 *    dropped. But what needs no attribution is done (review round 5): every
 *    one of the several is HELD — paused and what was queued, awaiting
 *    approval or approved for them cancelled, in their own org — because
 *    the reply came from their number, so an approved text to any of them
 *    must not go on the next tick while a person works out whose it was.
 *    And an OPT-OUT is not dropped: a phone suppression is keyed by the
 *    number, not the person, so it is written in every org whose contacts
 *    carry the number (or in `orgId`, when no contact does) — the person at
 *    that number asked us to stop, whoever they are on file as. Where it
 *    cannot be written, the loud path runs.
 *
 * Deduplicated by `providerMessageId`: a provider's retry of a message
 * already recorded writes nothing (0019's unique index settles a race
 * between two deliveries) — and re-holds nobody, which would undo a
 * teammate's resume since. A text filed under nobody has no inbound row to
 * find, so its `sms.inbound_unmatched` rows carry a hash of the message id
 * (`messageHash`), and a redelivery that finds one holds nobody again
 * (review round 6). Either kind of redelivery of a STOP writes a phone
 * suppression it finds missing, in the orgs it was owed to: a function cut
 * off after the reply committed, or a suppression whose write failed, is
 * finished by the provider's retry. Never throws on a text it cannot place;
 * a database fault is thrown, so the caller answers 500 and the provider
 * retries.
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
    /** Where a text no contact can be found for is filed (`DOVESOFT_ORG_ID`). Never a filter on the match, and never a preference among holders. */
    readonly orgId?: string | null
    readonly log?: InboundLog
  },
): Promise<InboundSmsOutcome> {
  const now = args.receivedAt ?? new Date()
  const log = args.log ?? stderrLog
  // A NUL fails the INSERT on every retry (`withoutNul`); the words read
  // and the words stored are the same text.
  const text = withoutNul(args.text ?? '')
  const optOut = smsTextAsksToStop(text)
  const messageId = (args.providerMessageId === null ? '' : withoutNul(args.providerMessageId)).trim() || null
  const none = (
    why: Extract<InboundSmsOutcome, { matched: 'none' }>['why'],
    lost: { suppressed?: boolean; optOutNotRecorded?: boolean; optOutNotRecordedIn?: readonly SmsOptOutLost[] } = {},
  ): InboundSmsOutcome => ({
    matched: 'none',
    why,
    optOut,
    suppressed: lost.suppressed ?? false,
    optOutNotRecorded: lost.optOutNotRecorded ?? false,
    optOutNotRecordedIn: lost.optOutNotRecordedIn ?? [],
  })

  const e164 = normalisePhone(args.from)
  if (!e164) {
    // A number nobody can read could never have matched a suppression row,
    // and none can be written for it. An opt-out from it is lost unless a
    // person records it — so it is loud, never quiet.
    if (args.orgId) {
      // `suppressed: false` said in so many words: /audit claims a
      // suppression only where the row says one was written.
      await auditUnmatched(db, args.orgId, { why: 'unreadable_number', optOut, ...(optOut ? { suppressed: false } : {}) })
    }
    if (optOut) {
      await optOutLost(db, log, { orgId: args.orgId ?? null, contactId: null, why: 'unparseable_number', now })
      return none('unreadable_number', {
        optOutNotRecorded: true,
        optOutNotRecordedIn: args.orgId ? [{ orgId: args.orgId, contactId: null }] : [],
      })
    }
    return none('unreadable_number')
  }

  // Seen before. The kind comes off the stored row, never from re-reading;
  // and a STOP's suppressions in the other orgs holding the number are
  // finished if the first delivery did not get to them (review round 6).
  if (messageId) {
    const dup = await findInbound(db, messageId)
    if (dup) return finishRedelivered(db, log, dup, e164, now)
  }

  const holders = await holdersOf(db, e164)
  const only = holders.length === 1 ? holders[0]! : await whoseText(db, holders, e164)

  if (only) {
    // Everybody else holding the number is held FIRST, before the reply is
    // recorded: once it is, a redelivery is a duplicate that holds nobody,
    // so a function cut off between the two must not have skipped this.
    const others = holders.filter((h) => h.id !== only.id)
    const held = await holdEachOrg(db, others, now)
    let r: Awaited<ReturnType<typeof recordInboundReply>>
    try {
      r = await recordInboundReply(db, {
        orgId: only.orgId,
        contactId: only.id,
        channel: 'sms',
        from: e164,
        subject: null,
        body: args.text === null ? null : text,
        providerId: messageId,
        now,
        log,
      })
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
    // The one suppression row in this org covers every contact here holding
    // the number, so when it could not be written they share the loud path:
    // paused OVER the hold, audited, logged (review round 6). Only the
    // filed contact's alarm is raised — it names the org's missing row.
    const twins = others.filter((h) => h.orgId === only.orgId)
    if (r.optOutNotRecorded) {
      for (const twin of twins) {
        await optOutLost(db, log, { orgId: only.orgId, contactId: twin.id, why: 'suppression_failed', now })
      }
    }
    // A STOP is keyed by the number, not the person: another org whose
    // contact holds it was told to stop too, whoever the text is filed
    // under (the rule below). Filing it under one contact by the evidence
    // must not take the suppression away from the org it would have reached
    // had nothing narrowed the match.
    const elsewhere = orgsOf(others).filter((o) => o !== only.orgId)
    const recorded = await suppressInEvery(db, log, optOut ? elsewhere : [], holders, e164, now)
    // A row in each org whose contacts were held: who, by counts, and that
    // the text was filed under somebody — another contact here, or a contact
    // in another org.
    for (const orgId of orgsOf(others)) {
      const hold = held.get(orgId)
      await auditUnmatched(db, orgId, {
        why: 'ambiguous',
        optOut,
        contacts: others.filter((m) => m.orgId === orgId).length,
        paused: hold?.paused ?? 0,
        cancelledQueued: hold?.cancelled ?? 0,
        filedUnder: orgId === only.orgId ? 'another_contact' : 'another_org',
        ...(optOut ? { suppressed: orgId === only.orgId ? r.suppressed : recorded.get(orgId) === true } : {}),
      })
    }
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
      optOutNotRecordedIn: optOut ? lostIn(elsewhere, recorded, holders) : [],
      companyId: r.companyId,
      companyDomain: r.companyDomain,
    }
  }

  // Nobody, or several people nothing narrows to one: file nothing under a
  // guess.
  const orgs = holders.length === 0 ? (args.orgId ? [args.orgId] : []) : orgsOf(holders)
  const why = holders.length === 0 ? 'no_contact' : 'ambiguous'
  const messageHash = messageId ? hashOf(messageId) : null

  // Seen before (review round 6): the rows this text left carry its hash,
  // and holding every holder again would undo a teammate's resume and
  // cancel drafts written since. Only an opt-out's suppression is
  // re-attempted, and only where it is still missing — a write that failed
  // the first time, the reason DoveSoft was answered 500 and retried.
  if (messageHash && orgs.length > 0 && (await filedUnderNobodyBefore(db, orgs, messageHash))) {
    if (!optOut) return none('duplicate')
    const missing = await unsuppressedIn(db, orgs, e164)
    const recorded = await suppressInEvery(db, log, missing, holders, e164, now)
    for (const orgId of missing) {
      await auditUnmatched(db, orgId, {
        why,
        optOut,
        contacts: holders.filter((m) => m.orgId === orgId).length,
        redelivered: true,
        suppressed: recorded.get(orgId) === true,
        messageHash,
      })
    }
    const lost = lostIn(missing, recorded, holders)
    return none('duplicate', { suppressed: lost.length === 0, optOutNotRecorded: lost.length > 0, optOutNotRecordedIn: lost })
  }

  // Hold every one of the several first, which needs no guess. Before the
  // suppression below, so an opt-out that cannot be written still
  // overwrites this reason with its own (`optOutLost`). A fault here
  // throws: nothing was suppressed yet, so the caller's loud path for a
  // STOP whose recording failed is the truth, and the provider retries.
  const held = await holdEachOrg(db, holders, now)
  if (optOut && orgs.length === 0) {
    // No contact anywhere and no org named: there is nowhere to record it.
    await optOutLost(db, log, { orgId: null, contactId: null, why: 'no_org', now })
  }
  /** Per org: whether the opt-out's phone suppression was written there. */
  const recorded = await suppressInEvery(db, log, optOut ? orgs : [], holders, e164, now)
  for (const orgId of orgs) {
    const hold = held.get(orgId)
    await auditUnmatched(db, orgId, {
      why,
      optOut,
      contacts: holders.filter((m) => m.orgId === orgId).length,
      // Counts only: how many of this org's holders were paused by this
      // text, and how many of their messages it cancelled.
      ...(why === 'ambiguous' ? { paused: hold?.paused ?? 0, cancelledQueued: hold?.cancelled ?? 0 } : {}),
      ...(optOut ? { suppressed: recorded.get(orgId) === true } : {}),
      // The redelivery check above reads it: a hash, never the id itself.
      ...(messageHash ? { messageHash } : {}),
    })
  }
  const everywhere = orgs.length > 0 && orgs.every((o) => recorded.get(o) === true)
  return none(why, {
    suppressed: optOut && everywhere,
    optOutNotRecorded: optOut && !everywhere,
    optOutNotRecordedIn: optOut ? lostIn(orgs, recorded, holders) : [],
  })
}

/** A contact whose phone is the number a text came from. */
interface Holder {
  readonly id: string
  readonly orgId: string
}

/** Every contact, in every org, whose phone is this number (see `recordInboundSms`). */
async function holdersOf(db: AgencyDb, e164: string): Promise<Holder[]> {
  const candidates = await db
    .select({ id: schema.contacts.id, orgId: schema.contacts.orgId, phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(
      // Every org (see above). Narrowed in SQL by digits, confirmed below by
      // the same normaliser the suppression list uses, so `+91 98765 43210`
      // on file matches.
      sql`regexp_replace(coalesce(${schema.contacts.phone}, ''), '[^0-9]', '', 'g') IN (${e164.slice(1)}, ${`00${e164.slice(1)}`})`,
    )
    .limit(50)
  return candidates
    .filter((c) => c.phone !== null && normalisePhone(c.phone) === e164)
    .map((c) => ({ id: c.id, orgId: c.orgId }))
}

/** The distinct orgs of these holders, in the order first seen. */
function orgsOf(holders: readonly Holder[]): string[] {
  return [...new Set(holders.map((h) => h.orgId))]
}

/**
 * Whose text it is, when several contacts hold the number it came from —
 * as far as the evidence goes, and no further (review round 5).
 *
 * The evidence is what this system SENT: a contact it texted at this number
 * (an outbound SMS that went, `sent`, to a recipient that reads as this
 * E.164) is somebody who could be answering; one it never texted is not
 * known to be. Exactly one texted is whose it is, and the reply is filed
 * under them.
 *
 * Anything else is nobody's: two or more texted, or none. No org is
 * preferred among several it texted (review round 6): every org's texts go
 * out through the one DoveSoft account (`dueTouches` reads every org), so
 * the deployment's `DOVESOFT_ORG_ID` is no evidence of whose text was
 * answered, as it never was when nobody had been texted.
 */
async function whoseText(db: AgencyDb, holders: readonly Holder[], e164: string): Promise<Holder | null> {
  if (holders.length === 0) return null
  const sent = await db
    .selectDistinct({ contactId: schema.touches.contactId, recipient: schema.touches.recipient })
    .from(schema.touches)
    .where(
      and(
        inArray(schema.touches.contactId, holders.map((h) => h.id)),
        eq(schema.touches.channel, 'sms'),
        eq(schema.touches.direction, 'out'),
        eq(schema.touches.status, 'sent'),
      ),
    )
  const textedIds = new Set(
    sent.filter((s) => s.recipient !== null && normalisePhone(s.recipient) === e164).map((s) => s.contactId),
  )
  const texted = holders.filter((h) => textedIds.has(h.id))
  return texted.length === 1 ? texted[0]! : null
}

/**
 * The pause `holdEach` writes: a reason of its own, which `pauseReasonClass`
 * reads as `other` — never `replied <ISO>`, the reply class, which told a
 * person to "answer the reply from /inbox" for a contact no reply row
 * exists for (review round 6). Resume on /contacts lifts it; answering a
 * reply in /inbox does not.
 */
export function sharedNumberHoldReason(now: Date): string {
  return `held: a text came from a number another contact also holds, ${now.toISOString()}`
}

/**
 * Hold contacts a text could be from, org by org: `holdEach` per org, one
 * transaction each. Counts back per org.
 */
async function holdEachOrg(
  db: AgencyDb,
  holders: readonly Holder[],
  now: Date,
): Promise<Map<string, { paused: number; cancelled: number }>> {
  const held = new Map<string, { paused: number; cancelled: number }>()
  for (const orgId of orgsOf(holders)) {
    held.set(orgId, await holdEach(db, orgId, holders.filter((m) => m.orgId === orgId).map((m) => m.id), now))
  }
  return held
}

/**
 * Hold each of several people a text could be from, in one org and one
 * transaction: paused `sharedNumberHoldReason` — kept when they are already
 * paused for another reason (`pauseContact`) — and their queued,
 * awaiting-approval and approved messages cancelled, on every channel,
 * refused `paused`: a hold, which `REFUSALS_A_CORRECTION_RESOLVES` lets a
 * draft be written again once a person lifts it. Never `consent_revoked`,
 * the recipient's own no, which enrolment reads as a refusal for good — of
 * somebody who may have sent nothing (review round 6). Counts back.
 */
async function holdEach(
  db: AgencyDb,
  orgId: string,
  contactIds: readonly string[],
  now: Date,
): Promise<{ paused: number; cancelled: number }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    let paused = 0
    for (const contactId of contactIds) {
      if (await pauseContact(tx, orgId, contactId, sharedNumberHoldReason(now), now)) paused++
    }
    const cancelled = await tx
      .update(schema.touches)
      .set({ status: 'refused', refusalCode: 'paused' })
      .where(
        and(
          eq(schema.touches.orgId, orgId),
          inArray(schema.touches.contactId, [...contactIds]),
          eq(schema.touches.direction, 'out'),
          inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved']),
        ),
      )
      .returning({ id: schema.touches.id })
    return { paused, cancelled: cancelled.length }
  })
}

/**
 * The phone suppression in each of these orgs, and the loud path where it
 * cannot be written — for every holder of the number in that org, or for
 * the org alone when none is. Per org: whether it was written.
 */
async function suppressInEvery(
  db: AgencyDb,
  log: InboundLog,
  orgs: readonly string[],
  holders: readonly Holder[],
  e164: string,
  now: Date,
): Promise<Map<string, boolean>> {
  const recorded = new Map<string, boolean>()
  for (const orgId of orgs) {
    const added = await suppressPhone(db, orgId, e164, now)
    recorded.set(orgId, added.ok)
    if (added.ok) continue
    const inOrg = holders.filter((m) => m.orgId === orgId)
    if (inOrg.length === 0) await optOutLost(db, log, { orgId, contactId: null, why: added.why, now })
    for (const m of inOrg) await optOutLost(db, log, { orgId, contactId: m.id, why: added.why, now })
  }
  return recorded
}

/** The orgs among these where the suppression was not written, each with one of its holders for the alarm. */
function lostIn(orgs: readonly string[], recorded: ReadonlyMap<string, boolean>, holders: readonly Holder[]): SmsOptOutLost[] {
  return orgs
    .filter((orgId) => recorded.get(orgId) !== true)
    .map((orgId) => ({ orgId, contactId: holders.find((h) => h.orgId === orgId)?.id ?? null }))
}

/** The orgs among these with no phone suppression of this number yet. */
async function unsuppressedIn(db: AgencyDb, orgs: readonly string[], e164: string): Promise<string[]> {
  if (orgs.length === 0) return []
  const rows = await db
    .select({ orgId: schema.suppressions.orgId })
    .from(schema.suppressions)
    .where(
      and(
        inArray(schema.suppressions.orgId, [...orgs]),
        eq(schema.suppressions.kind, 'phone'),
        eq(schema.suppressions.value, e164),
      ),
    )
  const present = new Set(rows.map((r) => r.orgId))
  return orgs.filter((o) => !present.has(o))
}

/**
 * A text recorded before — what a redelivery gets. For a STOP filed under a
 * contact, the phone suppression in every OTHER org holding the number is
 * written where it is missing (review round 6): those writes come after the
 * reply commits, so a function cut off between the two left them undone,
 * and the retry that would have finished them answered "duplicate" before
 * it got there. Nobody is held or paused again, and the stored row is not
 * touched; a suppression already present is not written twice, and neither
 * is its audit row.
 */
async function finishRedelivered(
  db: AgencyDb,
  log: InboundLog,
  dup: InboundSmsOutcome,
  e164: string,
  now: Date,
): Promise<InboundSmsOutcome> {
  if (dup.matched !== 'contact' || dup.replyKind !== 'opted_out') return dup
  const holders = await holdersOf(db, e164)
  const missing = await unsuppressedIn(db, orgsOf(holders).filter((o) => o !== dup.orgId), e164)
  if (missing.length === 0) return dup
  const recorded = await suppressInEvery(db, log, missing, holders, e164, now)
  for (const orgId of missing) {
    await auditUnmatched(db, orgId, {
      why: 'ambiguous',
      optOut: true,
      contacts: holders.filter((m) => m.orgId === orgId).length,
      filedUnder: 'another_org',
      redelivered: true,
      suppressed: recorded.get(orgId) === true,
    })
  }
  return { ...dup, optOutNotRecordedIn: lostIn(missing, recorded, holders) }
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
    return {
      matched: 'none',
      why: 'duplicate',
      optOut: dup.replyKind === 'opted_out',
      suppressed: false,
      optOutNotRecorded: false,
      optOutNotRecordedIn: [],
    }
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
    optOutNotRecordedIn: [],
    companyId: dup.companyId,
    companyDomain: dup.companyDomain ?? null,
  }
}

/**
 * The key a text filed under nobody is remembered by: a sha256 of
 * DoveSoft's message id, never the id itself — an audit row carries ids of
 * this system's rows and counts, and a provider's message id leads to the
 * number and the words in the provider's own log.
 */
function hashOf(messageId: string): string {
  return createHash('sha256').update(messageId, 'utf8').digest('hex')
}

/**
 * Whether a text with this message id was filed under nobody before: an
 * `sms.inbound_unmatched` row carrying its hash, in one of the orgs this
 * text involves — every such row was written in each of them. Read in the
 * orgs' own slice of the log (`audit_log_org_created_idx`).
 */
async function filedUnderNobodyBefore(db: AgencyDb, orgs: readonly string[], messageHash: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        inArray(schema.auditLog.orgId, [...orgs]),
        eq(schema.auditLog.action, 'sms.inbound_unmatched'),
        sql`${schema.auditLog.detail}->>'messageHash' = ${messageHash}`,
      ),
    )
    .limit(1)
  return rows.length > 0
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
    // §2.3: why, and counts — never the number, never the words, never the
    // provider's message id (only its hash, `messageHash`).
    detail,
  }).catch(() => {})
}
