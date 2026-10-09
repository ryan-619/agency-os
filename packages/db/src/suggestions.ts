/**
 * Suggested answers to email replies (0026): what the model may be shown,
 * what it wrote, and what a person did with it.
 *
 * A suggestion is NOT a message. It lives in `reply_suggestions`, never in
 * `touches`, so the send path, the approval queue, the resume rules and the
 * daily cap cannot see it; a person who likes it presses "Answer with this",
 * which fills the composer on /inbox, and the answer then goes the way every
 * answer goes — `replyQueueDraft`, /approvals, `dispatchTouch` at sending.
 *
 * `replySuggestionFacts` is the gate in front of the model, and it refuses
 * before any words are read by one: an opt-out (by kind, or by the words
 * `looksLikeOptOut` and `mentionsRemovalOrDeparture` read — the inbox's own
 * readers), an auto-reply, a colleague's reply filed under the contact
 * (`replyIsFromTheContact`), a suppressed address on file or From, a contact
 * held by any pause but their own reply's (the inbox refuses to answer those
 * too), a reply already handled or answered, and a reply with no words of
 * its own. Each refusal is recorded `skipped` with its code, once, so the
 * sweep never asks twice — and `already` is the answer for a reply that has
 * a row of either kind.
 *
 * What the model is shown is bounded and labelled by `replyDraftPrompt`
 * (core): the agency's own playbook and catalogue, the current scan's
 * quotable lines in the scanner's words, the booking link, our message and
 * the sender's own words. Prices the draft may quote are the catalogue's and
 * any the playbook carries, as digit strings for `replyDraftProblems`.
 *
 * Audited by id and count, never by the words (§2.3): `reply.suggested`
 * `{ contactId, companyId, model, chars }`, `reply.suggestion_dismissed`,
 * `reply.suggestion_used { answerTouchId }`.
 */
import { and, asc, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  amountsIn, mentionsRemovalOrDeparture, ownWords, parseIcpDefinition, pauseReasonClass, staleAfterDaysOf, suppressionKeysFor,
  type ReplyDraftInput, type ReplyDraftService,
} from '@agency/core'
import { appendAudit } from './approvals.js'
import { readPlaybook } from './assistant.js'
import { servicesList } from './opportunities.js'
import { looksLikeOptOut, replyIsFromTheContact } from './outreach.js'
import { activeIcpProfile, quotableFindings } from './repository.js'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

/** Why no suggestion is drafted for a reply. Stored as `skipped_why`, at most 40 characters by CHECK. */
export type ReplySuggestionSkip =
  | 'not_found'
  | 'not_email'
  | 'not_a_reply'
  | 'opted_out'
  | 'auto_reply'
  | 'colleague'
  | 'no_contact'
  | 'suppressed'
  | 'held'
  | 'handled'
  | 'answered'
  | 'no_words'
  /** The model answered NONE: nothing to answer, by its reading. */
  | 'model_declined'
  /** `replyDraftProblems` refused what it wrote. */
  | 'invented_link'
  | 'invented_price'
  | 'claims_testing'
  | 'too_long'
  | 'empty'

export interface ReplySuggestionFacts {
  readonly orgId: string
  readonly touchId: string
  readonly contactId: string
  readonly companyId: string | null
  readonly input: ReplyDraftInput
  /** What `replyDraftProblems` judges the draft against. */
  readonly allowed: { readonly urls: readonly string[]; readonly amounts: readonly string[] }
}

export type ReplySuggestionFactsResult =
  | { readonly ok: true; readonly facts: ReplySuggestionFacts }
  | { readonly ok: false; readonly why: ReplySuggestionSkip | 'already' }

/** "₹5,000–₹15,000 one-off", "from ₹2,000 monthly", or null when unpriced. */
export function servicePriceWords(s: {
  readonly priceFrom: number | null
  readonly priceTo: number | null
  readonly currency: string
  readonly priceUnit: string
}): string | null {
  const symbol = s.currency.toUpperCase() === 'INR' ? '₹' : `${s.currency.toUpperCase()} `
  const money = (n: number) => `${symbol}${n.toLocaleString('en-IN')}`
  const unit = ({ one_off: 'one-off', monthly: 'a month', yearly: 'a year', hourly: 'an hour', daily: 'a day' } as Record<string, string>)[s.priceUnit] ?? s.priceUnit
  if (s.priceFrom !== null && s.priceTo !== null) {
    return s.priceFrom === s.priceTo ? `${money(s.priceFrom)} ${unit}` : `${money(s.priceFrom)}–${money(s.priceTo)} ${unit}`
  }
  if (s.priceFrom !== null) return `from ${money(s.priceFrom)} ${unit}`
  if (s.priceTo !== null) return `up to ${money(s.priceTo)} ${unit}`
  return null
}

