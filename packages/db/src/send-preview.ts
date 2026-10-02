/**
 * The dry run of the send path, and the consent ledger (§2.1).
 *
 * Every screen that wants to say "could we message this person?" — the
 * contacts ledger, the check-send route, the `check_send` tool — reads the
 * answer from HERE, and here reads it from the sender's own fact-gatherer.
 * `previewSend` builds the SAME facts `dispatchTouch` builds, through
 * `sendFactsFor`, and hands them to the same `decideSend`, through the
 * sender's own `decideGathered`. A preview that
 * gathered its own facts would be a second opinion about §2.1, and the one
 * thing a second opinion can do is disagree with the sender at the moment
 * somebody trusted it.
 *
 * Writes nothing. A preview is a question, and asking it must not queue,
 * claim, refuse or audit anything — `test/send-preview.test.ts` counts the
 * `touches` rows before and after.
 */
import { and, eq, or } from 'drizzle-orm'
import {
  pauseReasonClass, suppressionKeysFor,
  type Channel, type PauseReasonClass, type SendDecision, type SuppressionKind,
} from '@agency/core'
import { TEMPLATE_CHANNELS, type TemplateCategory, type TemplateFacts } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { channelMismatch, decideGathered, sendFactsFor, type EvidenceAsOf, type MessageWords } from './outreach.js'
// Review round 10, [2]: the ledger asks Resume's own shared-number question.
import { heldForUnrecordedSharedNumber } from './sms.js'

export interface SendPreviewInput {
  readonly orgId: string
  readonly contactId: string
  readonly campaignId: string
  /** Injectable for tests; the caller passes `new Date()`. */
  readonly now?: Date
  /**
   * When the words being asked about were written, for the stale-evidence
   * step (§2.2). Omitted: a message written NOW — the question a screen asks
   * about a person, before any draft exists. A STORED draft's row
   * (`evidenceAsOfFor(touch)` gives it): the preview asks what the sender
   * will ask about those words, against the row's stored `created_at` — to
   * the microsecond, which a `Date` cannot carry. A `Date`: words written at
   * that instant and stored nowhere. Null: an answer to a reply, which
   * quotes no scan.
   *
   * A stored draft is also asked about on ITS OWN channel, as the sender
   * sends it (r4); every other form takes the campaign's.
   */
  readonly writtenAt?: EvidenceAsOf
  /**
   * The words, for the template steps on SMS and WhatsApp (0019): the
   * template a message names and its body — a draft about to be written
   * (`smsDraft`'s dry run), or a stored one a screen holds. Omitted: the
   * stored draft `writtenAt` names, if it names one; otherwise this is a
   * question about the PERSON, answered as if the message were rendered
   * from one of the channel's active templates (`facts.template.source`
   * says which).
   */
  readonly words?: MessageWords
}

