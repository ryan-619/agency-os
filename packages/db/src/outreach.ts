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
 * ## The shape of a message's life
 *
 *   awaiting_approval  the agent's `queue_touch`, or a person's own draft;
 *                      a person reads it in /approvals …
 *   approved           … and says yes, naming a recipient and a campaign.
 *   queued             an auto-send campaign's message, needing nobody.
 *   → dispatchTouch    the ONE function that calls a provider. It re-runs
 *                      every §2.1 rule on the way — a human approved the
 *                      WORDS, not the recipient's opt-out status an hour later.
 *   sent | refused | failed
 *
 * `dispatchTouch` is the only function in this codebase that may cause a
 * message to leave the building, and it takes the provider as an argument so
 * that every channel and every test uses the same path.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import {
  decideSend, normaliseEmail, suppressionKeysFor,
  type Channel, type SendDecision, type SendFacts, classifyReply, type ReplyKind,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { addSuppression } from './campaigns.js'
import { advanceDeal } from './deals.js'

export type TouchRow = typeof schema.touches.$inferSelect

/**
 * Where an inbound path shouts when §2.1's obligation is not met. The worker
 * and the web route each have a logger; a caller that passes none gets a
 * structured line on stderr, because the one thing this must never be is
 * silent. Ids only — never an address, never a body.
 */
export interface InboundLog {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

const stderrLog: InboundLog = {
  error: (message, fields) => {
    console.error(JSON.stringify({ level: 'error', message, ...fields, at: new Date().toISOString() }))
  },
}

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
  /**
   * What this provider can carry. An SMTP transport carries email and only
   * email; handed a LinkedIn touch it would mail whatever was in
   * `linkedin_url`, with the email suppression list never consulted. Found
   * by review. `dispatchTouch` refuses a channel the provider does not name,
   * and the sender never picks one up.
   */
  readonly channels: readonly Channel[]
  send(message: {
    readonly to: string
    readonly subject: string
    readonly body: string
    /**
     * Extra headers the send path built: `In-Reply-To`/`References` for an
     * answer to a reply, `List-Unsubscribe` from the worker. Optional, so a
     * provider that cannot carry headers — a person, on LinkedIn — still
     * satisfies the interface by ignoring them.
     */
    readonly headers?: Readonly<Record<string, string>>
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
 * Send one message programmatically: record it, then dispatch it.
 *
 * The campaign engine's entry point. It exists so that "send this to this
 * contact under this campaign" is one call — but everything that matters
 * happens in `dispatchTouch`, which is also what an approved draft goes
 * through. Two entry points, one path.
 */
export async function sendOne(
  db: AgencyDb,
  provider: MessageProvider,
  req: SendRequest,
): Promise<SendResult> {
  const now = req.now ?? new Date()

  // The subject has to exist before a row can be filed against it. A row
  // pointing at a contact that is not there, or filed in an org that never
  // asked, is worse than no row — so this is checked before anything is
  // written, and the attempt is audited instead.
  const subject = await subjectExists(db, req.orgId, req.campaignId, req.contactId)
  if (!subject) {
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
        reason: 'That campaign or contact no longer exists. Nothing was sent.',
        humanCanResolve: true,
      },
      sent: false,
    }
  }

  const rows = await db
    .insert(schema.touches)
    .values({
      orgId: req.orgId,
      campaignId: req.campaignId,
      contactId: req.contactId,
      companyId: req.companyId ?? subject.companyId,
      channel: subject.channel,
      direction: 'out',
      status: 'queued',
      subject: req.subject,
      body: req.body,
    })
    .returning()
  const touch = rows[0]
  if (!touch) throw new Error('touch insert returned no row')

  // Claim it before dispatching, exactly as the sender tick does. Between
  // the insert above and the provider below, a tick could otherwise find
  // this same `queued` row, claim it, and send it a second time. Found by
  // review. The claim must succeed here — nothing else has seen the row —
  // and if it somehow does not, the tick owns it now.
  const claimed = await db
    .update(schema.touches)
    .set({ status: 'sending' })
    .where(and(eq(schema.touches.id, touch.id), eq(schema.touches.status, 'queued')))
    .returning({ id: schema.touches.id })
  if (claimed.length === 0) {
    return {
      touchId: touch.id,
      decision: { allowed: false, code: 'needs_approval', reason: 'The worker picked this message up first; it will report on it.', humanCanResolve: true },
      sent: false,
    }
  }

  return dispatchTouch(db, provider, touch, { now })
}

/**
 * Take a message that is `approved` or `queued` and either send it or record
 * exactly why not.
 *
 * Every path leaves the row in a terminal, explained state. That is what lets
 * anyone answer "why did a campaign of 40 send 12?" — a refusal that left no
 * trace would make the send path silently lossy, which is the failure mode
 * that destroys trust in an outreach tool.
 */
export async function dispatchTouch(
  db: AgencyDb,
  provider: MessageProvider,
  touch: TouchRow,
  opts: {
    readonly now?: Date
    /**
     * Headers the CALLER adds to an outbound message — the worker's
     * `List-Unsubscribe`, for one. Merged over the threading headers this
     * function builds itself; a null return adds nothing. Never consulted for
     * the decision, which needs no headers.
     */
    readonly headersFor?: (touch: TouchRow) => Readonly<Record<string, string>> | null
  } = {},
): Promise<SendResult> {
  const now = opts.now ?? new Date()

  // Only these two statuses may reach a provider. Anything else arriving here
  // is a caller that skipped the queue, and it is refused rather than obeyed.
  if (touch.status !== 'approved' && touch.status !== 'queued') {
    return {
      touchId: touch.id,
      decision: {
        allowed: false,
        code: 'needs_approval',
        reason: `A message in status "${touch.status}" cannot be dispatched. Nothing was sent.`,
        humanCanResolve: true,
      },
      sent: false,
    }
  }

  // A channel this provider cannot carry is left exactly as it is — not
  // refused, because a provider that CAN carry it may exist later — and the
  // caller is told. The sender's due query never hands over such a row in
  // the first place; this is the guard for a direct caller.
  if (!provider.channels.includes(touch.channel as Channel)) {
    return {
      touchId: touch.id,
      decision: {
        allowed: false,
        code: 'needs_approval',
        reason: `No configured provider sends ${touch.channel}. Nothing was sent; the message is left as it was.`,
        humanCanResolve: true,
      },
      sent: false,
    }
  }

  const facts = await gatherFacts(db, touch, now)
  if ('missing' in facts) {
    await settle(db, touch.id, { status: 'refused', refusalCode: 'unparseable_recipient', error: facts.missing })
    return {
      touchId: touch.id,
      decision: { allowed: false, code: 'unparseable_recipient', reason: facts.missing, humanCanResolve: true },
      sent: false,
    }
  }

  const decision = decideSend(facts.facts)

  if (!decision.allowed) {
    if (decision.code === 'needs_approval') {
      // A `queued` message whose campaign turned auto-send OFF between
      // queueing and now. Not refused: it goes to a person, which is what the
      // campaign now asks for.
      await settle(db, touch.id, { status: 'awaiting_approval', refusalCode: null, recipient: facts.recipient })
    } else {
      await settle(db, touch.id, { status: 'refused', refusalCode: decision.code, recipient: facts.recipient })
    }
    await appendAudit(db, {
      orgId: touch.orgId,
      actor: 'system',
      action: `send.${decision.code}`,
      subjectType: 'touch',
      subjectId: touch.id,
      // §2.3: never the body, never the recipient. The rule and the campaign.
      detail: { campaignId: touch.campaignId, channel: facts.facts.channel, code: decision.code },
    }).catch(() => {})
    return { touchId: touch.id, decision, sent: false }
  }

  // Past every check. One last look before the wire: a reply can land
  // between `gatherFacts` reading the contact and this line, and the cancel
  // that reply performs skips rows that are already `sending`. Cheap, and
  // it closes the window to the width of the provider call itself.
  if (touch.contactId) {
    const [fresh] = await db
      .select({ pausedAt: schema.contacts.pausedAt })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, touch.contactId))
      .limit(1)
    if (fresh?.pausedAt) {
      await settle(db, touch.id, { status: 'refused', refusalCode: 'consent_revoked', recipient: facts.recipient })
      return {
        touchId: touch.id,
        decision: { allowed: false, code: 'consent_revoked', reason: 'This contact replied a moment ago. Nothing was sent.', humanCanResolve: false },
        sent: false,
      }
    }
  }

  // Threading, built HERE rather than by the caller: an outbound row that
  // answers a reply names it in `answers_touch_id` (0018), and the reply's
  // `provider_id` is the Message-ID the other side's client will look for in
  // In-Reply-To and References. One place, so every caller's answer threads.
  const headers: Record<string, string> = {}
  if (touch.answersTouchId) {
    const parent = await db
      .select({ providerId: schema.touches.providerId })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.id, touch.answersTouchId),
          eq(schema.touches.orgId, touch.orgId),
          eq(schema.touches.direction, 'in'),
        ),
      )
      .limit(1)
    const messageId = parent[0]?.providerId
    if (messageId) {
      headers['In-Reply-To'] = messageId
      headers['References'] = messageId
    }
  }
  Object.assign(headers, opts.headersFor?.(touch) ?? {})

  let providerId: string
  try {
    const sent = await provider.send({
      to: facts.recipient,
      subject: touch.subject ?? '',
      body: touch.body ?? '',
      headers,
    })
    providerId = sent.providerId
  } catch (err) {
    // A provider failure is NOT a refusal — the rules said yes and the
    // transport did not work, which is a thing to retry. The distinction is
    // why `error` and `refusal_code` are separate columns.
    await settle(db, touch.id, {
      status: 'failed',
      refusalCode: null,
      recipient: facts.recipient,
      error: (err instanceof Error ? err.message : 'the provider failed').slice(0, 500),
    })
    await appendAudit(db, {
      orgId: touch.orgId,
      actor: 'system',
      action: 'send.failed',
      subjectType: 'touch',
      subjectId: touch.id,
      detail: {
        campaignId: touch.campaignId,
        provider: provider.name,
        error: err instanceof Error ? err.name : 'UnknownError',
      },
    }).catch(() => {})
    throw err
  }

  await db
    .update(schema.touches)
    .set({ status: 'sent', sentAt: now, providerId, recipient: facts.recipient })
    .where(eq(schema.touches.id, touch.id))

  // A company that has been written to is `contacted`, unless it is already
  // further along. Forward only, so a follow-up never knocks a deal back.
  if (touch.companyId) {
    await advanceDeal(db, { orgId: touch.orgId, companyId: touch.companyId, to: 'contacted' }).catch(() => {})
  }

  // §8.4's last step, and §2.3's constraint on it: the audit row records that
  // a message went, to whom it was addressed by ID, and through what. Not the
  // subject and not the body.
  await appendAudit(db, {
    orgId: touch.orgId,
    actor: 'system',
    action: 'send.sent',
    subjectType: 'touch',
    subjectId: touch.id,
    detail: {
      campaignId: touch.campaignId,
      contactId: touch.contactId,
      channel: facts.facts.channel,
      provider: provider.name,
      providerId,
      approvedBy: touch.approvedBy,
    },
  }).catch(() => {})

  return { touchId: touch.id, decision, sent: true }
}

