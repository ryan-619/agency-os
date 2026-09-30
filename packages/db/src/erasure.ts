/**
 * Everything held about a person, and an erasure that KEEPS the suppression
 * (§2.1, §2.3).
 *
 * Two functions. `erasureRecord` reads a person's whole file — the contact
 * row, consents with their evidence, messages both ways, meetings, calls,
 * notes, the tasks hanging off their messages, and what the suppression list
 * says about them — for the "download their record" button. `erasureErase`
 * removes them.
 *
 * ## Erasure keeps the suppression
 *
 * The naive erasure deletes the contact and is done. It is also the one way
 * to guarantee that person is contacted again: consents CASCADE (so a
 * re-import starts from NO, correctly), but a suppression row is keyed by
 * VALUE, and the next CSV with their address in it creates a stranger with a
 * clean slate. So the person's address, number and profile go on the
 * suppression list FIRST, inside the same transaction as everything else, and
 * a key that cannot be stored aborts the lot. An erasure that removed the
 * record of who asked to be left alone would be worse than no erasure.
 *
 * Which keys: the contact row's email, E.164 phone and LinkedIn `in/` slug;
 * the recipient of every message the agency sent them (the address actually
 * used can differ from today's, which is the unsubscribe skeptic's case);
 * the number on every call linked to them (the voice service links a call by
 * exact number); and the address or number an opt-out of theirs was recorded
 * against. NOT the email's domain — a domain row would silence the whole
 * company — and NOT a `company/` LinkedIn page, for the same reason. NOT the
 * From of an ordinary inbound reply either: a reply matched by Message-ID
 * can come from a colleague in the thread, and suppressing them would
 * silence somebody who never asked.
 *
 * A contact-row key that cannot be normalised ABORTS: it is the thing a
 * person can fix (a number stored without its country code is still their
 * number, and a re-import in the right form must find it suppressed). A
 * historical value that cannot be normalised is SKIPPED and reported: the
 * send path refuses an unparseable recipient, so no message can ever reach
 * that string, and no edit could ever make it parse — aborting on it would
 * make the person impossible to erase.
 *
 * ## What is scrubbed, and what is kept on purpose
 *
 * Inbound messages lose subject, body and From (replaced by the placeholder
 * below, so a list still shows that a message was there). Outbound messages
 * keep their body — the agency's words — and lose the recipient and any
 * provider error (an SMTP rejection quotes the address). Calls lose both
 * numbers, the transcript, the summary and the recording link. Meetings lose
 * title and notes (the booking page titles a meeting with the person's name
 * and files their message as its notes). Notes about them and tasks hanging
 * off their messages are deleted. The contact row is deleted: consents
 * cascade; messages, meetings and calls keep their SET NULL history. Anything
 * still queued for them is refused, not left for the worker to find.
 *
 * Two exceptions, both so the compliance page stays true: a reply classed
 * `opted_out` keeps its From, and a call with `opted_out_at` keeps its
 * numbers. That page checks every recorded opt-out against the suppression
 * list with its own key, and an opt-out whose key was erased would read as
 * "unreadable — nobody can tell whether it was honoured" forever. The key is
 * on the suppression list anyway; the opt-out's own record is the evidence
 * for it. Their words are still scrubbed.
 *
 * A company the booking page created FOR them — a free-mail booker gets
 * `<their-address>.inbound`, named after them — is renamed rather than
 * left holding their address in its domain.
 *
 * NOT scrubbed, and the page says so: chat transcripts (the agent's
 * conversations are the team's record, and the agent was told only ids);
 * audit detail (ids and counts by design, §2.3); a call recording stored at
 * the carrier, which this product only ever held a link to — the result
 * names the call SIDs so a person can delete it there.
 *
 * ## Failing loudly
 *
 * Any failure — a key that cannot be stored, `addSuppression` throwing, a
 * scrub hitting a constraint — rolls the whole transaction back, so nothing
 * is erased AND nothing is suppressed: an opt-out not recorded. That is
 * §2.1's Phase 4 obligation, restated for erasure, and it is met the way
 * `recordUnsubscribe` meets it: an audit row (`contact.erasure_failed`, a
 * reason class and never a value), `OPT-OUT NOT RECORDED` at error, and the
 * contact PAUSED — the safe direction, so nothing goes to a person who asked
 * to be erased while somebody fixes it. The caller adds the notification.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  normaliseEmail, normaliseLinkedIn, normalisePhone, suppressionKeysFor,
  type Channel, type SuppressionKind,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { addSuppression, type SuppressionRow } from './campaigns.js'
import type { ConsentRow, ContactRow } from './contacts.js'
import type { CallRow } from './calls.js'
import type { MeetingRow } from './meetings.js'
import type { NoteRow } from './notes.js'
import type { TaskRow } from './tasks.js'
import { pauseContact, type InboundLog, type TouchRow } from './outreach.js'

/** What an erased message's subject, body and From read as afterwards. */
export const ERASURE_PLACEHOLDER = '[erased at the person’s request]'

