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
 *    the route's enum and the query's predicate all refuse it — and so does a
 *    reply from somebody on the suppression list, or an UNCLASSIFIED reply
 *    (every one before 0017) whose own words read as an opt-out, which is the
 *    same claim arriving by a door the kind column never saw. Moving a reply
 *    OFF `auto_reply` pauses the person and cancels what was queued for them,
 *    exactly as the reply would have if it had been read as a person's.
 *  - `replyQueueDraft`: an answer, parked as an `awaiting_approval` OUTBOUND
 *    draft naming the reply in `answers_touch_id` so the worker threads it
 *    under their message. Nothing is sent from here: the draft goes through
 *    /approvals and then `dispatchTouch` re-runs every rule at the moment of
 *    sending. A reply pauses the person, so the draft also RESUMES them —
 *    deliberately, by a person, with an audit row — or the approved answer
 *    would be refused `consent_revoked` by the very pause their reply caused.
 *    Only THAT pause: a person paused for any other reason (a teammate, an
 *    unsubscribe, an erasure that could not finish) is refused here and
 *    resumed on /contacts by somebody who decided to.
 *
 * What `replyQueueDraft` will NOT write: an answer to somebody who asked to
 * stop. §2.1 — "an approver offered enough impossible things learns to click
 * yes." A row whose kind is `opted_out`, or a person any of whose suppression
 * keys is on the list, gets `{ ok: false, reason: 'opted_out' }`; a person who
 * has a recorded refusal of the channel gets `consent_refused`. A person with
 * an opt-out the system FAILED to record — an unsubscribe, an erasure or a
 * reply whose suppression could not be written, on the audit log as such, or
 * an earlier reply of theirs read as an opt-out that no suppression row
 * matches today (the compliance page's own check, which survives a fault
 * that failed the audit row too) — gets `opt_out_not_recorded`, however long
 * ago it was: nothing else stands between them and the answer, because no
 * suppression row exists. The
 * contact is NOT resumed on any of these paths. The send path would refuse
 * most of them anyway, but refusing HERE keeps the message off the
 * approver's screen, and keeps the pause exactly where it was.
 *
 * Every write here is audited with ids, kinds and classes only. §2.3: the
 * subject and the body of a message are never in an audit row, and neither is
 * a pause reason — a teammate's reason can carry their address and the
 * contact's words, so `contact.resumed` records its CLASS (`pauseReasonClass`).
 */
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  REPLY_KINDS, pauseReasonClass, suppressionKeysFor, type Channel, type PauseReasonClass, type ReplyKind,
  type SendRefusalCode,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { looksLikeOptOut, pauseContact, replyIsFromTheContact, resumeContact, type TouchRow } from './outreach.js'
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

/**
 * What paused a person, as a CLASS — the reason's text never leaves the
 * contact row (§2.3). Pure, so it lives in `packages/core` beside the send
 * path, whose `paused` refusal is worded by it; re-exported here, where the
 * inbox, the contacts route and the tests have always imported it from.
 * Only a `replied` pause — exactly `replied <ISO instant>` — is one
 * answering the reply may end.
 */
export { pauseReasonClass, type PauseReasonClass } from '@agency/core'