async function settle(
  db: AgencyDb,
  touchId: string,
  state: { status: string; refusalCode: string | null; recipient?: string; error?: string },
): Promise<void> {
  await db
    .update(schema.touches)
    .set({
      status: state.status,
      refusalCode: state.refusalCode,
      ...(state.recipient !== undefined ? { recipient: state.recipient } : {}),
      ...(state.error !== undefined ? { error: state.error } : {}),
    })
    .where(eq(schema.touches.id, touchId))
}

async function subjectExists(
  db: AgencyDb,
  orgId: string,
  campaignId: string,
  contactId: string,
): Promise<{ companyId: string; channel: string } | null> {
  const rows = await db
    .select({ companyId: schema.contacts.companyId, channel: schema.campaigns.channel })
    .from(schema.campaigns)
    .innerJoin(
      schema.contacts,
      and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)),
    )
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The facts for one touch, or why there cannot be any.
 *
 * A thin wrapper over `sendFactsFor`: it decides what a ROW says about who
 * approved it, and hands everything else to the one fact-gatherer.
 */
async function gatherFacts(
  db: AgencyDb,
  touch: TouchRow,
  now: Date,
): Promise<{ facts: SendFacts; recipient: string } | { missing: string }> {
  if (!touch.campaignId) {
    // Every outbound message carries a campaign, because the campaign is
    // where the cap and the quiet hours live. A draft without one is a draft
    // the approver has not finished with.
    return { missing: 'This message has no campaign, so it has no daily cap or quiet hours. Nothing was sent.' }
  }
  if (!touch.contactId) {
    return { missing: 'This message has no recipient. Nothing was sent.' }
  }
  return sendFactsFor(db, {
    orgId: touch.orgId,
    campaignId: touch.campaignId,
    contactId: touch.contactId,
    approvedByHuman: touch.status === 'approved' && touch.approvedBy !== null,
    now,
  })
}