/** Said inside the record, so the file is honest about its own edges. */
export const ERASURE_NOT_INCLUDED: readonly string[] = Object.freeze([
  'Chat transcripts with the agent. They are the team’s conversations, and the agent is given ids rather than a person’s words.',
  'Audit log detail. It records ids and counts, never an address or a message.',
  'Call recordings stored at the carrier. Only a link to them is kept here, and it is included on each call.',
  'Company-level notes, deals and proposals, which are about the company rather than about this person.',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A message "went out" when the row says so — `compliance.ts` uses the same set. */
const WENT_OUT = new Set(['sent', 'delivered', 'bounced', 'replied'])
/** Still waiting to go: refused on erasure, as a reply refuses them. */
const STILL_QUEUED = ['queued', 'awaiting_approval', 'approved'] as const
const CHANNELS: ReadonlySet<string> = new Set<Channel>(['email', 'linkedin', 'sms', 'voice', 'whatsapp'])

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * A person's whole file, as the JSON the download serves. Full rows, not a
 * curated view: a subject-access request asks for what is HELD, and a
 * column left out because it looked internal is a column held and not said.
 */
export interface ContactRecord {
  readonly format: 'agency-os.contact-record'
  readonly version: 1
  readonly generatedAt: Date
  readonly contact: ContactRow
  readonly company: { readonly id: string; readonly domain: string; readonly name: string | null } | null
  /** One row per channel with a recorded answer. A channel with no row was never asked. */
  readonly consents: readonly ConsentRow[]
  /** The suppression rows their address, its domain, their number or their profile match today. */
  readonly suppressions: readonly SuppressionRow[]
  /** Messages both ways, oldest first. */
  readonly touches: readonly TouchRow[]
  readonly meetings: readonly MeetingRow[]
  readonly calls: readonly CallRow[]
  readonly notes: readonly NoteRow[]
  /** Tasks that hang off one of their messages (a LinkedIn step names its touch). */
  readonly tasks: readonly TaskRow[]
  readonly notIncluded: readonly string[]
}

/**
 * Everything held about one person, or null when the id names nobody in this
 * org. Every query carries the org: a guessed id from another agency answers
 * null, exactly like an id that never existed.
 */
export async function erasureRecord(
  db: AgencyDb,
  orgId: string,
  contactId: string,
  now: Date = new Date(),
): Promise<ContactRecord | null> {
  if (!UUID.test(contactId)) return null
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
    .limit(1)
  if (!contact) return null

  const [companies, consents, touches, meetings, calls, notes] = await Promise.all([
    db
      .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, contact.companyId)))
      .limit(1),
    db
      .select()
      .from(schema.consents)
      .where(and(eq(schema.consents.orgId, orgId), eq(schema.consents.contactId, contactId)))
      .orderBy(asc(schema.consents.channel)),
    db
      .select()
      .from(schema.touches)
      .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.contactId, contactId)))
      .orderBy(asc(schema.touches.createdAt), asc(schema.touches.id)),
    db
      .select()
      .from(schema.meetings)
      .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.contactId, contactId)))
      .orderBy(asc(schema.meetings.startsAt)),
    db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.contactId, contactId)))
      .orderBy(asc(schema.calls.createdAt)),
    db
      .select()
      .from(schema.notes)
      .where(and(eq(schema.notes.orgId, orgId), eq(schema.notes.contactId, contactId)))
      .orderBy(asc(schema.notes.createdAt)),
  ])

  const touchIds = touches.map((t) => t.id)
  const tasks = touchIds.length
    ? await db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.orgId, orgId), inArray(schema.tasks.touchId, touchIds)))
        .orderBy(asc(schema.tasks.createdAt))
    : []

  // The send path's own keys for each thing on the row, so the record shows
  // what the send path would find — including a domain row, which the
  // erasure never writes but the send path does honour.
  const keys = [
    ...(contact.email ? suppressionKeysFor(contact.email, 'email') ?? [] : []),
    ...(contact.phone ? suppressionKeysFor(contact.phone, 'sms') ?? [] : []),
    ...(contact.linkedinUrl ? suppressionKeysFor(contact.linkedinUrl, 'linkedin') ?? [] : []),
  ]
  const suppressions = keys.length
    ? await db
        .select()
        .from(schema.suppressions)
        .where(
          and(
            eq(schema.suppressions.orgId, orgId),
            or(...keys.map((k) => and(eq(schema.suppressions.kind, k.kind), eq(schema.suppressions.value, k.value)))),
          ),
        )
        .orderBy(asc(schema.suppressions.createdAt))
    : []

  return {
    format: 'agency-os.contact-record',
    version: 1,
    generatedAt: now,
    contact,
    company: companies[0] ?? null,
    consents,
    suppressions,
    touches,
    meetings,
    calls,
    notes,
    tasks,
    notIncluded: ERASURE_NOT_INCLUDED,
  }
}