/** The pause reason a reply writes, `recordInboundReply`'s format, for a reply read late. */
function replyPauseReason(reply: { readonly sentAt: Date | null; readonly createdAt: Date }): string {
  return `replied ${(reply.sentAt ?? reply.createdAt).toISOString()}`
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
   *
   * An `opted_out` reply is judged by the address it came FROM alone (review
   * round 8): that is the key `recordInboundReply` suppresses and the key
   * /compliance reads, and a colleague's stop filed under this contact is
   * not recorded by suppressing the contact's own address — which used to
   * light this flag and clear the screen's warning while the sender stayed
   * unsuppressed.
   */
  readonly suppressed: boolean
  /**
   * Whether the reply came from the contact it is filed under
   * (`replyIsFromTheContact`, review round 8): false when both addresses
   * read and differ — a colleague replying all to our message, filed under
   * the contact it went to. Their words are not the contact's, and their
   * stop is not the contact's opt-out. True when either side cannot be read
   * or there is no contact, because "we could not tell" is not "it was
   * somebody else".
   */
  readonly fromIsContact: boolean
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
  // An opted-out reply by the address it came from ALONE (review round 8):
  // its stop is recorded by that key and no other, whoever it is filed
  // under. One query for the page rather than one per row.
  const keysByTouch = new Map<string, readonly { kind: string; value: string }[]>()
  const fromIsContact = new Map<string, boolean>()
  for (const r of rows) {
    const channel = r.touch.channel as Channel
    const contact = r.contact ? { email: r.contact.email, phone: r.contactPhone, linkedinUrl: r.contactLinkedin } : null
    fromIsContact.set(r.touch.id, contact === null || replyIsFromTheContact(r.touch.recipient, channel, contact))
    const keys =
      r.touch.replyKind === 'opted_out'
        ? replyKeys(channel, null, r.touch.recipient)
        : replyKeys(channel, contact, r.touch.recipient)
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
    fromIsContact: fromIsContact.get(r.touch.id) ?? true,
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

/**
 * Every suppression key a reply's person matches: the address on file (what
 * the sender will check) and the address the reply came FROM (the one
 * `recordInboundReply` suppresses, which the sender never sees). The send
 * path's own `suppressionKeysFor`, so an email is matched by address and by
 * domain. An unreadable value contributes nothing — callers that must treat
 * that as unknown say so themselves.
 */
function replyKeys(
  channel: Channel,
  contact: { readonly email: string | null; readonly phone?: string | null; readonly linkedinUrl?: string | null } | null,
  from: string | null,
): { kind: string; value: string }[] {
  const onFile = contact ? suppressionKeysFor(addressFor(channel, contact), channel) ?? [] : []
  const sender = from ? suppressionKeysFor(from, channel) ?? [] : []
  return [...onFile, ...sender]
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
  | {
      readonly ok: true
      readonly from: ReplyKind | null
      /** A reply moved off `auto_reply` pauses the person, as the reply would have; true when this call paused them. */
      readonly paused: boolean
      /** Queued, awaiting-approval and approved messages to them that the move cancelled. */
      readonly cancelled: number
    }
  | {
      readonly ok: false
      /**
       * - `opt_out_is_not_a_choice` the row is `opted_out`, or the kind asked for is.
       * - `suppressed`       the reply's From, or the person's address on
       *                      file, is on the suppression list.
       * - `reads_as_opt_out` the reply was never classified (every reply before
       *                      0017) and its own words read as an opt-out.
       */
      readonly reason: 'not_found' | 'opt_out_is_not_a_choice' | 'suppressed' | 'reads_as_opt_out'
    }

/** `replyReclassifyIfStill`'s one refusal more: the kind it was to replace is no longer there. */
export interface ReplyReclassifyChangedMeanwhile {
  readonly ok: false
  readonly reason: 'changed_meanwhile'
  /** The kind the reply has now — somebody else's, set while the caller was deciding. */
  readonly current: ReplyKind | null
}

/**
 * Set a reply's kind to one of the five a person may choose.
 *
 * The predicate carries `reply_kind IS DISTINCT FROM 'opted_out'`, so a row
 * the opt-out reader settled cannot be edited by anyone through this function
 * — and `kind` is typed to exclude it, with a runtime check for a caller who
 * cast. The transaction locks the row so `from` in the audit is exactly what
 * was replaced, not what somebody else replaced a moment earlier.
 *
 * Two more refusals, because the kind column is not the only record of an
 * opt-out. A reply whose person is on the suppression list — by the From it
 * came from or the address on file, the keys `inboxTouches` reads — keeps its
 * kind: relabelling it would make a reply from somebody who asked to stop read
 * as something else. And a reply with NO kind (0017 added the column with no
 * backfill) whose words `looksLikeOptOut` reads as a stop is refused too: its
 * NULL is "never classified", not "not an opt-out". Both route and tool come
 * through here, so neither can relabel one.
 *
 * Moving a reply OFF `auto_reply` to a kind a person wrote is the correction
 * of a reply that never paused anybody (`recordInboundReply` skips the pause,
 * the cancel and the deal move for a genuine automatic answer). So it does
 * what the reply would have done: pauses the person, with the reason a reply
 * writes (`replied <when the reply arrived>`, so answering it later resumes
 * them), and refuses what was queued for them. The deal is left where it is —
 * moving it is the board's job, and `advanceDeal` records its own move.
 */
export async function replyReclassify(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly touchId: string
    readonly kind: ReplyHumanKind
    readonly actor: string
    readonly now?: Date
  },
): Promise<ReplyReclassifyOutcome> {
  return reclassify(db, args)
}

/**
 * `replyReclassify`, only while the reply still has the kind `expected` —
 * for the worker's reply triage (apps/agent/src/outreach/classify.ts), whose
 * model answers seconds after the kind was read. Same guards, same pause and
 * cancel off `auto_reply`, same audit row; and `changed_meanwhile` when a
 * person or `classify_reply` set another kind in those seconds, because
 * theirs is the later judgement. Review round 3, finding 8: the triage wrote
 * by id alone, outside this path, so a model reading an auto-reply as a
 * person's relabelled it and paused nobody.
 */
export async function replyReclassifyIfStill(
  db: AgencyDb,
  args: ReclassifyArgs & { readonly expected: ReplyKind | null },
): Promise<ReplyReclassifyOutcome | ReplyReclassifyChangedMeanwhile> {
  return reclassify(db, args, args.expected)
}

type ReclassifyArgs = Parameters<typeof replyReclassify>[1]

async function reclassify(db: AgencyDb, args: ReclassifyArgs): Promise<ReplyReclassifyOutcome>
async function reclassify(
  db: AgencyDb,
  args: ReclassifyArgs,
  expected: ReplyKind | null,
): Promise<ReplyReclassifyOutcome | ReplyReclassifyChangedMeanwhile>
async function reclassify(
  db: AgencyDb,
  args: ReclassifyArgs,
  expected?: ReplyKind | null,
): Promise<ReplyReclassifyOutcome | ReplyReclassifyChangedMeanwhile> {
  if ((args.kind as string) === 'opted_out' || !REPLY_HUMAN_KINDS.includes(args.kind)) {
    return { ok: false, reason: 'opt_out_is_not_a_choice' }
  }
  const now = args.now ?? new Date()
  // A reply's contact changes only when that contact is deleted or erased
  // (ON DELETE SET NULL), so a second pass reads it NULL and locks nobody; the
  // bound is for a writer nobody has written yet.
  for (let attempt = 1; ; attempt++) {
    const outcome = await reclassifyOnce(db, args, now, expected)
    if (outcome !== CONTACT_CHANGED) return outcome
    if (attempt >= 3) throw new Error('the reply’s contact changed under every attempt to reclassify it')
  }
}

/** `reclassifyOnce`'s answer when the reply's contact changed between its read and its lock: start again. */
const CONTACT_CHANGED = Symbol('contact changed')

/**
 * One attempt at `reclassify`, in one transaction.
 *
 * Contact before touch (review round 6, [14]), the order every writer that
 * holds a person and their messages takes. The reply row is READ to learn
 * whose it is, that person is locked, and only then is the reply locked —
 * and checked to be theirs still. Locking the reply first held it while the
 * pause below waited for the person, and an erasure holds the person while
 * it scrubs that very reply: the two deadlocked on a real Postgres, and the
 * erasure took the loud "could not keep its suppression" path. When the
 * reply's contact changed in between — deleted or erased — the attempt is
 * given up whole and the caller starts again, so the lock it would need is
 * never taken after the reply's.
 */
async function reclassifyOnce(
  db: AgencyDb,
  args: ReclassifyArgs,
  now: Date,
  expected: ReplyKind | null | undefined,
): Promise<ReplyReclassifyOutcome | ReplyReclassifyChangedMeanwhile | typeof CONTACT_CHANGED> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    const replyIs = and(
      eq(schema.touches.id, args.touchId),
      eq(schema.touches.orgId, args.orgId),
      eq(schema.touches.direction, 'in'),
    )
    const [seen] = await tx.select({ contactId: schema.touches.contactId }).from(schema.touches).where(replyIs).limit(1)
    if (!seen) return { ok: false, reason: 'not_found' } as const
    const contact = seen.contactId
      ? (
          await tx
            .select({ email: schema.contacts.email, phone: schema.contacts.phone, linkedinUrl: schema.contacts.linkedinUrl })
            .from(schema.contacts)
            .where(and(eq(schema.contacts.id, seen.contactId), eq(schema.contacts.orgId, args.orgId)))
            .limit(1)
            .for('update')
        )[0] ?? null
      : null
    const current = await tx
      .select({
        id: schema.touches.id,
        replyKind: schema.touches.replyKind,
        channel: schema.touches.channel,
        body: schema.touches.body,
        recipient: schema.touches.recipient,
        contactId: schema.touches.contactId,
        sentAt: schema.touches.sentAt,
        createdAt: schema.touches.createdAt,
      })
      .from(schema.touches)
      .where(replyIs)
      .limit(1)
      .for('update')
    const row = current[0]
    if (!row) return { ok: false, reason: 'not_found' } as const
    if (row.contactId !== seen.contactId) return CONTACT_CHANGED
    // `replyReclassifyIfStill`: read under the row lock, so a kind set a
    // moment ago is seen and stands.
    if (expected !== undefined && (row.replyKind ?? null) !== expected) {
      return { ok: false, reason: 'changed_meanwhile', current: (row.replyKind as ReplyKind | null) ?? null } as const
    }
    if (row.replyKind === 'opted_out') return { ok: false, reason: 'opt_out_is_not_a_choice' } as const
    if (row.replyKind === null && looksLikeOptOut(row.body)) return { ok: false, reason: 'reads_as_opt_out' } as const

    if (await anySuppressed(tx, args.orgId, replyKeys(row.channel as Channel, contact, row.recipient))) {
      return { ok: false, reason: 'suppressed' } as const
    }
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

    // A person's reply after all: what `recordInboundReply` does for one.
    let paused = false
    let cancelled = 0
    if (from === 'auto_reply' && args.kind !== 'auto_reply' && row.contactId && contact) {
      paused = await pauseContact(tx, args.orgId, row.contactId, replyPauseReason(row), now)
      cancelled = (await cancelQueuedFor(tx, args.orgId, row.contactId)).length
    }

    await appendAudit(tx, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'reply.reclassified',
      subjectType: 'touch',
      subjectId: row.id,
      detail: { from, to: args.kind, paused, cancelledQueued: cancelled },
    })
    return { ok: true, from, paused, cancelled } as const
  })
}

