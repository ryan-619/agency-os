/**
 * The send path's I/O half (PROMPT.md §8.4).
 *
 * The DECISION is `decideSend` in `packages/core`, pure and tested offline.
 * This gathers the facts it needs and obeys what it says. The split is the
 * point: the rules with legal consequences are in a function that needs no
 * database, and this file cannot reorder them, skip one, or add a special
 * case — it does not perform the checks, it only supplies their inputs.
 *
 * §8.4's order, end to end:
 *
 *   suppression → consent → quiet hours → daily cap → approval gate
 *      ↑ gathered here, decided in core ↑         ↑ this file, from here on ↑
 *   → provider send → write `touches` → write `audit_log`
 *
 * `sendOne` below is the only function in this codebase that may cause a
 * message to leave the building, and it takes the provider as an argument so
 * that every channel and every test uses the same path.
 */
import { and, count, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'
import {
  decideSend, suppressionKeysFor,
  type Channel, type SendDecision, type SendFacts,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'

export type TouchRow = typeof schema.touches.$inferSelect

/**
 * What actually puts a message on the wire.
 *
 * An interface so SMTP and SendGrid sit behind the same shape (§8.4), and so
 * a test can assert the send path refuses WITHOUT a provider that could
 * accidentally deliver something. Note what it does NOT get: the decision. A
 * provider cannot be asked to decide, only to deliver.
 */
export interface MessageProvider {
  readonly name: string
  send(message: {
    readonly to: string
    readonly subject: string
    readonly body: string
  }): Promise<{ readonly providerId: string }>
}

export interface SendRequest {
  readonly orgId: string
  readonly campaignId: string
  readonly contactId: string
  readonly companyId?: string | null
  readonly subject: string
  readonly body: string
  /** Injectable for tests; the caller passes `new Date()`. */
  readonly now?: Date
}

export interface SendResult {
  /**
   * The `touches` row this produced, or null.
   *
   * Null only when there was nothing to record it against — a campaign or
   * contact that no longer exists, or one belonging to another org. Writing a
   * row then would mean either a dangling foreign key or a message filed under
   * an org that never asked for it, and both are worse than the absence.
   * Every other path, refusals included, writes a row.
   */
  readonly touchId: string | null
  readonly decision: SendDecision
  readonly sent: boolean
}

/**
 * Send one message, or record exactly why not.
 *
 * Every path writes a `touches` row. That is deliberate and it is the reason
 * anyone can answer "why did a campaign of 40 send 12?" — a refusal that left
 * no trace would make the send path silently lossy, which is the failure mode
 * that destroys trust in an outreach tool.
 */
export async function sendOne(
  db: AgencyDb,
  provider: MessageProvider,
  req: SendRequest,
): Promise<SendResult> {
  const now = req.now ?? new Date()
  const facts = await gatherFacts(db, req, now)

  // A contact whose row has vanished, a campaign that has, or either belonging
  // to another org. Not a decision the rules can make — there is nothing to
  // decide about, and nothing to file a record against either: a touch row
  // here would carry a dangling contact_id, or sit in an org that never asked
  // for it. Audited instead, which is where an attempt with no valid subject
  // belongs.
  if ('missing' in facts) {
    await appendAudit(db, {
      orgId: req.orgId,
      actor: 'system',
      action: 'send.no_such_subject',
      subjectType: 'campaign',
      subjectId: req.campaignId,
      detail: { contactId: req.contactId },
    }).catch(() => {})
    return {
      touchId: null,
      decision: {
        allowed: false,
        code: 'unparseable_recipient',
        reason: facts.missing,
        humanCanResolve: true,
      },
      sent: false,
    }
  }

  const decision = decideSend(facts.facts)

  if (!decision.allowed) {
    const touchId = await recordTouch(db, req, {
      status: decision.code === 'needs_approval' ? 'awaiting_approval' : 'refused',
      // A message waiting for a person is not refused, so it carries no
      // refusal code — `touches_refusal_is_explained` requires exactly that
      // correspondence.
      refusalCode: decision.code === 'needs_approval' ? null : decision.code,
      recipient: facts.recipient,
    })
    await appendAudit(db, {
      orgId: req.orgId,
      actor: 'system',
      action: `send.${decision.code}`,
      subjectType: 'touch',
      subjectId: touchId,
      // §2.3: never the body, never the recipient. The rule and the campaign.
      detail: { campaignId: req.campaignId, channel: facts.facts.channel, code: decision.code },
    }).catch(() => {})
    return { touchId, decision, sent: false }
  }

  // Past every check. From here the message really does leave the building.
  const touchId = await recordTouch(db, req, {
    status: 'queued',
    refusalCode: null,
    recipient: facts.recipient,
  })

  let providerId: string
  try {
    const sent = await provider.send({
      to: facts.recipient,
      subject: req.subject,
      body: req.body,
    })
    providerId = sent.providerId
  } catch (err) {
    // A provider failure is NOT a refusal — the rules said yes and the
    // transport did not work, which is a thing to retry. The distinction is
    // why `error` and `refusal_code` are separate columns.
    await db
      .update(schema.touches)
      .set({
        status: 'failed',
        error: (err instanceof Error ? err.message : 'the provider failed').slice(0, 500),
      })
      .where(eq(schema.touches.id, touchId))
    await appendAudit(db, {
      orgId: req.orgId,
      actor: 'system',
      action: 'send.failed',
      subjectType: 'touch',
      subjectId: touchId,
      detail: {
        campaignId: req.campaignId,
        provider: provider.name,
        error: err instanceof Error ? err.name : 'UnknownError',
      },
    }).catch(() => {})
    throw err
  }

  await db
    .update(schema.touches)
    .set({ status: 'sent', sentAt: now, providerId })
    .where(eq(schema.touches.id, touchId))

  // §8.4's last step, and §2.3's constraint on it: the audit row records that
  // a message went, to whom it was addressed by ID, and through what. Not the
  // subject and not the body.
  await appendAudit(db, {
    orgId: req.orgId,
    actor: 'system',
    action: 'send.sent',
    subjectType: 'touch',
    subjectId: touchId,
    detail: {
      campaignId: req.campaignId,
      contactId: req.contactId,
      channel: facts.facts.channel,
      provider: provider.name,
      providerId,
    },
  }).catch(() => {})

  return { touchId, decision, sent: true }
}

/**
 * Everything `decideSend` needs, in three queries.
 *
 * Deliberately gathered in ONE place. A caller assembling these itself is a
 * caller that can forget the domain half of the suppression lookup, or read
 * the sender's timezone, and those are the bugs the whole design is arranged
 * to make impossible.
 */
async function gatherFacts(
  db: AgencyDb,
  req: SendRequest,
  now: Date,
): Promise<{ facts: SendFacts; recipient: string } | { missing: string }> {
  const rows = await db
    .select({
      campaign: schema.campaigns,
      contact: schema.contacts,
      companyTimeZone: schema.companies.timeZone,
    })
    .from(schema.campaigns)
    .innerJoin(
      schema.contacts,
      and(eq(schema.contacts.id, req.contactId), eq(schema.contacts.orgId, req.orgId)),
    )
    .leftJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
    .where(and(eq(schema.campaigns.id, req.campaignId), eq(schema.campaigns.orgId, req.orgId)))
    .limit(1)

  const row = rows[0]
  if (!row) return { missing: 'That campaign or contact no longer exists. Nothing was sent.' }

  const channel = row.campaign.channel as Channel

  /**
   * A paused contact replied, and a follow-up after a reply reads as nobody
   * having read what they wrote (§8.4). Modelled as a revoked consent rather
   * than a new refusal code: to this contact, on this channel, right now, the
   * answer is no — which is exactly what a revoked consent means, and it
   * routes through the same "nobody may approve past this" rule.
   */
  if (row.contact.pausedAt) {
    return {
      recipient: row.contact.email ?? '',
      facts: {
        channel,
        recipient: row.contact.email ?? '',
        suppressed: false,
        consent: { granted: false, source: row.contact.pausedReason ?? 'paused' },
        recipientTimeZone: row.contact.timeZone ?? row.companyTimeZone ?? null,
        quietStart: row.campaign.quietStart,
        quietEnd: row.campaign.quietEnd,
        sentToday: 0,
        dailyCap: row.campaign.dailyCap,
        autoSend: row.campaign.autoSend,
        now,
      },
    }
  }

  const recipient = recipientFor(channel, row.contact)

  // The suppression lookup, over EVERY key this recipient matches — an email
  // is suppressed by its address and by its domain. `suppressionKeysFor`
  // builds them so no caller has to remember the second one.
  const keys = suppressionKeysFor(recipient, channel)
  let suppressed = false
  if (keys !== null && keys.length > 0) {
    const hits = await db
      .select({ id: schema.suppressions.id })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.orgId, req.orgId),
          or(
            ...keys.map((k) =>
              and(eq(schema.suppressions.kind, k.kind), eq(schema.suppressions.value, k.value)),
            ),
          ),
        ),
      )
      .limit(1)
    suppressed = hits.length > 0
  }

  const consentRows = await db
    .select({ granted: schema.consents.granted, source: schema.consents.source })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.contactId, req.contactId),
        eq(schema.consents.channel, channel),
        eq(schema.consents.orgId, req.orgId),
      ),
    )
    .limit(1)

  // The cap is per campaign per DAY, counted from rows that actually went.
  // Counted in the database rather than tracked in a column: a counter is a
  // second source of truth that drifts, and the drift always favours sending.
  const startOfDay = new Date(now)
  startOfDay.setUTCHours(0, 0, 0, 0)
  const sentTodayRows = await db
    .select({ n: count() })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, req.orgId),
        eq(schema.touches.campaignId, req.campaignId),
        eq(schema.touches.direction, 'out'),
        isNotNull(schema.touches.sentAt),
        gte(schema.touches.sentAt, startOfDay),
      ),
    )

  return {
    recipient,
    facts: {
      channel,
      recipient,
      suppressed,
      consent: consentRows[0] ?? null,
      // The contact's zone, or their company's. Never the sender's, and never
      // derived from a country (§2.1; see 0010).
      recipientTimeZone: row.contact.timeZone ?? row.companyTimeZone ?? null,
      quietStart: row.campaign.quietStart,
      quietEnd: row.campaign.quietEnd,
      sentToday: sentTodayRows[0]?.n ?? 0,
      dailyCap: row.campaign.dailyCap,
      autoSend: row.campaign.autoSend,
      now,
    },
  }
}