/**
 * Everything `decideSend` needs, in three queries.
 *
 * Deliberately gathered in ONE place. A caller assembling these itself is a
 * caller that can forget the domain half of the suppression lookup, or read
 * the sender's timezone, and those are the bugs the whole design is arranged
 * to make impossible.
 *
 * Exported so a DRY RUN (`previewSend` in send-preview.ts) reads exactly what
 * the sender reads and writes nothing. Every screen that says "could we
 * message this person?" reads it from here, through that; a screen with its
 * own idea of the facts is a screen that can disagree with the sender at the
 * moment somebody trusted it. Beside the facts it reports HOW two of them
 * were arrived at — whose zone, and whether the contact is paused — for the
 * screen to show; the decision does not read those.
 */
export async function sendFactsFor(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly campaignId: string
    readonly contactId: string
    readonly approvedByHuman: boolean
    readonly now: Date
  },
): Promise<
  | { facts: SendFacts; recipient: string; zoneFrom: 'contact' | 'company' | null; paused: boolean }
  | { missing: string }
> {
  const { orgId, campaignId, contactId, now } = args

  const rows = await db
    .select({
      campaign: schema.campaigns,
      contact: schema.contacts,
      companyTimeZone: schema.companies.timeZone,
    })
    .from(schema.campaigns)
    .innerJoin(
      schema.contacts,
      and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)),
    )
    .leftJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)))
    .limit(1)

  const row = rows[0]
  if (!row) return { missing: 'That campaign or contact no longer exists. Nothing was sent.' }

  const channel = row.campaign.channel as Channel
  const recipient = recipientFor(channel, row.contact)
  // The contact's zone, or their company's. Never the sender's, and never
  // derived from a country (§2.1; see 0010).
  const zoneFrom = row.contact.timeZone ? 'contact' : row.companyTimeZone ? 'company' : null
  const base = {
    channel,
    recipient,
    recipientTimeZone: row.contact.timeZone ?? row.companyTimeZone ?? null,
    quietStart: row.campaign.quietStart,
    quietEnd: row.campaign.quietEnd,
    dailyCap: row.campaign.dailyCap,
    autoSend: row.campaign.autoSend,
    campaignStatus: row.campaign.status as SendFacts['campaignStatus'],
    approvedByHuman: args.approvedByHuman,
    now,
  }

  /**
   * A paused contact replied, and a follow-up after a reply reads as nobody
   * having read what they wrote (§8.4). Modelled as a revoked consent rather
   * than a new refusal code: to this contact, on this channel, right now, the
   * answer is no — which is exactly what a revoked consent means, and it
   * routes through the same "nobody may approve past this" rule.
   */
  if (row.contact.pausedAt) {
    return {
      recipient,
      zoneFrom,
      paused: true,
      facts: {
        ...base,
        suppressed: false,
        consent: { granted: false, source: row.contact.pausedReason ?? 'paused' },
        sentToday: 0,
      },
    }
  }

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
          eq(schema.suppressions.orgId, orgId),
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
        eq(schema.consents.contactId, contactId),
        eq(schema.consents.channel, channel),
        eq(schema.consents.orgId, orgId),
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
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.campaignId, campaignId),
        eq(schema.touches.direction, 'out'),
        isNotNull(schema.touches.sentAt),
        gte(schema.touches.sentAt, startOfDay),
      ),
    )

  return {
    recipient,
    zoneFrom,
    paused: false,
    facts: {
      ...base,
      suppressed,
      consent: consentRows[0] ?? null,
      sentToday: sentTodayRows[0]?.n ?? 0,
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

// ---------------------------------------------------------------------------
// A person decides on a draft (§2.4)
// ---------------------------------------------------------------------------

/** Drafts waiting for a person, oldest first, with what they are about. */
export async function pendingDrafts(
  db: AgencyDb,
  orgId: string,
  limit = 100,
): Promise<
  Array<{
    touch: TouchRow
    company: { id: string; domain: string; name: string | null } | null
    contact: { id: string; email: string | null; firstName: string | null; lastName: string | null } | null
  }>
> {
  const rows = await db
    .select({
      touch: schema.touches,
      companyId: schema.companies.id,
      companyDomain: schema.companies.domain,
      companyName: schema.companies.name,
      contactId: schema.contacts.id,
      contactEmail: schema.contacts.email,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
    })
    .from(schema.touches)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.touches.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.touches.contactId))
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'out'),
        eq(schema.touches.status, 'awaiting_approval'),
      ),
    )
    .orderBy(asc(schema.touches.createdAt))
    .limit(limit)
  return rows.map((r) => ({
    touch: r.touch,
    company: r.companyId ? { id: r.companyId, domain: r.companyDomain ?? '', name: r.companyName ?? null } : null,
    contact: r.contactId
      ? { id: r.contactId, email: r.contactEmail ?? null, firstName: r.contactFirst ?? null, lastName: r.contactLast ?? null }
      : null,
  }))
}