/** The sender's facts, plus how each one was arrived at, for a screen to show. */
export interface SendPreviewFacts {
  readonly channel: Channel
  /** The address, number or profile the message would go to; null when the contact has none. */
  readonly recipient: string | null
  readonly suppressed: boolean
  /** Every key the suppression lookup used. Null means the recipient could
   *  not be normalised, so no row could ever have matched (a refusal). */
  readonly suppressionKeys: readonly { kind: SuppressionKind; value: string }[] | null
  /**
   * The consent fact the DECISION read: the row as recorded, for a paused
   * contact too. A pause is its own fact (`paused`) and its own refusal
   * (`paused`); it no longer stands in for a revoked consent.
   */
  readonly consent: { granted: boolean; source: string } | null
  /** The consent row for this channel as recorded — null when nobody asked. */
  readonly consentRecorded: { granted: boolean; source: string } | null
  readonly recipientTimeZone: string | null
  /** Whose zone quiet hours were evaluated in. Null is the `unknown_timezone` refusal. */
  readonly zoneFrom: 'contact' | 'company' | null
  readonly paused: boolean
  /** Why they are paused, as recorded (`replied <iso>` for a reply). Null when not paused. */
  readonly pausedReason: string | null
  /**
   * What paused them, as a CLASS (`pauseReasonClass`) — what a screen or the
   * agent words its advice by, since only a reply's own pause is ended by
   * answering it. Null when not paused.
   */
  readonly pausedFor: PauseReasonClass | null
  /**
   * Whether Resume refuses this pause until a shared number's STOP is
   * recorded (`heldForUnrecordedSharedNumber`, the gate `contactResumeByHand`
   * asks; review round 10, [2]). A holder whose own pause — a teammate's,
   * an unsubscribe's — stood instead of the hold reads as any pause of its
   * class, which a person lifts with Resume; this says they cannot, yet.
   * False when they are not paused. The decision's sentence says it too
   * (`decideGathered`).
   */
  readonly sharedNumberHold: boolean
  /**
   * Whether the words may not quote the scan behind them (§2.2): it is past
   * its re-verification deadline now — judged at `writtenAt`, from the
   * scan's `ran_at` — or a newer successful scan has superseded it.
   */
  readonly evidenceStale: boolean
  /**
   * Whether a newer SUCCESSFUL scan of the company has superseded the one
   * behind the words (r4, review round 3, finding 4) — one of the two ways
   * `evidenceStale` is true, for a screen to say "draft it again from the
   * latest scan" rather than "re-scan".
   */
  readonly evidenceSuperseded: boolean
  readonly quietStart: string
  readonly quietEnd: string
  readonly sentToday: number
  readonly dailyCap: number
  readonly campaignStatus: string
  /**
   * The template step, on SMS and WhatsApp (0019); null on other channels.
   *
   *  - `message`: about real words — given, or the stored draft's. `active`
   *    false is the `no_template` refusal (none named, none in this org on
   *    this channel, or deactivated); `matches` false is `template_mismatch`.
   *  - `any_active`: a question about the person, asked before any words
   *    exist. The decision assumed a message rendered from one of the
   *    channel's active templates — a non-promotional one when there is
   *    one, so TRAI's band does not hold an answer about a person — and
   *    `activeOnChannel` says how many there are. None is `no_template`,
   *    which is true of anything one could write.
   */
  readonly template: {
    readonly source: 'message' | 'any_active'
    readonly active: boolean
    readonly matches: boolean
    readonly category: TemplateCategory | null
    readonly activeOnChannel?: number
  } | null
}

export type SendPreview =
  | {
      readonly ok: true
      readonly decision: SendDecision
      /**
       * Whether a real message would stop at the approval queue. Reported
       * BESIDE the decision rather than inside it: the preview asks about
       * §2.1 with `approvedByHuman: true`, so the answer is about the person
       * and the rules, not about who has clicked what yet.
       */
      readonly wouldNeedApproval: boolean
      readonly facts: SendPreviewFacts
    }
  | {
      readonly ok: false
      readonly reason: 'no_such_contact' | 'no_such_campaign' | 'missing'
      readonly message: string
    }

/**
 * The dry run. Builds the SAME facts `dispatchTouch` builds (through
 * `sendFactsFor`), for a hypothetical human-approved touch whose words were
 * written at `writtenAt` (now, unless the caller names a stored draft), and
 * calls `decideSend`. Writes nothing.
 */