/**
 * Everything the model may be shown about one reply, or why it is shown
 * nothing. Reads only; writes nothing.
 */
export async function replySuggestionFacts(
  db: AgencyDb,
  args: { readonly orgId: string; readonly touchId: string; readonly now?: Date; readonly webOrigin?: string | null },
): Promise<ReplySuggestionFactsResult> {
  const now = args.now ?? new Date()
  const parent = alias(schema.touches, 'parent')
  const rows = await db
    .select({
      touch: {
        id: schema.touches.id,
        channel: schema.touches.channel,
        direction: schema.touches.direction,
        subject: schema.touches.subject,
        body: schema.touches.body,
        recipient: schema.touches.recipient,
        replyKind: schema.touches.replyKind,
        handledAt: schema.touches.handledAt,
        contactId: schema.touches.contactId,
        companyId: schema.touches.companyId,
      },
      contact: {
        id: schema.contacts.id,
        firstName: schema.contacts.firstName,
        email: schema.contacts.email,
        phone: schema.contacts.phone,
        linkedinUrl: schema.contacts.linkedinUrl,
        pausedAt: schema.contacts.pausedAt,
        pausedReason: schema.contacts.pausedReason,
      },
      company: { id: schema.companies.id, name: schema.companies.name, domain: schema.companies.domain },
      parent: { subject: parent.subject, body: parent.body },
      org: { name: schema.orgs.name, bookingSlug: schema.orgs.bookingSlug },
      dealStage: schema.deals.stage,
      suggestionId: schema.replySuggestions.id,
    })
    .from(schema.touches)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.touches.orgId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.touches.contactId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.touches.companyId))
    .leftJoin(parent, and(eq(parent.id, schema.touches.inReplyTo), eq(parent.orgId, schema.touches.orgId)))
    .leftJoin(
      schema.deals,
      and(eq(schema.deals.companyId, schema.touches.companyId), eq(schema.deals.orgId, schema.touches.orgId), isNull(schema.deals.closedAt)),
    )
    .leftJoin(schema.replySuggestions, eq(schema.replySuggestions.touchId, schema.touches.id))
    .where(and(eq(schema.touches.id, args.touchId), eq(schema.touches.orgId, args.orgId)))
    .limit(1)
  const r = rows[0]
  if (!r) return { ok: false, why: 'not_found' }
  if (r.suggestionId) return { ok: false, why: 'already' }
  if (r.touch.direction !== 'in') return { ok: false, why: 'not_a_reply' }
  if (r.touch.channel !== 'email') return { ok: false, why: 'not_email' }

  const words = ownWords(r.touch.body).trim()
  // The inbox's own readers, over the sender's own words: an opt-out by kind
  // or by words, and a departure or a request to be removed, get no draft.
  if (r.touch.replyKind === 'opted_out' || looksLikeOptOut(words) || mentionsRemovalOrDeparture(words)) {
    return { ok: false, why: 'opted_out' }
  }
  if (r.touch.replyKind === 'auto_reply') return { ok: false, why: 'auto_reply' }
  if (!r.contact) return { ok: false, why: 'no_contact' }
  if (!replyIsFromTheContact(r.touch.recipient, 'email', r.contact)) return { ok: false, why: 'colleague' }
  if (r.touch.handledAt) return { ok: false, why: 'handled' }
  if (!words) return { ok: false, why: 'no_words' }

  // Any pause but their own reply's is somebody else's decision, and the
  // inbox refuses to answer past it; a draft would be a nudge to.
  if (r.contact.pausedAt && pauseReasonClass(r.contact.pausedReason) !== 'replied') return { ok: false, why: 'held' }

  // The suppression lookup over the send path's keys: the address on file
  // and the address the reply came from.
  const keys = [
    ...(r.contact.email ? suppressionKeysFor(r.contact.email, 'email') ?? [] : []),
    ...(r.touch.recipient ? suppressionKeysFor(r.touch.recipient, 'email') ?? [] : []),
  ]
  if (keys.length > 0) {
    const hit = await db
      .select({ id: schema.suppressions.id })
      .from(schema.suppressions)
      .where(and(eq(schema.suppressions.orgId, args.orgId), inArray(schema.suppressions.value, keys.map((k) => k.value))))
      .limit(1)
    if (hit.length > 0) return { ok: false, why: 'suppressed' }
  }

  const answered = await db
    .select({ id: schema.touches.id })
    .from(schema.touches)
    .where(and(eq(schema.touches.orgId, args.orgId), eq(schema.touches.direction, 'out'), eq(schema.touches.answersTouchId, r.touch.id)))
    .limit(1)
  if (answered.length > 0) return { ok: false, why: 'answered' }

  const [playbook, services, icp] = await Promise.all([
    readPlaybook(db, args.orgId),
    servicesList(db, args.orgId, { activeOnly: true }),
    activeIcpProfile(db, args.orgId),
  ])
  const staleAfterDays = staleAfterDaysOf(icp?.definition)
  let why: Readonly<Record<string, { readonly why: string }>> = {}
  try {
    why = parseIcpDefinition(icp?.definition).signals
  } catch {
    // A profile that does not parse quotes by signal key, as the pages do.
  }
  const findings = r.company ? await quotableFindings(db, args.orgId, r.company.id, staleAfterDays, now) : []
  const observed = findings.slice(0, 6).map((f) => `${why[f.signalKey]?.why ?? f.signalKey}${f.detail ? `: ${f.detail}` : ''}`)

  const priced: ReplyDraftService[] = services.map((s) => ({ name: s.name, price: servicePriceWords(s) }))
  const amounts = new Set<string>()
  for (const s of services) {
    if (s.priceFrom !== null) amounts.add(String(s.priceFrom))
    if (s.priceTo !== null) amounts.add(String(s.priceTo))
  }
  for (const a of amountsIn(playbook)) amounts.add(a)

  const bookingUrl = args.webOrigin && r.org.bookingSlug ? `${args.webOrigin}/book/${r.org.bookingSlug}` : null
  const input: ReplyDraftInput = {
    orgName: r.org.name,
    contactFirstName: r.contact.firstName,
    companyName: r.company?.name ?? r.company?.domain ?? null,
    replyKind: r.touch.replyKind,
    ownWords: words,
    ourSubject: r.parent?.subject ?? null,
    ourWords: r.parent?.body ?? null,
    playbook,
    observed,
    services: priced,
    dealStage: r.dealStage,
    bookingUrl,
  }
  return {
    ok: true,
    facts: {
      orgId: args.orgId,
      touchId: r.touch.id,
      contactId: r.contact.id,
      companyId: r.company?.id ?? null,
      input,
      allowed: { urls: bookingUrl ? [bookingUrl] : [], amounts: [...amounts] },
    },
  }
}