export type DraftDecision =
  | { readonly ok: true; readonly touch: TouchRow }
  | {
      readonly ok: false
      readonly reason: 'not_found' | 'already_decided' | 'no_such_contact' | 'no_such_campaign' | 'wrong_company' | 'wrong_channel'
    }

/**
 * Approve a draft: name the recipient, the campaign, and yourself.
 *
 * One UPDATE with `status = 'awaiting_approval'` in the predicate, so two
 * people approving at once produce exactly one approval — the same
 * arbitration `decideApproval` uses. The recipient and campaign are set HERE,
 * not by the agent: a draft from chat has neither (Phase 2 had no contacts),
 * and the person approving is the right one to choose.
 *
 * Approving does not send. It marks the row `approved`, and the worker's next
 * tick runs it through every §2.1 rule and then the provider. That is
 * deliberate: the person approved the words, and the rules are re-checked at
 * the moment of sending, not the moment of reading.
 */
export async function approveDraft(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly touchId: string
    readonly contactId: string
    readonly campaignId: string
    readonly approvedBy: string
    readonly note?: string | null
    readonly now?: Date
  },
): Promise<DraftDecision> {
  const touchRows = await db
    .select()
    .from(schema.touches)
    .where(and(eq(schema.touches.orgId, args.orgId), eq(schema.touches.id, args.touchId)))
    .limit(1)
  const touch = touchRows[0]
  if (!touch) return { ok: false, reason: 'not_found' }
  if (touch.status !== 'awaiting_approval') return { ok: false, reason: 'already_decided' }

  const contactRows = await db
    .select({ id: schema.contacts.id, companyId: schema.contacts.companyId })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId)))
    .limit(1)
  const contact = contactRows[0]
  if (!contact) return { ok: false, reason: 'no_such_contact' }

  // A draft written about one company must not be approved to a person at
  // another. The draft quotes that company's findings (§2.2), and sending it
  // elsewhere is a claim about the wrong company.
  if (touch.companyId && contact.companyId !== touch.companyId) {
    return { ok: false, reason: 'wrong_company' }
  }

  const campaignRows = await db
    .select({ id: schema.campaigns.id, channel: schema.campaigns.channel })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, args.orgId), eq(schema.campaigns.id, args.campaignId)))
    .limit(1)
  const campaign = campaignRows[0]
  if (!campaign) return { ok: false, reason: 'no_such_campaign' }

  // A LinkedIn draft approved under an email campaign is not "an email now"
  // — it is a message written for one medium sent through another. Found by
  // review: the row's channel used to be silently rewritten to the campaign's.
  if (campaign.channel !== touch.channel) return { ok: false, reason: 'wrong_channel' }

  const updated = await db
    .update(schema.touches)
    .set({
      status: 'approved',
      contactId: contact.id,
      companyId: touch.companyId ?? contact.companyId,
      campaignId: campaign.id,
      channel: campaign.channel,
      approvedBy: args.approvedBy,
      approvedAt: args.now ?? new Date(),
      decisionNote: args.note?.trim() || null,
    })
    .where(
      and(
        eq(schema.touches.id, touch.id),
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.status, 'awaiting_approval'),
        sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${args.approvedBy} AND u.org_id = ${args.orgId})`,
      ),
    )
    .returning()
  const row = updated[0]
  if (!row) return { ok: false, reason: 'already_decided' }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.approvedBy,
    action: 'draft.approved',
    subjectType: 'touch',
    subjectId: row.id,
    detail: { contactId: contact.id, campaignId: campaign.id, channel: campaign.channel },
  }).catch(() => {})
  return { ok: true, touch: row }
}

/**
 * Deny a draft. The reason is recorded on the row: a draft denied with no note
 * is one the agent will rewrite the same way.
 */
export async function denyDraft(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly touchId: string
    readonly decidedBy: string
    readonly note?: string | null
  },
): Promise<DraftDecision> {
  const updated = await db
    .update(schema.touches)
    .set({
      status: 'refused',
      refusalCode: 'needs_approval',
      decisionNote: args.note?.trim() || 'denied',
    })
    .where(
      and(
        eq(schema.touches.id, args.touchId),
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.status, 'awaiting_approval'),
        sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${args.decidedBy} AND u.org_id = ${args.orgId})`,
      ),
    )
    .returning()
  const row = updated[0]
  if (!row) {
    const current = await db
      .select({ status: schema.touches.status })
      .from(schema.touches)
      .where(and(eq(schema.touches.id, args.touchId), eq(schema.touches.orgId, args.orgId)))
      .limit(1)
    return { ok: false, reason: current[0] ? 'already_decided' : 'not_found' }
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.decidedBy,
    action: 'draft.denied',
    subjectType: 'touch',
    subjectId: row.id,
    detail: { note: row.decisionNote },
  }).catch(() => {})
  return { ok: true, touch: row }
}