export async function previewSend(db: AgencyDb, input: SendPreviewInput): Promise<SendPreview> {
  const now = input.now ?? new Date()

  // The two subjects are checked separately so the answer can say WHICH is
  // missing. `sendFactsFor` joins them and can only say "one of these".
  const contacts = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, input.orgId), eq(schema.contacts.id, input.contactId)))
    .limit(1)
  if (!contacts[0]) {
    return { ok: false, reason: 'no_such_contact', message: 'No contact with that id is in this org. Nothing was checked.' }
  }
  const campaigns = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, input.orgId), eq(schema.campaigns.id, input.campaignId)))
    .limit(1)
  if (!campaigns[0]) {
    return { ok: false, reason: 'no_such_campaign', message: 'No campaign with that id is in this org. Nothing was checked.' }
  }

  const gathered = await sendFactsFor(db, {
    orgId: input.orgId,
    campaignId: input.campaignId,
    contactId: input.contactId,
    approvedByHuman: true,
    evidenceAsOf: input.writtenAt === undefined ? now : input.writtenAt,
    ...(input.words ? { words: input.words } : {}),
    now,
  })
  if ('missing' in gathered) return { ok: false, reason: 'missing', message: gathered.missing }

  const { recipient, zoneFrom, paused, pausedReason, consentRecorded } = gathered
  let facts = gathered.facts
  // 0019: the template step. About real words when there are any; otherwise
  // about the person, with the words assumed to be one of the channel's
  // active templates — said so in `template.source`, never silently.
  let template: SendPreviewFacts['template'] = null
  if (TEMPLATE_CHANNELS.has(facts.channel)) {
    if (gathered.wordsKnown) {
      template = facts.template
        ? { source: 'message', ...facts.template }
        : { source: 'message', active: false, matches: false, category: null }
    } else {
      const active = await db
        .select({ category: schema.messageTemplates.category })
        .from(schema.messageTemplates)
        .where(
          and(
            eq(schema.messageTemplates.orgId, input.orgId),
            eq(schema.messageTemplates.channel, facts.channel),
            eq(schema.messageTemplates.active, true),
          ),
        )
      const pick = active.find((t) => t.category !== 'promotional') ?? active[0]
      const assumed: TemplateFacts | null = pick
        ? { active: true, matches: true, category: pick.category as TemplateCategory }
        : null
      facts = { ...facts, template: assumed }
      template = {
        source: 'any_active',
        active: assumed !== null,
        matches: assumed !== null,
        category: assumed?.category ?? null,
        activeOnChannel: active.length,
      }
    }
  }
  // r4: the sender's own wording of a stale-evidence refusal — aged, or
  // superseded by a newer scan (`decideGathered`) — over the facts above,
  // the assumed template included.
  const decision = decideGathered({ ...gathered, facts })
  // r4: a stored message whose campaign now sends on another channel — what
  // the sender refuses it as, in its words (`channelMismatch`).
  const mismatch = channelMismatch({ ...gathered, facts }, decision)
  if (mismatch !== null) return { ok: false, reason: 'missing', message: mismatch }
  return {
    ok: true,
    decision,
    wouldNeedApproval: !facts.autoSend,
    facts: {
      channel: facts.channel,
      recipient: recipient || null,
      suppressed: facts.suppressed,
      suppressionKeys: suppressionKeysFor(recipient, facts.channel),
      consent: facts.consent,
      consentRecorded,
      recipientTimeZone: facts.recipientTimeZone,
      zoneFrom,
      paused,
      pausedReason,
      pausedFor: paused ? pauseReasonClass(pausedReason) : null,
      sharedNumberHold: gathered.sharedNumberHold,
      evidenceStale: facts.evidenceStale,
      evidenceSuperseded: gathered.evidenceSuperseded,
      quietStart: facts.quietStart,
      quietEnd: facts.quietEnd,
      sentToday: facts.sentToday,
      dailyCap: facts.dailyCap,
      campaignStatus: facts.campaignStatus,
      template,
    },
  }
}

// ---------------------------------------------------------------------------
// The consent ledger
// ---------------------------------------------------------------------------

/** The four channels a consent row can be about (0003's CHECK). */
export const CONSENT_CHANNELS = ['email', 'sms', 'voice', 'whatsapp'] as const
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number]

export interface ConsentState {
  readonly channel: ConsentChannel
  /**
   * Three states, because "nobody asked" and "they said no" are different
   * facts and only one must never be re-asked (§2.1). Both are refusals to
   * the send path.
   */
  readonly state: 'granted' | 'refused' | 'never_asked'
  readonly source: string | null
  readonly recordedAt: Date | null
  readonly evidence: Record<string, unknown> | null
}

/**
 * Where a person stands on the suppression list, per key.
 *
 * `unparseable` is its own answer and is never rendered as clear: the send
 * path refuses such a recipient precisely because no row could ever have
 * matched them. `none` means the contact has nothing on file for that key.
 */
export type SuppressionStanding = 'clear' | 'suppressed' | 'unparseable' | 'none'

