/**
 * The inbox (PROMPT.md §8.4): every reply that reached this system, what
 * kind it was, and what a person did about it.
 *
 * A reply already did four things the moment it arrived (`recordInboundReply`):
 * it was logged, it paused the person in every campaign, it cancelled what was
 * queued for them, and it moved the deal forward. This module is the screen a
 * person reads those replies on, and the three things a person may do next —
 * each a narrow writer, because §2.1 governs two of them:
 *
 *  - `replyMarkHandled`: somebody read it and dealt with it. One UPDATE whose
 *    predicate carries every rule (inbound, not yet handled, a user in this
 *    org), so two people clicking at once produce one mark and the other is
 *    told rather than shown a 500.
 *  - `replyReclassify`: a person disagrees with the deterministic kind. Any of
 *    the five, and NEVER `opted_out` in either direction. That kind is decided
 *    by the person's own words (`looksLikeOptOut`) at the moment the reply
 *    arrives, and a suppression row is what enforces it. A human "correcting"
 *    it to `other` would leave the suppression in place and the screen saying
 *    something else; a human SETTING it would store a kind with no suppression
 *    behind it. Two different claims about one reply either way, so the type,
 *    the route's enum and the query's predicate all refuse it.
 *  - `replyQueueDraft`: an answer, parked as an `awaiting_approval` OUTBOUND
 *    draft naming the reply in `answers_touch_id` so the worker threads it
 *    under their message. Nothing is sent from here: the draft goes through
 *    /approvals and then `dispatchTouch` re-runs every rule at the moment of
 *    sending. A reply pauses the person, so the draft also RESUMES them —
 *    deliberately, by a person, with an audit row — or the approved answer
 *    would be refused `consent_revoked` by the very pause their reply caused.
 *
 * What `replyQueueDraft` will NOT write: an answer to somebody who asked to
 * stop. §2.1 — "an approver offered enough impossible things learns to click
 * yes." A row whose kind is `opted_out`, or a person any of whose suppression
 * keys is on the list, gets `{ ok: false, reason: 'opted_out' }`; a person who
 * has a recorded refusal of the channel gets `consent_refused`. The contact is
 * NOT resumed on either path. The send path would refuse the draft anyway —
 * those are the refusals nobody may approve past — but refusing HERE keeps the
 * message off the approver's screen, and keeps the pause the reply put on the
 * person exactly where it was.
 *
 * Every write here is audited with ids and kinds only. §2.3: the subject and
 * the body of a message are never in an audit row.
 */
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  REPLY_KINDS, suppressionKeysFor, type Channel, type ReplyKind, type SendRefusalCode,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { resumeContact, type TouchRow } from './outreach.js'
import { previewSend } from './send-preview.js'

/** A group on the inbox: a stored kind, or the rows nobody has classified. */
export type InboxKindFilter = ReplyKind | 'unclassified'

/** The kinds a PERSON may set. `opted_out` is missing on purpose — see the header. */
export type ReplyHumanKind = Exclude<ReplyKind, 'opted_out'>

export const REPLY_HUMAN_KINDS: readonly ReplyHumanKind[] = [
  'interested', 'wrong_person', 'not_now', 'other', 'auto_reply',
]

/** Is this a filter the inbox understands? For a query string, before it reaches SQL. */
export function inboxKindFilter(value: unknown): InboxKindFilter | null {
  if (value === 'unclassified') return 'unclassified'
  return typeof value === 'string' && (REPLY_KINDS as readonly string[]).includes(value) ? (value as ReplyKind) : null
}

export interface InboxRow {
  readonly touch: TouchRow
  readonly contact: {
    readonly id: string
    readonly firstName: string | null
    readonly lastName: string | null
    readonly email: string | null
    readonly pausedAt: Date | null
    readonly pausedReason: string | null
    readonly timeZone: string | null
  } | null
  readonly company: {
    readonly id: string
    readonly domain: string
    readonly name: string | null
    readonly timeZone: string | null
  } | null
  /**
   * The outbound message this answers, when it was matched by Message-ID
   * (`in_reply_to`). Null means the reply was matched by address alone — a
   * fact the screen states, because the two matches are not equally certain.
   */
  readonly parent: {
    readonly id: string
    readonly subject: string | null
    readonly sentAt: Date | null
    readonly approvedBy: { readonly id: string; readonly email: string; readonly name: string | null } | null
    readonly campaignId: string | null
    readonly campaignName: string | null
  } | null
  /** The company's OPEN deal's stage. A closed deal is not the conversation this reply is in. */
  readonly dealStage: string | null
  /**
   * Whether the address this reply came from is on the suppression list, by
   * any key it matches (address and domain for email). False also covers an
   * address that could not be normalised — unknown, not clear — which is
   * why `replyQueueDraft` re-derives this rather than trusting the screen.
   */
  readonly suppressed: boolean
  readonly handledBy: { readonly id: string; readonly email: string; readonly name: string | null } | null
  /** The most recent outbound draft answering this reply, and where it got to. */
  readonly answered: { readonly touchId: string; readonly status: string } | null
}