/**
 * Refuse everything still waiting to go to a person — `recordInboundReply`'s
 * own statement, restated because it is inline there. Marked refused rather
 * than deleted: the record that a message was about to go, and did not, is
 * the useful one.
 */
async function cancelQueuedFor(db: AgencyDb, orgId: string, contactId: string): Promise<{ id: string }[]> {
  return db
    .update(schema.touches)
    .set({ status: 'refused', refusalCode: 'consent_revoked' })
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.contactId, contactId),
        eq(schema.touches.direction, 'out'),
        inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved']),
      ),
    )
    .returning({ id: schema.touches.id })
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

/**
 * Three refusals that send a person to /contacts rather than to the draft,
 * each answered by the route with this module's own sentence and a 409. Kept
 * apart from `ReplyDraftRefusal`, whose statuses and words the web app keeps.
 *
 * - `paused_for_another_reason` the person is paused, and not by a reply.
 * - `opt_out_not_recorded`      somebody asked to stop and no suppression
 *                               row records it (the audit log says so, or
 *                               an opted_out reply matches none).
 * - `template_required`         the reply came by SMS or WhatsApp, where an
 *                               answer must be a registered template (0019)
 *                               — drafted with Draft SMS on /contacts, never
 *                               as free text here.
 */
export type ReplyDraftHold = 'paused_for_another_reason' | 'opt_out_not_recorded' | 'template_required'

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
  | { readonly ok: false; readonly reason: ReplyDraftRefusal | ReplyDraftHold; readonly message: string }

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