/**
 * What the worker's tick dispatches: approved and queued messages that are
 * due, oldest first, across every org.
 *
 * Bounded, because one campaign of a thousand must not monopolise a tick and
 * starve everyone else's — and because the per-campaign cap is enforced
 * inside `dispatchTouch`, the batch size here is about fairness, not about
 * volume.
 */
export async function dueTouches(
  db: AgencyDb,
  limit: number,
  now: Date = new Date(),
  /** The channels the caller's provider can carry. Others are left alone. */
  channels: readonly Channel[] = ['email'],
): Promise<TouchRow[]> {
  if (channels.length === 0) return []
  return db
    .select()
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.direction, 'out'),
        inArray(schema.touches.status, ['approved', 'queued']),
        inArray(schema.touches.channel, [...channels]),
        or(isNull(schema.touches.scheduledFor), lte(schema.touches.scheduledFor, now)),
      ),
    )
    .orderBy(asc(schema.touches.createdAt))
    .limit(limit)
}

// ---------------------------------------------------------------------------
// Replies (§8.4)
// ---------------------------------------------------------------------------

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
export async function resumeContact(db: AgencyDb, orgId: string, contactId: string): Promise<boolean> {
  const rows = await db
    .update(schema.contacts)
    .set({ pausedAt: null, pausedReason: null })
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
    .returning({ id: schema.contacts.id })
  return rows.length === 1
}