/** Where a message on this channel is addressed. */
function recipientFor(channel: Channel, contact: typeof schema.contacts.$inferSelect): string {
  switch (channel) {
    case 'email':
      return contact.email ?? ''
    case 'linkedin':
      return contact.linkedinUrl ?? ''
    case 'sms':
    case 'voice':
    case 'whatsapp':
      return contact.phone ?? ''
    default:
      // An unknown channel has no address, so the send path refuses it as an
      // unparseable recipient rather than guessing at a column.
      return ''
  }
}

async function recordTouch(
  db: AgencyDb,
  req: SendRequest,
  state: {
    status: string
    refusalCode: string | null
    recipient?: string
    error?: string
  },
): Promise<string> {
  const rows = await db
    .insert(schema.touches)
    .values({
      orgId: req.orgId,
      campaignId: req.campaignId,
      contactId: req.contactId,
      companyId: req.companyId ?? null,
      channel: 'email',
      direction: 'out',
      status: state.status,
      refusalCode: state.refusalCode,
      subject: req.subject,
      body: req.body,
      recipient: state.recipient ?? null,
      error: state.error ?? null,
    })
    .returning({ id: schema.touches.id })
  const id = rows[0]?.id
  if (!id) throw new Error('touch insert returned no row')
  return id
}