/**
 * The reading order, as SQL. Unclassified first — nobody has looked — then
 * the kinds in the order a person triages them, and `opted_out` last because
 * there is nothing to do about one but read it. The same order is the
 * grouping order on the page (`inbox-view.ts`); here it decides which rows
 * survive the limit, and the urgent ones do.
 */
const KIND_RANK = sql<number>`CASE ${schema.touches.replyKind}
  WHEN 'interested' THEN 1 WHEN 'wrong_person' THEN 2 WHEN 'not_now' THEN 3
  WHEN 'other' THEN 4 WHEN 'auto_reply' THEN 5 WHEN 'opted_out' THEN 6 ELSE 0 END`

/** Every reply this org received, urgent kinds first and newest first within a kind. */
export async function inboxTouches(
  db: AgencyDb,
  orgId: string,
  q: { readonly kind?: InboxKindFilter; readonly unhandledOnly?: boolean; readonly limit?: number } = {},
): Promise<InboxRow[]> {
  const limit = Math.max(1, Math.min(q.limit ?? 100, 500))
  const parent = alias(schema.touches, 'parent')
  const approver = alias(schema.users, 'approver')
  const handler = alias(schema.users, 'handler')

  const kindWhere =
    q.kind === undefined
      ? undefined
      : q.kind === 'unclassified'
        ? isNull(schema.touches.replyKind)
        : eq(schema.touches.replyKind, q.kind)

  const rows = await db
    .select({
      touch: schema.touches,
      contact: {
        id: schema.contacts.id,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        email: schema.contacts.email,
        pausedAt: schema.contacts.pausedAt,
        pausedReason: schema.contacts.pausedReason,
        timeZone: schema.contacts.timeZone,
      },
      // Read for the suppression lookup only; the row does not carry them.
      contactPhone: schema.contacts.phone,
      contactLinkedin: schema.contacts.linkedinUrl,
      company: {
        id: schema.companies.id,
        domain: schema.companies.domain,
        name: schema.companies.name,
        timeZone: schema.companies.timeZone,
      },
      parent: { id: parent.id, subject: parent.subject, sentAt: parent.sentAt, campaignId: parent.campaignId },
      campaignName: schema.campaigns.name,
      approver: { id: approver.id, email: approver.email, name: approver.name },
      handler: { id: handler.id, email: handler.email, name: handler.name },
      dealStage: schema.deals.stage,
    })
    .from(schema.touches)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.touches.contactId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.touches.companyId))
    // The parent is read with the org in the join: `in_reply_to` is a plain
    // FK, and a reply must never render another org's subject line.
    .leftJoin(parent, and(eq(parent.id, schema.touches.inReplyTo), eq(parent.orgId, schema.touches.orgId)))
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, parent.campaignId))
    .leftJoin(approver, eq(approver.id, parent.approvedBy))
    .leftJoin(handler, eq(handler.id, schema.touches.handledBy))
    // At most one open deal per company (0012's partial unique index), so
    // this join cannot multiply rows.
    .leftJoin(
      schema.deals,
      and(
        eq(schema.deals.companyId, schema.touches.companyId),
        eq(schema.deals.orgId, schema.touches.orgId),
        isNull(schema.deals.closedAt),
      ),
    )
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'in'),
        kindWhere,
        q.unhandledOnly ? isNull(schema.touches.handledAt) : undefined,
      ),
    )
    .orderBy(KIND_RANK, desc(schema.touches.createdAt))
    .limit(limit)

  if (rows.length === 0) return []
  const ids = rows.map((r) => r.touch.id)

  // The newest outbound row answering each reply. Newest, because a first
  // answer can be refused and a second drafted; the screen shows where the
  // latest one got to.
  const answers = await db
    .select({ answersTouchId: schema.touches.answersTouchId, id: schema.touches.id, status: schema.touches.status })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'out'),
        inArray(schema.touches.answersTouchId, ids),
      ),
    )
    .orderBy(desc(schema.touches.createdAt), asc(schema.touches.id))
  const answered = new Map<string, { touchId: string; status: string }>()
  for (const a of answers) {
    if (a.answersTouchId && !answered.has(a.answersTouchId)) {
      answered.set(a.answersTouchId, { touchId: a.id, status: a.status })
    }
  }

  // The suppression lookup, over the SAME keys the send path uses
  // (`suppressionKeysFor`: an email is suppressed by address and by domain),
  // for the address on file AND the address the reply came from — the second
  // is the one `recordInboundReply` suppresses, and the sender never sees it.
  // One query for the page rather than one per row.
  const keysByTouch = new Map<string, readonly { kind: string; value: string }[]>()
  for (const r of rows) {
    const channel = r.touch.channel as Channel
    const onFile = r.contact
      ? suppressionKeysFor(
          addressFor(channel, { email: r.contact.email, phone: r.contactPhone, linkedinUrl: r.contactLinkedin }),
          channel,
        ) ?? []
      : []
    const from = r.touch.recipient ? suppressionKeysFor(r.touch.recipient, channel) ?? [] : []
    const keys = [...onFile, ...from]
    if (keys.length > 0) keysByTouch.set(r.touch.id, keys)
  }
  const values = [...new Set([...keysByTouch.values()].flat().map((k) => k.value))]
  const suppressed = new Set<string>()
  if (values.length > 0) {
    const hits = await db
      .select({ kind: schema.suppressions.kind, value: schema.suppressions.value })
      .from(schema.suppressions)
      .where(and(eq(schema.suppressions.orgId, orgId), inArray(schema.suppressions.value, values)))
    for (const h of hits) suppressed.add(`${h.kind}:${h.value}`)
  }

  return rows.map((r) => ({
    touch: r.touch,
    contact: r.contact,
    company: r.company,
    parent: r.parent
      ? {
          id: r.parent.id,
          subject: r.parent.subject,
          sentAt: r.parent.sentAt,
          approvedBy: r.approver,
          campaignId: r.parent.campaignId,
          campaignName: r.campaignName,
        }
      : null,
    dealStage: r.dealStage,
    suppressed: (keysByTouch.get(r.touch.id) ?? []).some((k) => suppressed.has(`${k.kind}:${k.value}`)),
    handledBy: r.handler,
    answered: answered.get(r.touch.id) ?? null,
  }))
}