/**
 * Words that mean "stop", in a reply.
 *
 * Deliberately narrow: a whole short message, or a first line, that IS an
 * opt-out — not a message that merely contains the word "stop" somewhere in a
 * paragraph about their roadmap. A match adds a SUPPRESSION, which is the
 * strongest thing this system can do, so the bar is a clear statement. A
 * reply that is not clearly an opt-out still pauses the contact, so nothing
 * further goes to them either way; the difference is whether they can ever be
 * contacted again without a person removing a suppression.
 */
const OPT_OUT =
  /^\s*(?:please\s+)?(?:stop|unsubscribe(?:\s+me)?|remove\s+me|opt(?:\s+me)?[\s-]?out|do\s+not\s+(?:contact|email)\s+me(?:\s+again)?|no\s+more\s+emails?|take\s+me\s+off\s+(?:your|the)\s+list|leave\s+me\s+alone)\b[\s.!,]*$/i

export function looksLikeOptOut(body: string | null | undefined): boolean {
  if (!body) return false
  // The person's own words: everything above a quoted reply. A quoted
  // "unsubscribe" link in the message they are replying to must not be read
  // as theirs.
  const own = body.split(/\r?\n(?:>|On .+ wrote:|-{2,}\s*Original Message)/)[0] ?? body
  const first = own.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  return OPT_OUT.test(first) || (own.trim().length <= 60 && OPT_OUT.test(own.trim()))
}