/**
 * Stop every sequence this contact is in (§8.4).
 *
 * "An inbound reply flips the deal to `replied` and pauses the sequence for
 * that contact immediately." One UPDATE on the contact, so it takes effect for
 * every campaign at once without anything having to enumerate them — and
 * before the next scheduled message can be picked up.
 *
 * Idempotent: a second reply must not overwrite the first reason with a later
 * one, because the first is the one that explains the pause.
 */
export async function pauseContact(
  db: AgencyDb,
  orgId: string,
  contactId: string,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(schema.contacts)
    .set({ pausedAt: now, pausedReason: reason.slice(0, 500) })
    .where(
      and(
        eq(schema.contacts.orgId, orgId),
        eq(schema.contacts.id, contactId),
        sql`${schema.contacts.pausedAt} IS NULL`,
      ),
    )
    .returning({ id: schema.contacts.id })
  return rows.length === 1
}

/** Let a paused contact be contacted again — deliberately, by a person. */
export async function resumeContact(
  db: AgencyDb,
  orgId: string,
  contactId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.contacts)
    .set({ pausedAt: null, pausedReason: null })
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
    .returning({ id: schema.contacts.id })
  return rows.length === 1
}

/**
 * Record an inbound reply, and stop everything queued for that contact.
 *
 * Both halves in one call, because doing one without the other is the bug:
 * a logged reply that did not pause is a follow-up sent to somebody who
 * already answered.
 */
export async function recordInboundReply(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly channel: Channel
    readonly from: string
    readonly subject: string | null
    readonly body: string | null
    readonly providerId?: string | null
    readonly now?: Date
  },
): Promise<{ touchId: string; paused: boolean; cancelled: number }> {
  const now = args.now ?? new Date()

  const inserted = await db
    .insert(schema.touches)
    .values({
      orgId: args.orgId,
      contactId: args.contactId,
      channel: args.channel,
      direction: 'in',
      status: 'replied',
      subject: args.subject,
      body: args.body,
      recipient: args.from,
      providerId: args.providerId ?? null,
      sentAt: now,
    })
    .returning({ id: schema.touches.id })
  const touchId = inserted[0]?.id
  if (!touchId) throw new Error('inbound touch insert returned no row')

  const paused = await pauseContact(db, args.orgId, args.contactId, `replied ${now.toISOString()}`, now)

  // Anything already queued for them is now wrong. Marked refused rather than
  // deleted: the record that it was ABOUT to go, and did not, is the useful
  // one.
  const cancelled = await db
    .update(schema.touches)
    .set({ status: 'refused', refusalCode: 'consent_revoked' })
    .where(
      and(
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.contactId, args.contactId),
        eq(schema.touches.direction, 'out'),
        inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved']),
      ),
    )
    .returning({ id: schema.touches.id })

  await appendAudit(db, {
    orgId: args.orgId,
    actor: 'system',
    action: 'contact.replied',
    subjectType: 'contact',
    subjectId: args.contactId,
    // §2.3: the fact and the count, never the reply's text.
    detail: { channel: args.channel, paused, cancelledQueued: cancelled.length },
  }).catch(() => {})

  return { touchId, paused, cancelled: cancelled.length }
}