// ---------------------------------------------------------------------------
// The keys an erasure must keep
// ---------------------------------------------------------------------------

type ErasureKeyKind = Extract<SuppressionKind, 'email' | 'phone' | 'linkedin'>

export interface ErasureKey {
  readonly kind: ErasureKeyKind
  readonly value: string
}

/** A value that was deliberately not put on the list, and why — shown to the person who erased. */
export interface ErasureSkipped {
  readonly from: 'contact' | 'message' | 'call' | 'opt_out'
  readonly why: 'company_page' | 'unreadable'
}

/**
 * Why an erasure did not happen. A reason CLASS — never the value (§2.3):
 * `unreadable_email`, `unreadable_phone` or `unreadable_linkedin` for a
 * contact-row value a person can correct, otherwise the error's name.
 */
export type ErasureFailure = string

class ErasureAborted extends Error {
  constructor(readonly why: ErasureFailure) {
    super(`erasure aborted: ${why}`)
    this.name = 'ErasureAborted'
  }
}

class ErasureNotFound extends Error {
  constructor() {
    super('erasure: no such contact')
    this.name = 'ErasureNotFound'
  }
}

/** One value, read the way the suppression list stores it, or why not. */
function keyFor(
  kind: ErasureKeyKind,
  raw: string,
): { key: ErasureKey } | { skip: 'company_page' | 'unreadable' } {
  const value = kind === 'email' ? normaliseEmail(raw) : kind === 'phone' ? normalisePhone(raw) : normaliseLinkedIn(raw)
  if (!value) return { skip: 'unreadable' }
  // A company page is not a person, and suppressing it would silence every
  // LinkedIn message to that company — the domain row's problem again.
  if (kind === 'linkedin' && value.startsWith('company/')) return { skip: 'company_page' }
  return { key: { kind, value } }
}

function kindForChannel(channel: string): ErasureKeyKind | null {
  if (!CHANNELS.has(channel)) return null
  if (channel === 'email') return 'email'
  if (channel === 'linkedin') return 'linkedin'
  return 'phone'
}