export type ReplySuggestionWrite = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly why: 'already' }

/** Store what the model wrote, once per reply. The audit row carries ids, the model and a count, never the words. */
export async function replySuggestionWrite(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly touchId: string
    readonly contactId: string | null
    readonly companyId: string | null
    readonly body: string
    readonly model: string
  },
): Promise<ReplySuggestionWrite> {
  const inserted = await db
    .insert(schema.replySuggestions)
    .values({ orgId: args.orgId, touchId: args.touchId, status: 'drafted', body: args.body, model: args.model })
    .onConflictDoNothing({ target: schema.replySuggestions.touchId })
    .returning({ id: schema.replySuggestions.id })
  const row = inserted[0]
  if (!row) return { ok: false, why: 'already' }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: 'agent',
    action: 'reply.suggested',
    subjectType: 'touch',
    subjectId: args.touchId,
    detail: { contactId: args.contactId, companyId: args.companyId, model: args.model, chars: [...args.body].length },
  }).catch(() => {})
  return { ok: true, id: row.id }
}

/** Record that nothing was drafted, and why, so nobody asks again. Idempotent. */
export async function replySuggestionSkip(
  db: AgencyDb,
  args: { readonly orgId: string; readonly touchId: string; readonly why: ReplySuggestionSkip },
): Promise<void> {
  await db
    .insert(schema.replySuggestions)
    .values({ orgId: args.orgId, touchId: args.touchId, status: 'skipped', skippedWhy: args.why })
    .onConflictDoNothing({ target: schema.replySuggestions.touchId })
}

export interface ReplySuggestionView {
  readonly id: string
  readonly body: string
  readonly model: string
  readonly createdAt: Date
  readonly usedAt: Date | null
}

/** The drafted, undismissed suggestion for each reply asked about, by reply id. One query for a page. */
export async function replySuggestionsFor(
  db: AgencyDb,
  orgId: string,
  touchIds: readonly string[],
): Promise<Map<string, ReplySuggestionView>> {
  const out = new Map<string, ReplySuggestionView>()
  if (touchIds.length === 0) return out
  const rows = await db
    .select({
      id: schema.replySuggestions.id,
      touchId: schema.replySuggestions.touchId,
      body: schema.replySuggestions.body,
      model: schema.replySuggestions.model,
      createdAt: schema.replySuggestions.createdAt,
      usedAt: schema.replySuggestions.usedAt,
    })
    .from(schema.replySuggestions)
    .where(
      and(
        eq(schema.replySuggestions.orgId, orgId),
        inArray(schema.replySuggestions.touchId, [...touchIds]),
        eq(schema.replySuggestions.status, 'drafted'),
        isNull(schema.replySuggestions.dismissedAt),
      ),
    )
  for (const r of rows) {
    if (r.body !== null && r.model !== null) out.set(r.touchId, { id: r.id, body: r.body, model: r.model, createdAt: r.createdAt, usedAt: r.usedAt })
  }
  return out
}