/** Replies nobody has dealt with. The sidebar's number; uses 0018's partial index. */
export async function inboxUnhandledCount(db: AgencyDb, orgId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(schema.touches)
    .where(
      and(eq(schema.touches.orgId, orgId), eq(schema.touches.direction, 'in'), isNull(schema.touches.handledAt)),
    )
  return rows[0]?.n ?? 0
}

/** Where a message on this channel is addressed — the send path's own rule, restated. */
function addressFor(
  channel: string,
  contact: { readonly email: string | null; readonly phone?: string | null; readonly linkedinUrl?: string | null },
): string {
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
      return ''
  }
}

// ---------------------------------------------------------------------------
// A person dealt with it
// ---------------------------------------------------------------------------

export type ReplyHandledOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' | 'already_handled' }

/**
 * Mark a reply as dealt with, naming who.
 *
 * ONE UPDATE. `direction = 'in'` and `handled_at IS NULL` are in the predicate
 * — not checked first and written second — so the second of two people who
 * click at once matches nothing and is told `already_handled`. The EXISTS is
 * the same guard `approveDraft` uses; 0018's composite key would refuse a
 * user from another org anyway, and refusing it in the predicate turns a
 * constraint violation into a sentence.
 */
export async function replyMarkHandled(
  db: AgencyDb,
  args: { readonly orgId: string; readonly touchId: string; readonly userId: string; readonly now?: Date },
): Promise<ReplyHandledOutcome> {
  const updated = await db
    .update(schema.touches)
    .set({ handledAt: args.now ?? new Date(), handledBy: args.userId })
    .where(
      and(
        eq(schema.touches.id, args.touchId),
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.direction, 'in'),
        isNull(schema.touches.handledAt),
        sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${args.userId} AND u.org_id = ${args.orgId})`,
      ),
    )
    .returning({ id: schema.touches.id, contactId: schema.touches.contactId, replyKind: schema.touches.replyKind })
  const row = updated[0]
  if (!row) {
    const current = await db
      .select({ handledAt: schema.touches.handledAt })
      .from(schema.touches)
      .where(
        and(eq(schema.touches.id, args.touchId), eq(schema.touches.orgId, args.orgId), eq(schema.touches.direction, 'in')),
      )
      .limit(1)
    return { ok: false, reason: current[0]?.handledAt ? 'already_handled' : 'not_found' }
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.userId,
    action: 'reply.handled',
    subjectType: 'touch',
    subjectId: row.id,
    detail: { contactId: row.contactId, replyKind: row.replyKind },
  }).catch(() => {})
  return { ok: true }
}

// ---------------------------------------------------------------------------
// A person disagrees with the kind
// ---------------------------------------------------------------------------

export type ReplyReclassifyOutcome =
  | { readonly ok: true; readonly from: ReplyKind | null }
  | { readonly ok: false; readonly reason: 'not_found' | 'opt_out_is_not_a_choice' }

/**
 * Set a reply's kind to one of the five a person may choose.
 *
 * The predicate carries `reply_kind IS DISTINCT FROM 'opted_out'`, so a row
 * the opt-out reader settled cannot be edited by anyone through this function
 * — and `kind` is typed to exclude it, with a runtime check for a caller who
 * cast. The transaction locks the row so `from` in the audit is exactly what
 * was replaced, not what somebody else replaced a moment earlier.
 */
export async function replyReclassify(
  db: AgencyDb,
  args: { readonly orgId: string; readonly touchId: string; readonly kind: ReplyHumanKind; readonly actor: string },
): Promise<ReplyReclassifyOutcome> {
  if ((args.kind as string) === 'opted_out' || !REPLY_HUMAN_KINDS.includes(args.kind)) {
    return { ok: false, reason: 'opt_out_is_not_a_choice' }
  }
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ id: schema.touches.id, replyKind: schema.touches.replyKind })
      .from(schema.touches)
      .where(
        and(eq(schema.touches.id, args.touchId), eq(schema.touches.orgId, args.orgId), eq(schema.touches.direction, 'in')),
      )
      .limit(1)
      .for('update')
    const row = current[0]
    if (!row) return { ok: false, reason: 'not_found' } as const
    if (row.replyKind === 'opted_out') return { ok: false, reason: 'opt_out_is_not_a_choice' } as const
    const from = (row.replyKind as ReplyKind | null) ?? null

    const updated = await tx
      .update(schema.touches)
      .set({ replyKind: args.kind })
      .where(
        and(
          eq(schema.touches.id, row.id),
          eq(schema.touches.orgId, args.orgId),
          eq(schema.touches.direction, 'in'),
          sql`${schema.touches.replyKind} IS DISTINCT FROM 'opted_out'`,
        ),
      )
      .returning({ id: schema.touches.id })
    if (!updated[0]) return { ok: false, reason: 'opt_out_is_not_a_choice' } as const

    await appendAudit(tx, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'reply.reclassified',
      subjectType: 'touch',
      subjectId: row.id,
      detail: { from, to: args.kind },
    })
    return { ok: true, from } as const
  })
}

// ---------------------------------------------------------------------------
// A person answers — a draft, parked on a human
// ---------------------------------------------------------------------------

export type ReplyDraftRefusal =
  | 'not_found'
  | 'no_contact'
  | 'no_address'
  | 'no_campaign'
  | 'wrong_channel'
  | 'opted_out'
  | 'consent_refused'
  | 'already_queued'

export type ReplyDraftOutcome =
  | {
      readonly ok: true
      readonly touchId: string
      readonly resumed: boolean
      /**
       * What the send path would say about this answer if it were approved
       * this minute, when that is a refusal a person CAN resolve — quiet
       * hours, the cap, a paused campaign, a missing timezone. Null when it
       * would go. Stated so the screen can say it rather than let "drafted"
       * read as "on its way".
       */
      readonly wouldHold: { readonly code: SendRefusalCode; readonly reason: string } | null
    }
  | { readonly ok: false; readonly reason: ReplyDraftRefusal; readonly message: string }

/** An answer that is still on its way — one of these per reply, at most. */
const LIVE_STATUSES = ['queued', 'awaiting_approval', 'approved', 'sending'] as const

/** Thrown inside the transaction to undo the draft AND the resume together. */
class DraftRefused extends Error {
  readonly outcome: Extract<ReplyDraftOutcome, { ok: false }>
  constructor(outcome: Extract<ReplyDraftOutcome, { ok: false }>) {
    super(outcome.reason)
    this.outcome = outcome
  }
}

const STOPPED = 'This person asked to stop. The suppression row is what enforces it; do not answer.'

/**
 * Park an answer to a reply as an `awaiting_approval` draft.
 *
 * One transaction, opened by locking the reply's row, so two people answering
 * the same reply at once are serialised: the second waits, re-reads, sees the
 * first's live draft and gets `already_queued`. (A single INSERT … SELECT …
 * WHERE NOT EXISTS would NOT do that under READ COMMITTED — both statements
 * see no live answer and both insert — and there is no unique index to catch
 * it, so the lock is the arbitration.)
 *
 * Under the lock, in this order: the reply exists in this org and has a
 * contact; the campaign is the parent's or the chosen one and is on the
 * reply's channel; nobody involved asked to stop — neither the row's kind nor
 * any suppression key the contact's address OR the reply's From address
 * matches; and no answer is already live. Then the draft, the resume (with
 * its audit row), and the audit row for the draft.
 *
 * Then, still inside the transaction, the answer is put to the sender's own
 * dry run (`previewSend`, the same facts `dispatchTouch` gathers) as if a
 * person had approved it. A refusal nobody may approve past — suppressed, a
 * recorded refusal of this channel — ROLLS BACK the draft and the resume
 * together, so the person stays paused and the approver is never offered it.
 * A refusal a person can resolve (quiet hours, the cap, a missing timezone)
 * is returned as `wouldHold` beside the draft instead.
 *
 * `in_reply_to` stays NULL on the draft: 0011 makes that column inbound-only.
 * The link is `answers_touch_id`, and `dispatchTouch` reads the parent's
 * Message-ID from it into In-Reply-To and References when the worker sends.
 */
export async function replyQueueDraft(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly inboundTouchId: string
    readonly subject: string
    readonly body: string
    readonly campaignId?: string | null
    readonly actor: string
    readonly now?: Date
  },
): Promise<ReplyDraftOutcome> {
  const refuse = (reason: ReplyDraftRefusal, message: string): never => {
    throw new DraftRefused({ ok: false, reason, message })
  }
  const now = args.now ?? new Date()

  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as AgencyDb
      const locked = await tx
        .select()
        .from(schema.touches)
        .where(
          and(
            eq(schema.touches.id, args.inboundTouchId),
            eq(schema.touches.orgId, args.orgId),
            eq(schema.touches.direction, 'in'),
          ),
        )
        .limit(1)
        .for('update')
      const reply = locked[0] ?? refuse('not_found', 'That reply is not in this inbox.')
      const contactId =
        reply.contactId ??
        refuse('no_contact', 'This reply is not attached to a contact, so there is nobody to address an answer to.')

      const contacts = await tx
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, args.orgId)))
        .limit(1)
      const contact = contacts[0] ?? refuse('no_contact', 'The contact this reply came from is no longer in the CRM.')

      // The campaign: the one the message they answered went out under, unless
      // the person chose another. Every outbound message carries a campaign,
      // because the campaign is where the cap and the quiet hours live.
      let campaignId = args.campaignId ?? null
      if (!campaignId && reply.inReplyTo) {
        const parents = await tx
          .select({ campaignId: schema.touches.campaignId })
          .from(schema.touches)
          .where(
            and(
              eq(schema.touches.id, reply.inReplyTo),
              eq(schema.touches.orgId, args.orgId),
              eq(schema.touches.direction, 'out'),
            ),
          )
          .limit(1)
        campaignId = parents[0]?.campaignId ?? null
      }
      if (!campaignId) {
        return refuse(
          'no_campaign',
          'This reply was matched by address, not to a message this system sent, so it has no campaign. Choose one — it is where the daily cap and quiet hours come from.',
        )
      }
      const campaigns = await tx
        .select({ id: schema.campaigns.id, channel: schema.campaigns.channel })
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, args.orgId)))
        .limit(1)
      const campaign = campaigns[0] ?? refuse('no_campaign', 'That campaign does not exist.')
      if (campaign.channel !== reply.channel) {
        refuse(
          'wrong_channel',
          `That campaign is for ${campaign.channel}; this reply arrived by ${reply.channel}. An answer goes back the way the reply came.`,
        )
      }

      // §2.1. The kind the opt-out reader settled, and the suppression list by
      // every key this person matches — the address on file (what the sender
      // will check) AND the address the reply came from (which the sender
      // never sees, and which is the one `recordInboundReply` suppresses).
      // Neither is a thing an approver may be asked to decide, so the draft is
      // never written and the pause their reply put on them stays.
      if (reply.replyKind === 'opted_out') refuse('opted_out', STOPPED)
      const channel = reply.channel as Channel
      const keys = suppressionKeysFor(addressFor(channel, contact), channel)
      if (keys === null || keys.length === 0) {
        refuse(
          'no_address',
          `This contact has no usable ${channel} address, so nothing could be sent to them and the suppression list cannot be checked. Fix the contact first.`,
        )
      }
      const fromKeys = reply.recipient ? suppressionKeysFor(reply.recipient, channel) ?? [] : []
      if (await anySuppressed(tx, args.orgId, [...(keys ?? []), ...fromKeys])) refuse('opted_out', STOPPED)

      const live = await tx
        .select({ id: schema.touches.id })
        .from(schema.touches)
        .where(
          and(
            eq(schema.touches.orgId, args.orgId),
            eq(schema.touches.answersTouchId, reply.id),
            eq(schema.touches.direction, 'out'),
            inArray(schema.touches.status, [...LIVE_STATUSES]),
          ),
        )
        .limit(1)
      if (live.length > 0) refuse('already_queued', 'An answer to this reply is already waiting to be approved or sent.')

      const inserted = await tx
        .insert(schema.touches)
        .values({
          orgId: args.orgId,
          campaignId: campaign.id,
          contactId: contact.id,
          // The contact's company, not the reply's copy of it: /approvals
          // refuses a draft whose company is not its recipient's.
          companyId: contact.companyId,
          channel: reply.channel,
          direction: 'out',
          status: 'awaiting_approval',
          subject: args.subject,
          body: args.body,
          answersTouchId: reply.id,
        })
        .returning({ id: schema.touches.id })
      const draft = inserted[0]
      if (!draft) throw new Error('reply draft insert returned no row')

      // Their reply paused them. Answering is a person deciding they may be
      // written to again — the ONLY way a pause ends — and it is recorded as
      // that, with the reason, so /approvals has nothing to resume and the
      // audit log says who chose to.
      let resumed = false
      if (contact.pausedAt) {
        resumed = await resumeContact(tx, args.orgId, contact.id)
        await appendAudit(tx, {
          orgId: args.orgId,
          actor: args.actor,
          action: 'contact.resumed',
          subjectType: 'contact',
          subjectId: contact.id,
          detail: { reason: 'answering their reply from the inbox', inboundTouchId: reply.id, hadReason: contact.pausedReason },
        })
      }

      // The sender's own answer, as if a person had approved this minute.
      const preview = await previewSend(tx, { orgId: args.orgId, contactId: contact.id, campaignId: campaign.id, now })
      if (!preview.ok) refuse('no_contact', preview.message)
      const decision = preview.ok ? preview.decision : null
      let wouldHold: { code: SendRefusalCode; reason: string } | null = null
      if (decision && !decision.allowed) {
        if (!decision.humanCanResolve) {
          refuse(
            decision.code === 'suppressed' ? 'opted_out' : 'consent_refused',
            decision.code === 'suppressed'
              ? STOPPED
              : `${decision.reason} An answer would be refused when it was sent, so it was not drafted.`,
          )
        }
        wouldHold = { code: decision.code, reason: decision.reason }
      }

      await appendAudit(tx, {
        orgId: args.orgId,
        actor: args.actor,
        action: 'reply.answer_drafted',
        subjectType: 'touch',
        subjectId: reply.id,
        // §2.3: ids, the campaign and the channel. Never the words.
        detail: { inboundTouchId: reply.id, touchId: draft.id, campaignId: campaign.id, channel: reply.channel, resumed },
      })

      return { ok: true, touchId: draft.id, resumed, wouldHold } as const
    })
  } catch (err) {
    if (err instanceof DraftRefused) return err.outcome
    throw err
  }
}

/** Does any of these keys have a suppression row in this org? One query. */
async function anySuppressed(
  db: AgencyDb,
  orgId: string,
  keys: readonly { readonly kind: string; readonly value: string }[],
): Promise<boolean> {
  if (keys.length === 0) return false
  const hits = await db
    .select({ id: schema.suppressions.id })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.orgId, orgId),
        or(...keys.map((k) => and(eq(schema.suppressions.kind, k.kind), eq(schema.suppressions.value, k.value)))),
      ),
    )
    .limit(1)
  return hits.length > 0
}