/**
 * Every key this erasure must leave on the suppression list, or the reason
 * it cannot. Pure over the rows handed in; the caller reads them inside the
 * transaction so nothing can be added between the read and the delete.
 *
 * Throws `ErasureAborted` for a contact-row value that cannot be read — the
 * one kind a person can fix. Everything historical that cannot be read is
 * skipped and reported (see the header for why).
 */
function erasureKeys(
  contact: Pick<ContactRow, 'email' | 'phone' | 'linkedinUrl'>,
  touches: readonly Pick<TouchRow, 'direction' | 'channel' | 'recipient' | 'status' | 'sentAt' | 'replyKind'>[],
  calls: readonly Pick<CallRow, 'direction' | 'fromNumber' | 'toNumber' | 'optedOutAt'>[],
): { keys: ErasureKey[]; skipped: ErasureSkipped[] } {
  const keys = new Map<string, ErasureKey>()
  const skipped: ErasureSkipped[] = []
  const add = (k: ErasureKey): void => void keys.set(`${k.kind}\u0000${k.value}`, k)

  const fields: readonly [ErasureKeyKind, string | null, ErasureFailure][] = [
    ['email', contact.email, 'unreadable_email'],
    ['phone', contact.phone, 'unreadable_phone'],
    ['linkedin', contact.linkedinUrl, 'unreadable_linkedin'],
  ]
  for (const [kind, raw, failure] of fields) {
    if (raw === null || !raw.trim()) continue
    const r = keyFor(kind, raw)
    if ('key' in r) add(r.key)
    else if (r.skip === 'company_page') skipped.push({ from: 'contact', why: 'company_page' })
    else throw new ErasureAborted(failure)
  }

  for (const t of touches) {
    if (t.recipient === null || !t.recipient.trim()) continue
    const kind = kindForChannel(t.channel)
    if (!kind) continue
    if (t.direction === 'out') {
      const r = keyFor(kind, t.recipient)
      if ('key' in r) add(r.key)
      // A row that never went out reached nobody; only one that did is worth saying.
      else if (t.sentAt !== null || WENT_OUT.has(t.status)) skipped.push({ from: 'message', why: r.skip })
    } else if (t.replyKind === 'opted_out') {
      const r = keyFor(kind, t.recipient)
      if ('key' in r) add(r.key)
      else skipped.push({ from: 'opt_out', why: r.skip })
    }
  }

  for (const c of calls) {
    // The other party: the caller on an inbound call, the callee on an
    // outbound one — the number `recordOptOut` is handed.
    const theirs = c.direction === 'in' ? c.fromNumber : c.toNumber
    if (theirs === null || !theirs.trim()) continue
    const r = keyFor('phone', theirs)
    if ('key' in r) add(r.key)
    else skipped.push({ from: c.optedOutAt ? 'opt_out' : 'call', why: r.skip })
  }

  return { keys: [...keys.values()], skipped }
}

// ---------------------------------------------------------------------------
// The erasure
// ---------------------------------------------------------------------------

export type ErasureOutcome =
  | {
      readonly ok: true
      /** Messages scrubbed, both directions. */
      readonly touchesScrubbed: number
      readonly callsScrubbed: number
      /**
       * Keys on the suppression list for them when the erasure committed —
       * written now, or already there from an earlier opt-out. "Added" is
       * the erasure's act; a key that was already present is still one the
       * erasure made sure of, and counting only new rows would audit a
       * person who unsubscribed first as "0 kept".
       */
      readonly suppressionsAdded: number
      /** Of those, how many rows this erasure wrote. */
      readonly suppressionsNew: number
      readonly meetingsScrubbed: number
      readonly notesDeleted: number
      readonly tasksDeleted: number
      /** Queued, awaiting approval or approved messages to them, now refused. */
      readonly cancelled: number
      /** The booking page's `<address>.inbound` company for them, renamed. */
      readonly companyRenamed: boolean
      /** Values deliberately not put on the list. Reason classes only. */
      readonly skipped: readonly ErasureSkipped[]
      /**
       * Calls that had a recording link. The recording itself is at the
       * carrier; these SIDs are what a person searches for there to delete it.
       */
      readonly recordingsAtCarrier: readonly string[]
    }
  | { readonly ok: false; readonly reason: 'not_found'; readonly message: string }
  | {
      readonly ok: false
      readonly reason: 'suppression_failed'
      readonly message: string
      readonly why: ErasureFailure
      /** Whether they are paused now — the safe direction, set on this path. */
      readonly paused: boolean
      /** Their most recent message, for a notification that must name one. Null when they have none. */
      readonly latestTouchId: string | null
    }

