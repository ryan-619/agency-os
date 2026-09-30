/**
 * The dry run of the send path, and the consent ledger (§2.1).
 *
 * Every screen that wants to say "could we message this person?" — the
 * contacts ledger, the check-send route, the `check_send` tool — reads the
 * answer from HERE, and here reads it from the sender's own fact-gatherer.
 * `previewSend` builds the SAME facts `dispatchTouch` builds, through
 * `sendFactsFor`, and hands them to the same `decideSend`. A preview that
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
  decideSend, suppressionKeysFor,
  type Channel, type SendDecision, type SuppressionKind,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { sendFactsFor } from './outreach.js'

export interface SendPreviewInput {
  readonly orgId: string
  readonly contactId: string
  readonly campaignId: string
  /** Injectable for tests; the caller passes `new Date()`. */
  readonly now?: Date
  /**
   * When the words being asked about were written, for the stale-evidence
   * step (§2.2). Omitted: a message written NOW — the question a screen asks
   * about a person, before any draft exists. A Date: a STORED draft's
   * `created_at`, so the preview asks what the sender will ask about those
   * words (`evidenceAsOfFor(touch)` gives it). Null: an answer to a reply,
   * which quotes no scan.
   */
  readonly writtenAt?: Date | null
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
   * The consent fact the DECISION read. For a paused contact with no
   * recorded refusal this is the pause standing in for one (see
   * `sendFactsFor`); `consentRecorded` is the row as stored.
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
   * Whether the scan the words could quote is past its re-verification
   * deadline now (§2.2) — judged at `writtenAt`, from the scan's `ran_at`.
   */
  readonly evidenceStale: boolean
  readonly quietStart: string
  readonly quietEnd: string
  readonly sentToday: number
  readonly dailyCap: number
  readonly campaignStatus: string
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
 * written at `writtenAt` (now, unless the caller names a stored draft's
 * moment), and calls `decideSend`. Writes nothing.
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
    now,
  })
  if ('missing' in gathered) return { ok: false, reason: 'missing', message: gathered.missing }

  const { facts, recipient, zoneFrom, paused, pausedReason, consentRecorded } = gathered
  const decision = decideSend(facts)
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
      evidenceStale: facts.evidenceStale,
      quietStart: facts.quietStart,
      quietEnd: facts.quietEnd,
      sentToday: facts.sentToday,
      dailyCap: facts.dailyCap,
      campaignStatus: facts.campaignStatus,
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
    })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
    .limit(1)
  const contact = contactRows[0]
  if (!contact) return null

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