const NOT_RECORDED =
  'This person asked to stop — by unsubscribing, asking to be erased, or in a reply — and there is no suppression ' +
  'row for it: the audit log says it could not be recorded, or a reply of theirs read as an opt-out matches no ' +
  'suppression row today. Record the opt-out by hand on /suppressions (or finish the erasure). Answering them is ' +
  'not the fix. Nothing was drafted and nobody was resumed.'

/**
 * A stop from ANOTHER address on this thread, filed under this person and
 * not recorded (review round 8): worded as round 7's alarm is, because
 * "this person asked to stop … record it by hand" sent people to record
 * the contact's own address — who never asked — while the sender stayed
 * unrecorded.
 */
const NOT_RECORDED_ANOTHER_ADDRESS =
  'A reply from another address on this thread asked to stop, and no suppression row matches that address. Record ' +
  'THAT address — the reply’s From, shown on /inbox — on /suppressions, never this contact’s: they are not treated ' +
  'as the one who asked. Until it is recorded, nothing is drafted on this thread. Nothing was drafted and nobody was ' +
  'resumed.'

const TEMPLATE_REQUIRED: Readonly<Record<'sms' | 'whatsapp', string>> = {
  sms:
    'This reply came by SMS, and under DLT an answer must be a registered template, not free text. Use Draft SMS ' +
    'on this contact on /contacts, which drafts from an active template. Nothing was drafted and nobody was resumed.',
  whatsapp:
    'This reply came by WhatsApp, where an answer must be a registered template, not free text — and sending ' +
    'WhatsApp is not available yet. Nothing was drafted and nobody was resumed.',
}

const PAUSED_ELSEWHERE =
  'This person is paused for another reason, not by this reply. Resume them on /contacts first, if that is right — ' +
  'answering a reply only ends the pause the reply itself caused. Nothing was drafted.'

/**
 * The audit actions that mean "somebody asked to stop, and it was NOT
 * recorded": a reply's suppression that could not be written, a one-click
 * unsubscribe that could not be (filed under its touch, with the contact in
 * `detail`), and an erasure rolled back whole. None of them leaves a
 * suppression row for anything else to find.
 */