const FAILURE_WORDS: Readonly<Record<string, string>> = {
  unreadable_email:
    'The email address on file cannot be read as an address, so it cannot go on the suppression list. ' +
    'Correct it on their row (or clear it if it is not theirs), then erase again.',
  unreadable_phone:
    'The phone number on file is not in international form, so it cannot go on the suppression list. ' +
    'Correct it on their row — a + and the country code, like +44 20 7946 0000 — then erase again.',
  unreadable_linkedin:
    'The LinkedIn URL on file cannot be read as a profile, so it cannot go on the suppression list. ' +
    'Paste the full profile URL on their row, like linkedin.com/in/jane-doe, then erase again.',
}

function failureMessage(why: ErasureFailure, paused: boolean): string {
  const lead = FAILURE_WORDS[why] ?? 'The database refused part of the erasure, so all of it was undone. Try again; if it fails again, a person has to look.'
  const pause = paused
    ? 'They have been paused meanwhile, so nothing goes to them.'
    : 'Check they are paused — nothing should go to them meanwhile.'
  return `Nothing was erased and nothing was added to the suppression list. ${lead} ${pause}`
}

const stderrLog: InboundLog = {
  error: (message, fields) => {
    console.error(JSON.stringify({ level: 'error', message, ...fields, at: new Date().toISOString() }))
  },
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError'
}

/** What `booking.ts` names the company of a free-mail booker. Kept in step with it by a test. */
function inboundDomainFor(email: string): string {
  return `${email.replace(/[^a-z0-9]+/g, '-')}.inbound`
}

/**
 * Erase a person, keeping the suppression. One transaction: the suppression
 * rows first, then the scrubs, then the contact row, then the audit row —
 * all of it or none of it. See the header for exactly what is touched.
 *
 * `actor` is the users.id of whoever pressed the button; the route gates it
 * to owners. Never throws: a failure is `suppression_failed`, already
 * audited, logged and paused by the time the caller sees it.
 */