/**
 * Record an inbound reply, and stop everything queued for that contact.
 *
 * Both halves in one call, because doing one without the other is the bug:
 * a logged reply that did not pause is a follow-up sent to somebody who
 * already answered.
 *
 * Also the deal: §8.4 says a reply flips it to `replied`, forward only. And
 * if the reply is an opt-out in so many words, the address goes on the
 * suppression list — the reply IS the opt-out, and recording it anywhere
 * weaker is a promise the send path does not keep.
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
    readonly inReplyTo?: string | null
    /**
     * Whether the mail's HEADERS said it was automatic (Auto-Submitted,
     * Precedence: bulk). The reader that decides it from headers is
     * `mail-signals-and-bounce-pause`'s (wave 3), so nothing passes it yet;
     * the PRECEDENCE is stated here, now, so that feature cannot get it
     * wrong: the opt-out reader runs first on every inbound, and only a body
     * that did not ask to be left alone may be filed as an auto-reply. See
     * the comment at the classification below.
     */
    readonly autoReply?: boolean
    /** See `InboundLog`. Defaults to a structured line on stderr. */
    readonly log?: InboundLog
    readonly now?: Date
  },
): Promise<{
  touchId: string
  paused: boolean
  cancelled: number
  suppressed: boolean
  /**
   * §2.1's Phase 4 obligation: true when the reply asked to be left alone
   * and the suppression row could NOT be written. Already audited and
   * logged by the time the caller sees it; the caller's job is to get a
   * person to record the opt-out by hand.
   */
  optOutNotRecorded: boolean
  deal: string | null
  /** The deterministic kind stored on the inbound touch (§5.5). */
  replyKind: ReplyKind
  /** The company the reply is about, for a caller's own notification. */
  companyId: string | null
  companyDomain: string | null
}> {
  const now = args.now ?? new Date()

  const contactRows = await db
    .select({ companyId: schema.contacts.companyId, companyDomain: schema.companies.domain })
    .from(schema.contacts)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
    .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId)))
    .limit(1)
  const companyId = contactRows[0]?.companyId ?? null
  const companyDomain = contactRows[0]?.companyDomain ?? null

  const inserted = await db
    .insert(schema.touches)
    .values({
      orgId: args.orgId,
      contactId: args.contactId,
      companyId,
      channel: args.channel,
      direction: 'in',
      status: 'replied',
      subject: args.subject,
      body: args.body,
      recipient: args.from,
      providerId: args.providerId ?? null,
      inReplyTo: args.inReplyTo ?? null,
      sentAt: now,
    })
    .returning({ id: schema.touches.id })
  const touchId = inserted[0]?.id
  if (!touchId) throw new Error('inbound touch insert returned no row')

  /**
   * Classified from the SAME opt-out reading that decides the suppression
   * below, rather than a second look at the text. One reading, one answer:
   * a row that says `opted_out` and a suppression that was never written
   * would be two different claims about one reply.
   *
   * The ORDER is §2.1's, not the mail's. The opt-out reader runs FIRST on
   * every inbound; an auto-reply flag from the headers is consulted only
   * for a body that did not ask to be left alone. An out-of-office that
   * says "I have left — remove me from your list" is an opt-out that
   * happens to be automatic, and filing it as `auto_reply` would store no
   * suppression for a person who asked for one. Only a genuine automatic
   * answer skips the pause, the cancel and the deal move: nobody read
   * anything, so nothing about the conversation changed.
   *
   * The deterministic kind is always stored. A model may improve on it
   * afterwards (§5.5) and can only ever move it AMONG the non-opt-out
   * kinds — `opted_out` is settled here, by a pure function, before any
   * model is consulted (§2.1).
   */
  const optedOut = looksLikeOptOut(args.body)
  const automatic = !optedOut && args.autoReply === true
  const replyKind: ReplyKind = automatic ? 'auto_reply' : classifyReply(args.body, optedOut)
  await db
    .update(schema.touches)
    .set({ replyKind })
    .where(eq(schema.touches.id, touchId))

  const paused = automatic
    ? false
    : await pauseContact(db, args.orgId, args.contactId, `replied ${now.toISOString()}`, now)

  // Anything already queued for them is now wrong. Marked refused rather than
  // deleted: the record that it was ABOUT to go, and did not, is the useful
  // one.
  const cancelled = automatic
    ? []
    : await db
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

  let suppressed = false
  let optOutNotRecorded = false
  if (args.channel === 'email' && optedOut) {
    // A THROW is what a database fault actually does, and `{ ok: false }` is
    // what an unreadable address does; both are the same failure to the
    // person who asked to be left alone. (The same lesson recordOptOut in
    // calls.ts learned.)
    let added: Awaited<ReturnType<typeof addSuppression>>
    let why: string
    try {
      added = await addSuppression(db, {
        orgId: args.orgId,
        kind: 'email',
        value: args.from,
        reason: `replied asking to stop, ${now.toISOString().slice(0, 10)}`,
        source: 'reply',
      })
      // `added.message` quotes the address back; the audit row and the log
      // carry a reason CLASS instead (§2.3).
      why = 'unparseable_address'
    } catch (err) {
      added = { ok: false, message: 'The suppression could not be written.' }
      why = err instanceof Error ? err.name : 'UnknownError'
    }
    suppressed = added.ok
    if (!added.ok) {
      // §2.1's Phase 4 obligation: a suppression insert that fails is an
      // opt-out that was never recorded — worse than any bug the constraint
      // replaced. The row still says `opted_out`, so the state is queryable;
      // the audit row is what the digest and the compliance page count; the
      // log line is what a person sees today. Never silently.
      optOutNotRecorded = true
      await appendAudit(db, {
        orgId: args.orgId,
        actor: 'system',
        action: 'contact.opt_out_not_recorded',
        subjectType: 'contact',
        subjectId: args.contactId,
        detail: { touchId, channel: args.channel, why },
      }).catch(() => {})
      ;(args.log ?? stderrLog).error('OPT-OUT NOT RECORDED — follow up by hand', {
        touchId,
        contactId: args.contactId,
        orgId: args.orgId,
        why,
      })
    }
  }

  let deal: string | null = null
  if (companyId && !automatic) {
    const moved = await advanceDeal(db, {
      orgId: args.orgId,
      companyId,
      to: 'replied',
      nextAction: 'Read the reply and answer it',
    }).catch(() => null)
    deal = moved ? `${moved.outcome}:${moved.deal.stage}` : null
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: 'system',
    action: 'contact.replied',
    subjectType: 'contact',
    subjectId: args.contactId,
    // §2.3: the facts and the counts, never the reply's text.
    detail: { channel: args.channel, paused, cancelledQueued: cancelled.length, suppressed, deal, replyKind },
  }).catch(() => {})

  return {
    touchId, paused, cancelled: cancelled.length, suppressed, optOutNotRecorded, deal, replyKind, companyId, companyDomain,
  }
}

export type InboundOutcome =
  | {
      readonly matched: 'message' | 'contact'
      readonly contactId: string
      readonly orgId: string
      readonly touchId: string
      readonly paused: boolean
      readonly suppressed: boolean
      readonly replyKind: ReplyKind
      /**
       * True when this Message-ID had already been recorded, so nothing was
       * written this time. A caller notifying somebody must not notify them
       * twice for one reply a provider retried.
       */
      readonly duplicate: boolean
      readonly companyId: string | null
      readonly companyDomain: string | null
    }
  | { readonly matched: 'none'; readonly why: string }

/**
 * An inbound email, from IMAP or from a webhook — one function for both.
 *
 * Matching, in order of confidence:
 *
 *  1. `In-Reply-To` / `References` against the Message-ID a provider assigned
 *     to something this system sent. Unambiguous: it names the exact message,
 *     the contact, the campaign and the org.
 *  2. The From address against `contacts.email` — ONLY if it matches exactly
 *     one contact across every org. A mailbox that serves two orgs and gets a
 *     reply from an address both have on file cannot tell which conversation
 *     it belongs to, and guessing files somebody's reply under the wrong
 *     agency. It is logged and dropped instead.
 *
 * Returns what happened so the caller can log it. Never throws on a message
 * it cannot place: an IMAP listener that crashed on one odd email would stop
 * detecting every reply after it.
 */