const OPT_OUT_NOT_RECORDED_ACTIONS = ['contact.opt_out_not_recorded', 'contact.erasure_failed', 'unsubscribe.not_recorded']

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
  const refuse = (reason: ReplyDraftRefusal | ReplyDraftHold, message: string): never => {
    throw new DraftRefused({ ok: false, reason, message })
  }
  const now = args.now ?? new Date()

  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as AgencyDb
      const replyIs = and(
        eq(schema.touches.id, args.inboundTouchId),
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.direction, 'in'),
      )
      // Contact before touch (review round 6, [14]), the order every writer
      // that holds a person and their messages takes. The reply is READ to
      // learn whose it is, that person is locked — every check below is about
      // them, and the resume at the end lifts only the pause read here
      // (review round 3) — and only then is the reply locked, which is what
      // serialises two people answering it. Locking the reply first held it
      // while waiting for the person, and an erasure holds the person while
      // it scrubs that very reply: the two deadlocked on a real Postgres, and
      // the answer to a person being erased could be the one that committed.
      const [seen] = await tx.select({ contactId: schema.touches.contactId }).from(schema.touches).where(replyIs).limit(1)
      if (!seen) refuse('not_found', 'That reply is not in this inbox.')
      const contacts = seen?.contactId
        ? await tx
            .select()
            .from(schema.contacts)
            .where(and(eq(schema.contacts.id, seen.contactId), eq(schema.contacts.orgId, args.orgId)))
            .limit(1)
            .for('update')
        : []
      const locked = await tx.select().from(schema.touches).where(replyIs).limit(1).for('update')
      const reply = locked[0] ?? refuse('not_found', 'That reply is not in this inbox.')
      // 0019: on SMS and WhatsApp an answer is a registered template, never
      // free text — 0019's CHECK would refuse this row as a 500. An opt-out
      // keeps its own refusal: nobody is sent to draft to a person who said stop.
      if (reply.channel === 'sms' || reply.channel === 'whatsapp') {
        if (reply.replyKind === 'opted_out') refuse('opted_out', STOPPED)
        refuse('template_required', TEMPLATE_REQUIRED[reply.channel])
      }
      const contactId =
        reply.contactId ??
        refuse('no_contact', 'This reply is not attached to a contact, so there is nobody to address an answer to.')
      // Somebody else's now, between the read and the lock: the person locked
      // above is not the one this reply names, and nothing below may be
      // decided about either. A contact is only ever taken off a reply by its
      // deletion or erasure, which the line above already answers.
      if (contactId !== seen?.contactId) {
        refuse('no_contact', 'The contact this reply came from changed while the answer was being drafted. Nothing was drafted; reload the inbox.')
      }
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
      // An opt-out that FAILED to record leaves no suppression row, so the
      // check above cannot see it; the audit row is what remains. Refused
      // however old it is: nobody has recorded it since, or the suppression
      // check would have answered first. A colleague's, in its own words —
      // the address to record is theirs (review round 8).
      const unrecorded = await unrecordedOptOut(tx, args.orgId, contact)
      if (unrecorded?.own) refuse('opt_out_not_recorded', NOT_RECORDED)
      if (unrecorded?.fromAnotherAddress) refuse('opt_out_not_recorded', NOT_RECORDED_ANOTHER_ADDRESS)
      // Answering ends only the pause the reply caused. Any other pause — a
      // teammate's, an unsubscribe's, an erasure that could not finish — is
      // somebody else's decision, and undoing it is theirs to make on /contacts.
      if (contact.pausedAt && pauseReasonClass(contact.pausedReason) !== 'replied') {
        refuse('paused_for_another_reason', PAUSED_ELSEWHERE)
      }

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
      // that, so /approvals has nothing to resume and the audit log says who
      // chose to. The pause's CLASS, never its text: a reason can carry a
      // teammate's address and the contact's words, and this log is
      // append-only and outlives an erasure.
      //
      // The resume names the reason it read (review round 3). Unconditional,
      // it cleared whatever pause the row held when the UPDATE ran — an
      // "opt-out not recorded" pause that replaced the reply's in between
      // included. Matching nothing, it refuses, and the draft rolls back.
      let resumed = false
      if (contact.pausedAt) {
        resumed = await resumeContact(tx, args.orgId, contact.id, { expectedReason: contact.pausedReason })
        if (!resumed) refuse('paused_for_another_reason', PAUSED_ELSEWHERE)
        await appendAudit(tx, {
          orgId: args.orgId,
          actor: args.actor,
          action: 'contact.resumed',
          subjectType: 'contact',
          subjectId: contact.id,
          detail: {
            reason: 'answering their reply from the inbox',
            inboundTouchId: reply.id,
            pausedFor: pauseReasonClass(contact.pausedReason),
          },
        })
      }

      // The sender's own answer, as if a person had approved this minute.
      const preview = await previewSend(tx, { orgId: args.orgId, contactId: contact.id, campaignId: campaign.id, now, writtenAt: null })
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

/**
 * Has this person an opt-out that was never recorded — and whose was it?
 *
 * Two readings, either of which is enough:
 *
 *  - the audit log says so. `contact.*` rows name the contact as their
 *    subject; `unsubscribe.not_recorded` names the touch and carries the
 *    contact in `detail`.
 *  - a reply filed under them was read as an opt-out (`reply_kind =
 *    'opted_out'`) and no suppression row matches the address it came FROM
 *    today — the compliance page's own must-be-zero predicate, with the
 *    send path's own keys (`suppressionKeysFor`: the address and its
 *    domain). A From that cannot be read is counted, as the page counts it:
 *    no row could match it. This is the reading that survives a fault that
 *    failed the suppression AND the audit row beside it — the
 *    `.catch(() => {})` on that write means the log alone can say nothing.
 *    Found by review.
 *
 * Not read: the audit row of a stop from somebody ELSE that was filed under
 * this person — a colleague replying all to our message (review round 7).
 * Its row is about the reply, or the message it answered, and names them
 * only as `filedUnder`, because it was not their opt-out: read here it
 * locked them out for good, however old, even once the colleague was
 * suppressed.
 *
 * The colleague's opted-out REPLY still holds them through the second
 * reading, and is reported apart (review round 8): `own` is an opt-out of
 * theirs — the audit log, or an opted-out reply from their own address (or
 * one that cannot be told apart from it, `replyIsFromTheContact`) — and
 * `fromAnotherAddress` an opted-out reply from somebody else on the thread.
 * The callers word the two differently, because the fix is different: a
 * person told "this person asked to stop" recorded the CONTACT's address,
 * which satisfied the Resume gate and left the sender unrecorded. Only a
 * suppression on the reply's own From — what this reading looks for —
 * ends `fromAnotherAddress`. Null when there is neither.
 */