export type ReplySuggestionDismiss = { readonly ok: true } | { readonly ok: false; readonly reason: 'not_found' | 'already' }

/** A person put the suggestion away. It stays on the row, dismissed, and the inbox stops showing it. */
export async function replySuggestionDismiss(
  db: AgencyDb,
  args: { readonly orgId: string; readonly touchId: string; readonly actor: string; readonly now?: Date },
): Promise<ReplySuggestionDismiss> {
  const now = args.now ?? new Date()
  const updated = await db
    .update(schema.replySuggestions)
    .set({ dismissedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.replySuggestions.orgId, args.orgId),
        eq(schema.replySuggestions.touchId, args.touchId),
        eq(schema.replySuggestions.status, 'drafted'),
        isNull(schema.replySuggestions.dismissedAt),
      ),
    )
    .returning({ id: schema.replySuggestions.id })
  if (updated.length === 0) {
    const any = await db
      .select({ id: schema.replySuggestions.id })
      .from(schema.replySuggestions)
      .where(and(eq(schema.replySuggestions.orgId, args.orgId), eq(schema.replySuggestions.touchId, args.touchId), eq(schema.replySuggestions.status, 'drafted')))
      .limit(1)
    return { ok: false, reason: any.length ? 'already' : 'not_found' }
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'reply.suggestion_dismissed',
    subjectType: 'touch',
    subjectId: args.touchId,
    detail: { suggestionId: updated[0]!.id },
  }).catch(() => {})
  return { ok: true }
}

/**
 * The answer a person drafted started from this suggestion. Best-effort, by
 * the caller: an answer is an answer whether or not this lands.
 */
export async function replySuggestionMarkUsed(
  db: AgencyDb,
  args: { readonly orgId: string; readonly touchId: string; readonly suggestionId: string; readonly answerTouchId: string; readonly actor: string; readonly now?: Date },
): Promise<boolean> {
  const now = args.now ?? new Date()
  const updated = await db
    .update(schema.replySuggestions)
    .set({ usedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.replySuggestions.id, args.suggestionId),
        eq(schema.replySuggestions.orgId, args.orgId),
        eq(schema.replySuggestions.touchId, args.touchId),
        eq(schema.replySuggestions.status, 'drafted'),
        isNull(schema.replySuggestions.usedAt),
      ),
    )
    .returning({ id: schema.replySuggestions.id })
  if (updated.length === 0) return false
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'reply.suggestion_used',
    subjectType: 'touch',
    subjectId: args.touchId,
    detail: { suggestionId: args.suggestionId, answerTouchId: args.answerTouchId },
  }).catch(() => {})
  return true
}

/**
 * Email replies recorded since `since`, in every org, that have no
 * suggestion row of either kind — what the worker's sweep drafts for, so a
 * reply that reached the web's webhooks rather than the worker's inbox gets
 * one too. Oldest first, bounded.
 */
export async function repliesAwaitingSuggestion(
  db: AgencyDb,
  args: { readonly since: Date; readonly limit: number },
): Promise<{ readonly orgId: string; readonly touchId: string }[]> {
  const rows = await db
    .select({ orgId: schema.touches.orgId, touchId: schema.touches.id })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.direction, 'in'),
        eq(schema.touches.channel, 'email'),
        isNull(schema.touches.handledAt),
        sql`${schema.touches.createdAt} >= ${args.since.toISOString()}::timestamptz`,
        notExists(
          db.select({ one: sql`1` }).from(schema.replySuggestions).where(eq(schema.replySuggestions.touchId, schema.touches.id)),
        ),
      ),
    )
    .orderBy(asc(schema.touches.createdAt), asc(schema.touches.id))
    .limit(Math.max(1, Math.min(args.limit, 100)))
  return rows
}

/** For tests and the erasure's count: every suggestion row for a set of replies. */
export async function replySuggestionRows(db: AgencyDb, touchIds: readonly string[]) {
  if (touchIds.length === 0) return []
  return db
    .select()
    .from(schema.replySuggestions)
    .where(inArray(schema.replySuggestions.touchId, [...touchIds]))
    .orderBy(desc(schema.replySuggestions.createdAt))
}