export async function erasureErase(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly actor: string
    readonly now?: Date
    /** See `InboundLog`. Defaults to a structured line on stderr. */
    readonly log?: InboundLog
  },
): Promise<ErasureOutcome> {
  const now = args.now ?? new Date()
  const log = args.log ?? stderrLog
  const { orgId, contactId } = args
  const notFound = { ok: false, reason: 'not_found', message: 'No such contact — they may already have been erased.' } as const
  if (!UUID.test(contactId)) return notFound

  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as AgencyDb

      // Locked, so a second erasure pressed at the same moment waits here and
      // then finds nobody, instead of both writing and one failing late.
      const [contact] = await tx
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
        .limit(1)
        .for('update')
      if (!contact) throw new ErasureNotFound()

      // Every predicate below carries the org as well as the contact.
      const theirTouches = and(eq(schema.touches.orgId, orgId), eq(schema.touches.contactId, contactId))
      const theirCalls = and(eq(schema.calls.orgId, orgId), eq(schema.calls.contactId, contactId))

      const [touches, calls] = await Promise.all([
        tx
          .select({
            id: schema.touches.id,
            direction: schema.touches.direction,
            channel: schema.touches.channel,
            recipient: schema.touches.recipient,
            status: schema.touches.status,
            sentAt: schema.touches.sentAt,
            replyKind: schema.touches.replyKind,
          })
          .from(schema.touches)
          .where(theirTouches),
        tx
          .select({
            id: schema.calls.id,
            direction: schema.calls.direction,
            fromNumber: schema.calls.fromNumber,
            toNumber: schema.calls.toNumber,
            optedOutAt: schema.calls.optedOutAt,
            recordingUrl: schema.calls.recordingUrl,
            providerCallSid: schema.calls.providerCallSid,
          })
          .from(schema.calls)
          .where(theirCalls),
      ])

      // (1) The suppression rows. Everything below is conditional on these.
      const { keys, skipped } = erasureKeys(contact, touches, calls)
      const reason = `erasure request, ${now.toISOString().slice(0, 10)}`
      let suppressionsNew = 0
      for (const key of keys) {
        // Sequential on purpose: a transaction is one connection, and the
        // first failure has to stop the rest rather than race them.
        const r = await addSuppression(tx, { orgId, kind: key.kind, value: key.value, reason, source: 'erasure' })
        if (!r.ok) throw new ErasureAborted(`unreadable_${key.kind}`)
        if (!r.alreadyPresent) suppressionsNew++
      }

      // (2) Anything still waiting to go to them is refused, as a reply
      // refuses it — the record that a message was about to go, and did not,
      // is the useful one. Before the scrub, so the scrub sees the final status.
      const cancelled = await tx
        .update(schema.touches)
        .set({ status: 'refused', refusalCode: 'consent_revoked' })
        .where(
          and(
            theirTouches,
            eq(schema.touches.direction, 'out'),
            inArray(schema.touches.status, [...STILL_QUEUED]),
          ),
        )
        .returning({ id: schema.touches.id })

      // (3) Their words, and the addresses they were reached at.
      const inbound = await tx
        .update(schema.touches)
        .set({
          subject: ERASURE_PLACEHOLDER,
          body: ERASURE_PLACEHOLDER,
          // An opt-out keeps the key it was recorded against — see the header.
          recipient: sql`CASE WHEN ${schema.touches.replyKind} = 'opted_out' THEN ${schema.touches.recipient} ELSE ${ERASURE_PLACEHOLDER}::text END`,
        })
        .where(and(theirTouches, eq(schema.touches.direction, 'in')))
        .returning({ id: schema.touches.id })
      const outbound = await tx
        .update(schema.touches)
        .set({
          recipient: null,
          error: sql`CASE WHEN ${schema.touches.error} IS NULL THEN NULL ELSE ${ERASURE_PLACEHOLDER}::text END`,
        })
        .where(and(theirTouches, eq(schema.touches.direction, 'out')))
        .returning({ id: schema.touches.id })
      // 0008's `touches_names_a_subject`: a message must name a contact, a
      // company or a campaign. SET NULL is about to take the contact, so a row
      // that named only them is given their company — which is what it was
      // about. Without this one queued draft would make a person unerasable.
      await tx
        .update(schema.touches)
        .set({ companyId: contact.companyId })
        .where(and(theirTouches, isNull(schema.touches.companyId), isNull(schema.touches.campaignId)))

      const scrubbedCalls = await tx
        .update(schema.calls)
        .set({
          fromNumber: sql`CASE WHEN ${schema.calls.optedOutAt} IS NULL THEN NULL ELSE ${schema.calls.fromNumber} END`,
          toNumber: sql`CASE WHEN ${schema.calls.optedOutAt} IS NULL THEN NULL ELSE ${schema.calls.toNumber} END`,
          transcript: sql`'[]'::jsonb`,
          summary: null,
          recordingUrl: null,
        })
        .where(theirCalls)
        .returning({ id: schema.calls.id })

      const meetings = await tx
        .update(schema.meetings)
        .set({ title: null, notes: null })
        .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.contactId, contactId)))
        .returning({ id: schema.meetings.id })

      // (4) Notes about them, and tasks hanging off their messages. Notes
      // would cascade with the contact; deleted here so they can be counted.
      const touchIds = touches.map((t) => t.id)
      const tasks = touchIds.length
        ? await tx
            .delete(schema.tasks)
            .where(and(eq(schema.tasks.orgId, orgId), inArray(schema.tasks.touchId, touchIds)))
            .returning({ id: schema.tasks.id })
        : []
      const notes = await tx
        .delete(schema.notes)
        .where(and(eq(schema.notes.orgId, orgId), eq(schema.notes.contactId, contactId)))
        .returning({ id: schema.notes.id })

      // (5) The booking page's company for a free-mail booker is named after
      // them and its domain IS their address. Renamed only when it is exactly
      // the one booking.ts would have made from this address.
      let companyRenamed = false
      const email = contact.email ? normaliseEmail(contact.email) : null
      if (email) {
        const renamed = await tx
          .update(schema.companies)
          .set({ domain: `erased-${contact.companyId.slice(0, 8)}.inbound`, name: null })
          .where(
            and(
              eq(schema.companies.orgId, orgId),
              eq(schema.companies.id, contact.companyId),
              eq(schema.companies.domain, inboundDomainFor(email)),
            ),
          )
          .returning({ id: schema.companies.id })
        companyRenamed = renamed.length === 1
      }

      // (6) The row itself. Consents cascade, so a re-import starts from NO;
      // messages, meetings and calls keep their history with SET NULL.
      await tx
        .delete(schema.contacts)
        .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))

      const touchesScrubbed = new Set([...inbound, ...outbound].map((t) => t.id)).size
      // Not `.catch`-ed: an erasure with no record that it happened should
      // not happen. §2.3 — three counts, and nothing else.
      await appendAudit(tx, {
        orgId,
        actor: args.actor,
        action: 'contact.erased',
        subjectType: 'contact',
        subjectId: contactId,
        detail: { touchesScrubbed, callsScrubbed: scrubbedCalls.length, suppressionsAdded: keys.length },
      })

      return {
        ok: true as const,
        touchesScrubbed,
        callsScrubbed: scrubbedCalls.length,
        suppressionsAdded: keys.length,
        suppressionsNew,
        meetingsScrubbed: meetings.length,
        notesDeleted: notes.length,
        tasksDeleted: tasks.length,
        cancelled: cancelled.length,
        companyRenamed,
        skipped,
        recordingsAtCarrier: calls
          .filter((c) => c.recordingUrl !== null)
          .map((c) => c.providerCallSid ?? c.id),
      }
    })
  } catch (err) {
    if (err instanceof ErasureNotFound) return notFound
    const why: ErasureFailure = err instanceof ErasureAborted ? err.why : errorName(err)

    // Rolled back: nothing erased, nothing suppressed. The safe direction
    // first — nothing more goes to a person who asked to be erased.
    // `pauseContact` answers false for a contact who was already paused,
    // which is the same state; only a throw leaves them unpaused.
    let paused = false
    try {
      await pauseContact(db, orgId, contactId, `erasure requested ${now.toISOString().slice(0, 10)}; not completed (${why})`, now)
      paused = true
    } catch (pauseErr) {
      log.error('erasure could not pause the contact', { contactId, orgId, error: errorName(pauseErr) })
    }

    let latestTouchId: string | null = null
    try {
      const [latest] = await db
        .select({ id: schema.touches.id })
        .from(schema.touches)
        .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.contactId, contactId)))
        .orderBy(desc(schema.touches.createdAt))
        .limit(1)
      latestTouchId = latest?.id ?? null
    } catch {
      // The notification is the only reader; without a touch it is skipped
      // and the log line below is the alarm.
    }

    await appendAudit(db, {
      orgId,
      actor: args.actor,
      action: 'contact.erasure_failed',
      subjectType: 'contact',
      subjectId: contactId,
      // A reason CLASS: `unreadable_phone`, an error's name. Never a value.
      detail: { why, paused },
    }).catch(() => {})
    log.error('OPT-OUT NOT RECORDED — an erasure could not keep its suppression; nothing was erased', {
      path: 'erasure', orgId, contactId, why, paused,
    })
    return { ok: false, reason: 'suppression_failed', message: failureMessage(why, paused), why, paused, latestTouchId }
  }
}

/** Exposed for the test that keeps it in step with `booking.ts`. */
export const erasureInboundDomainFor = inboundDomainFor