export interface ConsentLedger {
  readonly contactId: string
  readonly channels: readonly ConsentState[]
  /**
   * Whether they are paused and Resume refuses that pause until a shared
   * number's STOP is recorded — `previewSend`'s `sharedNumberHold`, the gate
   * `contactResumeByHand` asks (review round 10, [2]). /contacts words the
   * row's Resume by it, as it does for the hold's own shape, and
   * `get_consent` says it. False when they are not paused.
   */
  readonly sharedNumberHold: boolean
  readonly suppression: {
    readonly email: SuppressionStanding
    readonly phone: SuppressionStanding
    readonly linkedin: SuppressionStanding
    /** The rows that matched, with the path that wrote each (0018). */
    readonly matches: readonly { kind: SuppressionKind; value: string; source: string | null; reason: string }[]
  }
}

/**
 * Everything §2.1 records about one person, in one read: consent per channel
 * and the suppression list's answer for every key they have. Null when the
 * contact is not in this org.
 */
export async function consentLedgerFor(
  db: AgencyDb,
  orgId: string,
  contactId: string,
): Promise<ConsentLedger | null> {
  const contactRows = await db
    .select({
      id: schema.contacts.id,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      linkedinUrl: schema.contacts.linkedinUrl,
      pausedAt: schema.contacts.pausedAt,
      pausedReason: schema.contacts.pausedReason,
    })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
    .limit(1)
  const contact = contactRows[0]
  if (!contact) return null
  // One more read, for a paused person only — the page already reads per row.
  const sharedNumberHold = contact.pausedAt !== null && (await heldForUnrecordedSharedNumber(db, orgId, contact))

  const consentRows = await db
    .select()
    .from(schema.consents)
    .where(and(eq(schema.consents.orgId, orgId), eq(schema.consents.contactId, contactId)))
  const channels: ConsentState[] = CONSENT_CHANNELS.map((channel) => {
    const row = consentRows.find((c) => c.channel === channel)
    if (!row) return { channel, state: 'never_asked', source: null, recordedAt: null, evidence: null }
    return {
      channel,
      state: row.granted ? 'granted' : 'refused',
      source: row.source,
      recordedAt: row.recordedAt,
      evidence: (row.evidence ?? null) as Record<string, unknown> | null,
    }
  })

  // The same key builder the send path uses, so the ledger cannot check an
  // address without its domain or read a bare LinkedIn handle as a profile.
  const keysOf = (raw: string | null, channel: Channel) => {
    if (!raw) return { standing: 'none' as const, keys: [] as { kind: SuppressionKind; value: string }[] }
    const keys = suppressionKeysFor(raw, channel)
    if (keys === null) return { standing: 'unparseable' as const, keys: [] }
    return { standing: 'pending' as const, keys: [...keys] }
  }
  const email = keysOf(contact.email, 'email')
  const phone = keysOf(contact.phone, 'sms')
  const linkedin = keysOf(contact.linkedinUrl, 'linkedin')

  const allKeys = [...email.keys, ...phone.keys, ...linkedin.keys]
  const matches =
    allKeys.length === 0
      ? []
      : await db
          .select({
            kind: schema.suppressions.kind,
            value: schema.suppressions.value,
            source: schema.suppressions.source,
            reason: schema.suppressions.reason,
          })
          .from(schema.suppressions)
          .where(
            and(
              eq(schema.suppressions.orgId, orgId),
              or(
                ...allKeys.map((k) =>
                  and(eq(schema.suppressions.kind, k.kind), eq(schema.suppressions.value, k.value)),
                ),
              ),
            ),
          )

  const standingOf = (k: { standing: 'none' | 'unparseable' | 'pending'; keys: { kind: SuppressionKind; value: string }[] }): SuppressionStanding => {
    if (k.standing !== 'pending') return k.standing
    const hit = matches.some((m) => k.keys.some((key) => key.kind === m.kind && key.value === m.value))
    return hit ? 'suppressed' : 'clear'
  }

  return {
    contactId: contact.id,
    channels,
    sharedNumberHold,
    suppression: {
      email: standingOf(email),
      phone: standingOf(phone),
      linkedin: standingOf(linkedin),
      matches: matches.map((m) => ({
        kind: m.kind as SuppressionKind,
        value: m.value,
        source: m.source,
        reason: m.reason,
      })),
    },
  }
}