interface UnrecordedOptOut {
  readonly own: boolean
  readonly fromAnotherAddress: boolean
}

async function unrecordedOptOut(
  db: AgencyDb,
  orgId: string,
  contact: {
    readonly id: string
    readonly email: string | null
    readonly phone: string | null
    readonly linkedinUrl: string | null
  },
): Promise<UnrecordedOptOut | null> {
  const rows = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        inArray(schema.auditLog.action, OPT_OUT_NOT_RECORDED_ACTIONS),
        or(
          and(eq(schema.auditLog.subjectType, 'contact'), eq(schema.auditLog.subjectId, contact.id)),
          sql`${schema.auditLog.detail}->>'contactId' = ${contact.id}`,
        ),
      ),
    )
    .limit(1)
  let own = rows.length > 0
  let fromAnotherAddress = false

  const optedOut = await db
    .select({ channel: schema.touches.channel, from: schema.touches.recipient })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.contactId, contact.id),
        eq(schema.touches.direction, 'in'),
        eq(schema.touches.replyKind, 'opted_out'),
      ),
    )
  for (const r of optedOut) {
    if (own && fromAnotherAddress) break
    const channel = (CHANNELS as readonly string[]).includes(r.channel) ? (r.channel as Channel) : null
    const keys = channel ? suppressionKeysFor(r.from ?? '', channel) : null
    if (keys !== null && keys.length > 0 && (await anySuppressed(db, orgId, keys))) continue
    // Unrecorded. Whose: an unreadable From, or one that cannot be told
    // apart from the contact's own address, is theirs — the reading that
    // holds them as it always did.
    if (channel !== null && keys !== null && keys.length > 0 && !replyIsFromTheContact(r.from, channel, contact)) {
      fromAnotherAddress = true
    } else {
      own = true
    }
  }
  return own || fromAnotherAddress ? { own, fromAnotherAddress } : null
}

/** The channels a reply can arrive on, as the compliance page reads them. */
const CHANNELS: readonly Channel[] = ['email', 'linkedin', 'sms', 'voice', 'whatsapp']

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

// ---------------------------------------------------------------------------
// Pausing and resuming by hand (/contacts)
// ---------------------------------------------------------------------------
//
// Here, beside the answer path, because the rules are the same rules and
// must not drift: a pause is ended only by the person whose decision it is,
// and an opt-out nobody could record is never resumed — it is recorded. The
// contacts route (PATCH /api/contacts/[id]) calls these two; review round 3
// found it lifting any pause and "pausing" somebody whose reply's pause it
// then left in place. The route writes the pause's audit row; the resume's
// is written here, in the resume's own transaction (review round 4).

export type ContactResumeOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'opt_out_not_recorded' | 'erasure' | 'changed_meanwhile' | 'not_paused' | 'not_found'
      readonly message: string
    }

const RESUME_NOT_RECORDED =
  'This person asked to stop, and the opt-out could not be recorded when they did — this pause is what stands in ' +
  'for it. Record it by hand on /suppressions if it is not there yet. An opt-out is not something to resume, so the ' +
  'pause stays. Nothing was changed.'

const RESUME_ERASURE =
  'This person asked to be erased, and the erasure did not complete — this pause is what holds them until it does. ' +
  'An owner finishes it with Erase… on /contacts. Nothing was changed.'

const RESUME_UNRECORDED_OPT_OUT =
  'This person asked to stop — by unsubscribing, asking to be erased, or in a reply — and no suppression row matches ' +
  'their addresses: the audit log says the opt-out could not be recorded, or a reply of theirs read as an opt-out ' +
  'matches no suppression row. Record it by hand on /suppressions first. Nothing was changed.'

/** `NOT_RECORDED_ANOTHER_ADDRESS`, for Resume: the address to record is the sender's (review round 8). */
const RESUME_UNRECORDED_ANOTHER_ADDRESS =
  'A reply from another address on this thread, filed under this contact, asked to stop, and no suppression row ' +
  'matches that address. Record THAT address — the reply’s From, shown on /inbox — on /suppressions first, never ' +
  'this contact’s: they are not treated as the one who asked, and recording their address does not record the ' +
  'opt-out. Nothing was changed.'