export async function handleInboundEmail(
  db: AgencyDb,
  mail: {
    readonly from: string
    readonly subject: string | null
    readonly text: string | null
    readonly messageId?: string | null
    /** Every Message-ID in In-Reply-To and References, in that order. */
    readonly references?: readonly string[]
    /**
     * The raw header map and the DSN status, when the caller has them.
     * Accepted and IGNORED here: `mail-signals-and-bounce-pause` is the
     * feature that reads them, and until it lands a caller passing them
     * changes nothing. Declared now so `inbound-resend` can pass them
     * without importing that feature.
     */
    readonly headers?: Readonly<Record<string, string>>
    readonly dsn?: string | null
    /** Forwarded to `recordInboundReply`; see `InboundLog`. */
    readonly log?: InboundLog
    readonly now?: Date
  },
): Promise<InboundOutcome> {
  const from = normaliseEmail(mail.from)
  if (!from) return { matched: 'none', why: 'the From address could not be read' }

  // 0. Seen before. A webhook provider retries on any non-2xx and sometimes
  //    on a slow 2xx, and an IMAP reconnect can re-present a message; the
  //    Message-ID is the same each time, so the reply is recorded once.
  if (mail.messageId) {
    const dup = await db
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
      .where(and(eq(schema.touches.direction, 'in'), eq(schema.touches.providerId, mail.messageId)))
      .limit(1)
    if (dup[0]?.contactId) {
      // The kind comes off the stored row, not from re-reading the text: a
      // redelivery must answer exactly what the first delivery decided.
      return {
        matched: 'message',
        contactId: dup[0].contactId,
        orgId: dup[0].orgId,
        touchId: dup[0].id,
        paused: false,
        suppressed: false,
        replyKind: (dup[0].replyKind as ReplyKind | null) ?? 'other',
        duplicate: true,
        companyId: dup[0].companyId,
        companyDomain: dup[0].companyDomain,
      }
    }
  }

  // 1. By the message it answers.
  const refs = (mail.references ?? []).map((r) => r.trim()).filter(Boolean)
  if (refs.length > 0) {
    const hits = await db
      .select({ id: schema.touches.id, orgId: schema.touches.orgId, contactId: schema.touches.contactId })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.direction, 'out'),
          isNotNull(schema.touches.providerId),
          inArray(schema.touches.providerId, refs),
        ),
      )
      .limit(1)
    const hit = hits[0]
    if (hit?.contactId) {
      const r = await recordInboundReply(db, {
        orgId: hit.orgId,
        contactId: hit.contactId,
        channel: 'email',
        from,
        subject: mail.subject,
        body: mail.text,
        providerId: mail.messageId ?? null,
        inReplyTo: hit.id,
        ...(mail.now ? { now: mail.now } : {}),
        ...(mail.log ? { log: mail.log } : {}),
      })
      return {
        matched: 'message',
        replyKind: r.replyKind,
        contactId: hit.contactId,
        orgId: hit.orgId,
        touchId: r.touchId,
        paused: r.paused,
        suppressed: r.suppressed,
        duplicate: false,
        companyId: r.companyId,
        companyDomain: r.companyDomain,
      }
    }
  }

  // 2. By the address, only when it is unambiguous.
  const contacts = await db
    .select({ id: schema.contacts.id, orgId: schema.contacts.orgId })
    .from(schema.contacts)
    .where(sql`lower(${schema.contacts.email}) = ${from}`)
    .limit(2)
  if (contacts.length === 0) return { matched: 'none', why: 'no contact has this address' }
  if (contacts.length > 1) {
    return { matched: 'none', why: 'this address belongs to contacts in more than one org, and nothing says which' }
  }
  const only = contacts[0]!
  const r = await recordInboundReply(db, {
    orgId: only.orgId,
    contactId: only.id,
    channel: 'email',
    from,
    subject: mail.subject,
    body: mail.text,
    providerId: mail.messageId ?? null,
    ...(mail.now ? { now: mail.now } : {}),
    ...(mail.log ? { log: mail.log } : {}),
  })
  return {
    matched: 'contact', contactId: only.id, orgId: only.orgId,
    touchId: r.touchId, paused: r.paused, suppressed: r.suppressed, replyKind: r.replyKind,
    duplicate: false, companyId: r.companyId, companyDomain: r.companyDomain,
  }
}

/** The most recent outbound and inbound touches for a company — the thread. */
export async function companyThread(
  db: AgencyDb,
  orgId: string,
  companyId: string,
  limit = 50,
): Promise<TouchRow[]> {
  return db
    .select()
    .from(schema.touches)
    .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.companyId, companyId)))
    .orderBy(desc(schema.touches.createdAt))
    .limit(limit)
}