const RESUME_CHANGED =
  'This contact’s pause changed since this page loaded. Reload the page and read why before resuming them. ' +
  'Nothing was changed.'

const RESUME_NOT_PAUSED = 'This contact is not paused, so there is nothing to resume. Nothing was changed.'

/**
 * Resume a person from /contacts — the pause the page SHOWED, and only a
 * pause a person may lift.
 *
 * `expectedReason` is the pause the page rendered — the reason's text
 * (`contacts_pause_has_a_reason`: every pause has one), or null for none —
 * sent back by the button (review round 4).
 * It is what is judged and what the UPDATE lifts: the route used to pass
 * the reason IT read after the click, so a teammate's hold written after
 * the page loaded was lifted by a Resume on a stale tab. Compared as text,
 * in SQL, exactly; never a `paused_at` read back as a `Date`, which holds
 * milliseconds where the column holds microseconds.
 *
 * Refused, with a sentence, and nothing written:
 *
 *  - a pause that is not the one the page showed (`changed_meanwhile`), and
 *    no pause at all (`not_paused`). Both are judged on the row LOCKED in
 *    the resume's own transaction, and the UPDATE repeats the first
 *    (`resumeContact`'s `expectedReason`), so an opt-out's pause landing
 *    between the page and the click is never lifted by it.
 *  - a pause whose class is `opt_out_not_recorded` or `erasure`. Those are
 *    what stands in for an opt-out that could not be recorded and an
 *    erasure that did not finish; `pausedSentence`, the inbox and
 *    `check_send` already say they are never resumed. The fix is to record
 *    the opt-out or finish the erasure, so this refuses even once the
 *    opt-out has been recorded by hand: an opt-out is not something to undo.
 *  - any other pause while `unrecordedOptOut` — the inbox's own reading,
 *    the audit row or an opted_out reply no suppression row matches — holds
 *    an opt-out of THEIRS AND no suppression row matches any of their
 *    addresses today. Recorded by hand since, the suppression row enforces
 *    it, and the pause is a person's to lift again.
 *  - any other pause while an opted-out reply from ANOTHER address on the
 *    thread, filed under them, matches no suppression row (review round 8).
 *    Only a suppression on that reply's From ends it: one on the contact's
 *    own address — what "this person asked to stop" sent people to record —
 *    does not, and the sentence names the address to record.
 *
 * A resume that happens writes its `contact.resumed` row in the SAME
 * transaction, uncaught (review round 4): the route wrote it after the
 * resume had committed, behind `.catch(() => {})`, and
 * `repauseForUnansweredReply` (outreach.ts) decides "nobody resumed them
 * since" from that row — so a row that failed or had not landed yet let an
 * answer that failed or was denied re-pause a person a teammate had just
 * resumed. Now a resume with no row cannot exist, and a row with no resume
 * cannot either. The detail is the pause's CLASS, never its text: a manual
 * reason carries a teammate's address and, often, the contact's own words,
 * and the audit log is append-only — an erasure cannot scrub it.
 */
export async function contactResumeByHand(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contact: Pick<typeof schema.contacts.$inferSelect, 'id'>
    /** The pause the page showed: its reason's text, or null for no pause. */
    readonly expectedReason: string | null
    /** The user who pressed Resume; the audit row's actor. */
    readonly actor: string
  },
): Promise<ContactResumeOutcome> {
  const { expectedReason } = args
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    const [contact] = await tx
      .select({
        id: schema.contacts.id,
        email: schema.contacts.email,
        phone: schema.contacts.phone,
        linkedinUrl: schema.contacts.linkedinUrl,
        pausedAt: schema.contacts.pausedAt,
        pausedReason: schema.contacts.pausedReason,
      })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contact.id)))
      .limit(1)
      .for('update')
    if (!contact) return { ok: false, reason: 'not_found', message: 'No such contact.' } as const
    if (contact.pausedReason !== expectedReason) {
      return { ok: false, reason: 'changed_meanwhile', message: RESUME_CHANGED } as const
    }
    if (!contact.pausedAt) return { ok: false, reason: 'not_paused', message: RESUME_NOT_PAUSED } as const

    const pausedFor = pauseReasonClass(contact.pausedReason)
    if (pausedFor === 'opt_out_not_recorded') {
      return { ok: false, reason: 'opt_out_not_recorded', message: RESUME_NOT_RECORDED } as const
    }
    if (pausedFor === 'erasure') return { ok: false, reason: 'erasure', message: RESUME_ERASURE } as const
    // Their own unrecorded opt-out is ended by a suppression on any of their
    // addresses. A colleague's only by one on the reply's own From — the
    // rows `unrecordedOptOut` found unmatched — never on the contact's
    // (review round 8): recording the contact's address unlocked this Resume
    // and left the person who asked unrecorded.
    const unrecorded = await unrecordedOptOut(tx, args.orgId, contact)
    if (unrecorded?.own && !(await anySuppressed(tx, args.orgId, everyKeyOf(contact)))) {
      return { ok: false, reason: 'opt_out_not_recorded', message: RESUME_UNRECORDED_OPT_OUT } as const
    }
    if (unrecorded?.fromAnotherAddress) {
      return { ok: false, reason: 'opt_out_not_recorded', message: RESUME_UNRECORDED_ANOTHER_ADDRESS } as const
    }
    if (!(await resumeContact(tx, args.orgId, contact.id, { expectedReason }))) {
      return { ok: false, reason: 'changed_meanwhile', message: RESUME_CHANGED } as const
    }
    await appendAudit(tx, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'contact.resumed',
      subjectType: 'contact',
      subjectId: contact.id,
      detail: { pausedFor: pauseReasonClass(contact.pausedReason) },
    })
    return { ok: true } as const
  })
}

/** Every suppression key the contact's own addresses produce, on every channel. */
function everyKeyOf(contact: {
  readonly email: string | null
  readonly phone: string | null
  readonly linkedinUrl: string | null
}): { readonly kind: string; readonly value: string }[] {
  const keys: { kind: string; value: string }[] = []
  for (const channel of CHANNELS) {
    const address = addressFor(channel, contact)
    if (address) keys.push(...(suppressionKeysFor(address, channel) ?? []))
  }
  return keys
}

export type ContactPauseOutcome =
  /** `replaced` names the pause this one took the place of: only ever a reply's. */
  | { readonly ok: true; readonly replaced: 'replied' | null }
  | { readonly ok: false; readonly reason: 'not_found' | 'changed_meanwhile'; readonly message: string }
  | {
      readonly ok: false
      readonly reason: 'already_paused'
      readonly pausedFor: Exclude<PauseReasonClass, 'replied'>
      readonly message: string
    }

const ALREADY_PAUSED: Record<Exclude<PauseReasonClass, 'replied'>, string> = {
  manual:
    'A teammate already paused this contact, and that pause stands — /contacts shows why. Resume them first if the ' +
    'reason should change. Nothing was changed.',
  unsubscribed: 'This contact unsubscribed and is already paused for it; that pause stands. Nothing was changed.',
  opt_out_not_recorded:
    'This contact is already paused because they asked to stop and the opt-out could not be recorded; that pause ' +
    'stands. Record the opt-out on /suppressions. Nothing was changed.',
  erasure:
    'This contact is already paused because their erasure did not complete; that pause stands. Nothing was changed.',
  other: 'This contact is already paused, and that pause stands — /contacts shows why. Nothing was changed.',
}

/**
 * Pause a person from /contacts with a teammate's reason (`<why> (by <who>)`).
 *
 * Not paused: paused, with that reason. Paused by a REPLY: the teammate's
 * reason replaces the reply's (review round 3). Kept — `pauseContact` keeps
 * the first reason — the hold changed nothing while the route answered
 * "paused", and answering the reply in /inbox, which ends only a reply's own
 * pause, then resumed them over it. Replaced, the class is `manual`, and
 * only a person on /contacts lifts it.
 *
 * Paused for anything else, the pause stands and is NOT replaced: a manual
 * reason would turn an unrecorded opt-out's or an unfinished erasure's
 * pause into one Resume lifts, and an unsubscribe's into a teammate's. The
 * caller is told so in a sentence, and nothing is written.
 *
 * Each write names the state it read (`pauseContact`'s `replacing`, or no
 * pause at all), so a pause landing in between is never overwritten: the row
 * is read again, once, and judged as what it now is.
 */
export async function contactPauseByHand(
  db: AgencyDb,
  args: { readonly orgId: string; readonly contactId: string; readonly reason: string; readonly now?: Date },
): Promise<ContactPauseOutcome> {
  const now = args.now ?? new Date()
  for (let attempt = 0; attempt < 2; attempt++) {
    const [contact] = await db
      .select({ pausedAt: schema.contacts.pausedAt, pausedReason: schema.contacts.pausedReason })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId)))
      .limit(1)
    if (!contact) return { ok: false, reason: 'not_found', message: 'No such contact.' }
    if (!contact.pausedAt) {
      if (await pauseContact(db, args.orgId, args.contactId, args.reason, now)) return { ok: true, replaced: null }
      continue
    }
    const pausedFor = pauseReasonClass(contact.pausedReason)
    if (pausedFor !== 'replied') {
      return { ok: false, reason: 'already_paused', pausedFor, message: ALREADY_PAUSED[pausedFor] }
    }
    const replacing = contact.pausedReason ?? ''
    if (await pauseContact(db, args.orgId, args.contactId, args.reason, now, { replacing })) {
      return { ok: true, replaced: 'replied' }
    }
  }
  return {
    ok: false,
    reason: 'changed_meanwhile',
    message: 'This contact’s pause changed while it was being set. Reload the page and try again. Nothing was changed.',
  }
}
