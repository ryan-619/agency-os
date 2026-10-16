/**
 * Delete, and what it will not delete (2026-10-15).
 *
 * The operator asked for a delete "everywhere in the CRM", to take out the
 * records the chat agent invented before 0029 — people who do not exist,
 * guessed addresses, cafés filed under a dead `business.site` domain, the
 * meetings and deals it made for them — and the ordinary mistakes any team
 * makes. The rule every writer here keeps: **a delete removes a record that
 * nothing outside the building ever depended on.** Where something did — a
 * message went out or may have, a reply or a call came in, somebody said no
 * or asked to stop and it could not be recorded — the writer refuses with a
 * sentence naming the act that does apply (erase, withdraw, cancel, close the
 * deal, switch off), and nothing is written.
 *
 * Never deleted here: a message that went or may have gone (`sending`,
 * `sent`, `failed` and the older `delivered`, `bounced`, `replied`), an
 * inbound reply, a call, a suppression, a consent refusal, an approval, a
 * user, the audit log, and a scan, finding or score on its own. A never-sent
 * outbound row (`awaiting_approval`, `approved`, `queued`) goes with what it
 * was for; a `refused` row is kept — it never went, and it is the record
 * that it was stopped — unless the delete would leave it naming nothing,
 * which 0008's `touches_names_a_subject` refuses.
 *
 * Every writer is one transaction that locks what it removes `FOR UPDATE`
 * and asks its refusals again under that lock, so a reply, a claim or a
 * teammate's edit landing between a read and the delete is seen. A refusal
 * found after a write rolls the write back (`Refused`). The audit row is
 * written inside the same transaction and never caught: a delete with no
 * record that it happened must not exist. Its detail is ids, counts and
 * kinds — a company's own domain (or a no-website business's placeholder),
 * name and Google place id, never a person's address, number or words.
 * A refusal decided by a row's state locks that row whatever its state,
 * and reads the state in JS: a status filter in the read would not wait
 * for a row a teammate is changing.
 *
 * Every id is read through `uuidOf` — lower-cased, as the database prints
 * one — before anything is compared with it.
 *
 * Lock order, contact before touch (`test/lock-order.test.ts`): a contact's
 * delete locks the person, then their consent rows; a company's locks its
 * people, then the company, then its quotes, proposals, meetings, tasks and
 * deals, then touches their messages — the order an erasure, which holds the
 * person and then renames the company, already takes, and the one a reply
 * takes when it holds the person and then writes rows naming the company; a
 * deal's locks its proposals, meetings and tasks before the deal. Not every
 * writer agrees: an insert into meetings, notes or quotes takes the
 * company's key-share before the person's, and `approveDraft` locks a draft
 * before its recipient — `companyDelete` states the cycles that leaves.
 */
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import { isNoSiteDomain, pauseReasonClass } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { DIGEST_OPT_OUT_FAILURES } from './digest.js'
import { isReferencedRowRefusal } from './pg-errors.js'
import { heldForUnrecordedSharedNumber, isSharedNumberOptOutPause } from './sms.js'

/** Waiting to go and never sent: the only outbound rows a delete removes. */
const LIVE_DRAFT = ['awaiting_approval', 'approved', 'queued'] as const

/**
 * Outbound statuses that mean the message went, or may have: `sending` is the
 * worker's claim (the provider may have it), `failed` may have gone, and
 * `delivered`, `bounced` and `replied` are older words for a sent row.
 */
const WENT_OR_MAY_HAVE = ['sending', 'sent', 'delivered', 'bounced', 'replied', 'failed'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * An id as the database prints one — a uuid's full shape, lower-cased — or
 * null. Every writer here reads its id through this first (review,
 * 2026-10-15): Postgres matches a uuid whatever its case, but the Maps and
 * Sets the refusals are read from are keyed by the ids it RETURNS, so
 * `DELETE /api/contacts/<ID IN CAPITALS>` found the person, looked their keep
 * reason up by the typed spelling, found none, and deleted somebody who had
 * said no.
 */
function uuidOf(raw: string): string | null {
  return UUID.test(raw) ? raw.toLowerCase() : null
}

/** The one foreign key that points at `message_templates` (0019). */
const CHECKED_AGAINST_A_TEMPLATE = 'touches_template_is_in_the_same_org_and_channel'

/** `scores.icp_profile_id` (0002), named by Postgres for the column. */
const SCORED_UNDER_A_PROFILE = 'scores_icp_profile_id_fkey'

/** A refusal a person reads. Never an address, a number or a person's words. */
export interface DeleteRefusal<Code extends string> {
  readonly ok: false
  readonly code: Code | 'not_found'
  readonly message: string
}

/** Who pressed it: a users.id, or the literal `'agent'` for a card a person approved. */
interface DeleteArgs {
  readonly orgId: string
  readonly actor: string
}

/**
 * A refusal found inside the transaction, thrown so that whatever was
 * already written rolls back with it.
 */
class Refused<Code extends string> extends Error {
  constructor(readonly refusal: DeleteRefusal<Code>) {
    super(refusal.message)
    this.name = 'Refused'
  }
}

function refuse<Code extends string>(code: Code | 'not_found', message: string): never {
  throw new Refused<Code>({ ok: false, code, message })
}

/** One transaction; a `Refused` thrown inside it is the answer, with nothing written. */
async function inOne<T, Code extends string>(
  db: AgencyDb,
  work: (tx: AgencyDb) => Promise<T>,
): Promise<T | DeleteRefusal<Code>> {
  try {
    return await db.transaction(async (transaction) => work(transaction as unknown as AgencyDb))
  } catch (err) {
    if (err instanceof Refused) return (err as Refused<Code>).refusal
    throw err
  }
}

const notFound = <Code extends string>(what: string): DeleteRefusal<Code> => ({
  ok: false,
  code: 'not_found',
  message: `No such ${what} — it may already have been deleted.`,
})

const count = sql<number>`count(*)::int`

/**
 * How a company is named in a sentence. A booking page's `<address>.inbound`
 * placeholder IS a person's address and its name is theirs, so it is "this
 * company"; a business with no website of its own is named by its name.
 */
function companyLabel(c: { readonly domain: string; readonly name: string | null }): string {
  if (c.domain.endsWith('.inbound')) return 'this company'
  if (isNoSiteDomain(c.domain)) return c.name?.replace(/\s+/g, ' ').trim().slice(0, 80) || 'this business'
  return c.domain
}

// ---------------------------------------------------------------------------
// What keeps a person on the record
// ---------------------------------------------------------------------------

/**
 * Why a contact may not be deleted, the strongest first:
 *
 *  - `in_flight`  a message to them is `sending` — the worker holds it now;
 *  - `history`    something went to them or may have, a reply or a call came
 *                 from them, or an answer to a reply of theirs is waiting;
 *  - `unrecorded` an opt-out or an erasure of THEIRS could not be recorded —
 *                 an audit row naming them says so, or their pause is that
 *                 class. The pause and the row are all that hold them until
 *                 it is recorded, and neither ever lifts;
 *  - `refusal`    a consent row says no. Email is a cold channel where NO
 *                 row means a message may go, so deleting the row — consents
 *                 cascade — would lift the refusal with no record
 *                 (`contactsLiftRefusal` is the one audited lift), and on SMS
 *                 and voice the record that they said no would be gone;
 *  - `shared_number` a text from a number they share asked to stop and could
 *                 not be recorded — held hard for it
 *                 (`isSharedNumberOptOutPause`), or listed by a row that
 *                 still governs them (`heldForUnrecordedSharedNumber`). They
 *                 may never have sent it (review, 2026-10-15): it was read
 *                 as `unrecorded`, which told a person the opt-out was
 *                 theirs and to erase them — and an erasure puts their email
 *                 and LinkedIn on the suppression list for good. Recording
 *                 the NUMBER (then Resume, for the hard hold) ends it, and
 *                 the delete then goes through. Weakest of all, because every
 *                 other reason needs more than that.
 *
 * Each of `history`, `unrecorded` and `refusal` is a case for an owner's
 * erasure, which keeps their addresses on the suppression list. Shared by the
 * contact's delete and the company's, so the two cannot disagree about a
 * person.
 */
type KeepReason = 'in_flight' | 'history' | 'refusal' | 'unrecorded' | 'shared_number'

const KEEP_RANK: Record<KeepReason, number> = { in_flight: 5, history: 4, unrecorded: 3, refusal: 2, shared_number: 1 }

interface PersonToCheck {
  readonly id: string
  readonly phone: string | null
  readonly pausedReason: string | null
}

async function contactKeepReasons(
  tx: AgencyDb,
  orgId: string,
  people: readonly PersonToCheck[],
): Promise<Map<string, KeepReason>> {
  const reasons = new Map<string, KeepReason>()
  if (people.length === 0) return reasons
  const ids = people.map((p) => p.id)
  const keep = (id: string | null, why: KeepReason): void => {
    if (!id) return
    const was = reasons.get(id)
    if (!was || KEEP_RANK[why] > KEEP_RANK[was]) reasons.set(id, why)
  }

  const touches = await tx
    .select({ contactId: schema.touches.contactId, direction: schema.touches.direction, status: schema.touches.status })
    .from(schema.touches)
    .where(and(eq(schema.touches.orgId, orgId), inArray(schema.touches.contactId, ids), historyTouch()))
  for (const t of touches) keep(t.contactId, t.direction === 'out' && t.status === 'sending' ? 'in_flight' : 'history')

  const calls = await tx
    .select({ contactId: schema.calls.contactId })
    .from(schema.calls)
    .where(and(eq(schema.calls.orgId, orgId), inArray(schema.calls.contactId, ids)))
  for (const c of calls) keep(c.contactId, 'history')

  // Every consent row of theirs, LOCKED, whatever it says (review,
  // 2026-10-15). A "no" recorded while the delete runs is the upsert's
  // `ON CONFLICT … DO UPDATE` of a row that said yes: it changes no key, so
  // it takes no lock on the contact and would not wait for ours, and the
  // cascade then took the refusal with no trace. Locked here, it waits for
  // the delete and then — its row gone with the person — falls back to an
  // INSERT whose foreign key fails, so whoever records the no is told; or
  // it committed first and is read here. A `granted = false` filter would
  // not wait on a row whose yes is turning into a no, so `granted` is read
  // in JS.
  const consents = await tx
    .select({ contactId: schema.consents.contactId, granted: schema.consents.granted })
    .from(schema.consents)
    .where(and(eq(schema.consents.orgId, orgId), inArray(schema.consents.contactId, ids)))
    .orderBy(asc(schema.consents.id))
    .for('update')
  for (const c of consents) if (!c.granted) keep(c.contactId, 'refusal')

  // The rows a writer leaves when it KNEW an opt-out failed to store, by
  // subject or `detail.contactId` — what /inbox and Resume read. Not locked:
  // `audit_log` has no foreign key, so nothing about one waits for this
  // delete. A writer that touches the contact row too — a reply's inbound
  // row (its key-share), the pause it writes (an UPDATE) — waits on the
  // person's lock: it either landed first and is read here and in the pause
  // class below, or the delete wins and its pause then finds nobody. That
  // last is an opt-out failure arriving for a person just deleted: its row
  // and its alarm still name them, and /compliance counts it (CLAUDE.md,
  // "Delete, and what it will not delete", stated residuals).
  const unrecorded = await tx
    .select({
      subjectType: schema.auditLog.subjectType,
      subjectId: schema.auditLog.subjectId,
      named: sql<string | null>`${schema.auditLog.detail}->>'contactId'`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        inArray(schema.auditLog.action, [...DIGEST_OPT_OUT_FAILURES]),
        or(
          and(eq(schema.auditLog.subjectType, 'contact'), inArray(schema.auditLog.subjectId, ids)),
          inArray(sql`${schema.auditLog.detail}->>'contactId'`, ids),
        ),
      ),
    )
  const asked = new Set(ids)
  for (const row of unrecorded) {
    if (row.subjectType === 'contact' && row.subjectId && asked.has(row.subjectId)) keep(row.subjectId, 'unrecorded')
    if (row.named && asked.has(row.named)) keep(row.named, 'unrecorded')
  }

  for (const p of people) {
    // The hard hold reads as class `opt_out_not_recorded` — asked first, so
    // a holder is never told the opt-out was theirs.
    if (p.pausedReason && isSharedNumberOptOutPause(p.pausedReason)) {
      keep(p.id, 'shared_number')
      continue
    }
    const pausedFor = p.pausedReason ? pauseReasonClass(p.pausedReason) : null
    if (pausedFor === 'opt_out_not_recorded' || pausedFor === 'erasure') keep(p.id, 'unrecorded')
    else if (!reasons.has(p.id) && (await heldForUnrecordedSharedNumber(tx, orgId, p))) keep(p.id, 'shared_number')
  }
  return reasons
}

/**
 * A message that keeps its subject on the record: anything inbound, an
 * outbound row that went or may have, and a waiting answer to a reply —
 * a reply came in, whoever it was filed under.
 */
function historyTouch(): SQL {
  return or(
    eq(schema.touches.direction, 'in'),
    inArray(schema.touches.status, [...WENT_OR_MAY_HAVE]),
    and(isNotNull(schema.touches.answersTouchId), inArray(schema.touches.status, [...LIVE_DRAFT])),
  )!
}

/**
 * What applies to a person whose OWN opt-out or an unfinished erasure could
 * not be recorded, for the contact's delete and the company's — never a
 * shared number's holder, who has words of their own (`sharedNumberWayOut`).
 * The refusal said "Record it on /suppressions, or an owner can erase them"
 * as if either let the delete through, and recording it never does (review,
 * 2026-10-15): the audit row is permanent, and Resume refuses a pause of
 * their own unrecorded opt-out and an unfinished erasure outright, so the
 * refusal came back word for word. The two acts are named apart — record it
 * so nothing reaches them; erase them to remove them.
 */
const RECORD_IT_THEN_ERASE =
  'Record it on /suppressions so nothing reaches them; to remove the person, an owner can erase them on /contacts, ' +
  'which keeps their addresses on the suppression list.'

const CONTACT_KEPT: Record<KeepReason, string> = {
  in_flight: 'A message to this contact is being sent right now. Try again in a minute.',
  history:
    'Something went out to this contact or came from them, so it stays on the record. An owner can erase them on ' +
    '/contacts, which keeps their addresses on the suppression list.',
  refusal:
    'This contact said no to being contacted, and that refusal is part of their record — deleting them would lift ' +
    'it with no trace. An owner can erase them on /contacts, which keeps their addresses on the suppression list.',
  unrecorded:
    'An opt-out or an erasure of this contact’s could not be recorded, and their record is what holds them until it ' +
    `is. ${RECORD_IT_THEN_ERASE}`,
  shared_number:
    'A text from a number this contact shares asked to stop, and it could not be recorded — they may not have sent ' +
    `it. ${sharedNumberWayOut('they')}`,
}

/**
 * The way out for a shared number's holder, as Resume and /suppressions word
 * it everywhere else (`RESUME_SHARED_NUMBER`): record the NUMBER, lift the
 * hold that text put on them, and the delete goes through. Never an erasure,
 * which would suppress somebody who may never have asked.
 */
function sharedNumberWayOut(who: 'they' | 'the company'): string {
  return (
    'Record the number on /suppressions; if that text paused them, Resume them on /contacts too; then ' +
    `${who === 'they' ? 'they' : 'the company'} can be deleted.`
  )
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type ContactDeleteCode = 'in_flight' | 'must_erase' | 'shared_number'

export type ContactDeleteResult =
  | {
      readonly ok: true
      readonly companyId: string
      readonly draftsRemoved: number
      readonly consentsRemoved: number
      readonly notesRemoved: number
    }
  | DeleteRefusal<ContactDeleteCode>

/**
 * Delete a person nothing ever went to or came from (`contactKeepReasons`
 * says who may not go, and why). Their waiting drafts go with them — the
 * tasks hanging off those cascade — as do their consents (only grants: a
 * refusal refuses the delete), notes about them and follow-up runs; a
 * `refused` row of theirs is kept, given their company first when it named
 * only them, as an erasure does (`touches_names_a_subject`); meetings and
 * quotes keep their rows with the person taken off. A suppression keyed by
 * their address is untouched.
 */
export async function contactDelete(
  db: AgencyDb,
  args: DeleteArgs & { readonly contactId: string },
): Promise<ContactDeleteResult> {
  const { orgId } = args
  const contactId = uuidOf(args.contactId)
  if (!contactId) return notFound('contact')
  return inOne<ContactDeleteResult, ContactDeleteCode>(db, async (tx) => {
    // The person first: contact before touch.
    const [contact] = await tx
      .select({
        id: schema.contacts.id,
        companyId: schema.contacts.companyId,
        phone: schema.contacts.phone,
        pausedReason: schema.contacts.pausedReason,
      })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
      .limit(1)
      .for('update')
    if (!contact) refuse('not_found', notFound('contact').message)

    // By the row's own id, as the database spells it — the Map's keys.
    const kept = (await contactKeepReasons(tx, orgId, [contact])).get(contact.id)
    if (kept) refuse(kept === 'in_flight' || kept === 'shared_number' ? kept : 'must_erase', CONTACT_KEPT[kept])

    const theirs = and(eq(schema.touches.orgId, orgId), eq(schema.touches.contactId, contactId))
    const drafts = await tx
      .delete(schema.touches)
      .where(and(theirs, eq(schema.touches.direction, 'out'), inArray(schema.touches.status, [...LIVE_DRAFT])))
      .returning({ id: schema.touches.id })
    // A claim the worker made between the check and the delete: the row is
    // `sending` now and was not removed. Everything rolls back.
    const claimed = await tx.select({ id: schema.touches.id }).from(schema.touches).where(and(theirs, historyTouch())).limit(1)
    if (claimed.length > 0) refuse('in_flight', CONTACT_KEPT.in_flight)

    // 0008's `touches_names_a_subject`: a kept row that named only them is
    // given their company before SET NULL takes the contact (erasure.ts).
    await tx
      .update(schema.touches)
      .set({ companyId: contact.companyId })
      .where(and(theirs, isNull(schema.touches.companyId), isNull(schema.touches.campaignId)))

    const [consents] = await tx
      .select({ n: count })
      .from(schema.consents)
      .where(and(eq(schema.consents.orgId, orgId), eq(schema.consents.contactId, contactId)))
    const [notes] = await tx
      .select({ n: count })
      .from(schema.notes)
      .where(and(eq(schema.notes.orgId, orgId), eq(schema.notes.contactId, contactId)))

    await tx.delete(schema.contacts).where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))

    const removed = {
      companyId: contact.companyId,
      draftsRemoved: drafts.length,
      consentsRemoved: consents?.n ?? 0,
      notesRemoved: notes?.n ?? 0,
    }
    await appendAudit(tx, {
      orgId,
      actor: args.actor,
      action: 'contact.deleted',
      subjectType: 'contact',
      subjectId: contactId,
      detail: removed,
    })
    return { ok: true as const, ...removed }
  })
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export type CompanyDeleteCode =
  | 'in_flight'
  | 'has_history'
  | 'call_record'
  | 'contact_must_be_erased'
  | 'shared_number'
  | 'deal_won'
  | 'quote_sent'
  | 'proposal_sent'
  | 'meeting_held'

export interface CompanyDeleteCounts {
  readonly contacts: number
  readonly drafts: number
  readonly deals: number
  readonly meetings: number
  readonly quotes: number
  readonly proposals: number
  readonly scans: number
}

export type CompanyDeleteResult = ({ readonly ok: true } & CompanyDeleteCounts) | DeleteRefusal<CompanyDeleteCode>

/**
 * Delete a company nothing ever went to or came from, with everything that
 * hangs off it: its people (each by the contact rules — one of them kept is
 * the company kept), their drafts and its own (an agent's company-only
 * draft, a quote's or a link's draft email), its scans with their findings
 * and scores, deals, meetings with no outcome, draft quotes and proposals,
 * every share link (an audit page or preview a business was sent stops
 * working), notes, tasks, research and site audits — CASCADE does the rest.
 *
 * Refused while a message about it is being sent, when anything went or
 * came, when a call there recorded that they asked to stop (`taskDelete`'s
 * own `call_record` — that is where the number's suppression came from),
 * when a person there must be erased instead, a deal is won, a quote was
 * ever sent (one revised back to a draft included: a buyer holds its
 * number), a proposal left draft, or a meeting has its outcome recorded.
 *
 * Lock order: its people, then the company, then the rows whose state
 * decides the delete — quotes, proposals, meetings, tasks, deals — every one
 * whatever its state, and only then any message. A
 * status filter on those reads would not wait for a row a teammate is
 * changing ("Mark as sent", a drag to Won, a recorded outcome or "asked to
 * stop"), whose old value it would read, and the cascade then took the
 * new one; locked, such a write is waited for and read, and one that comes
 * after finds nothing to change. Quotes, proposals and meetings come before
 * deals, the order their own writers take them (a quote sent, then its deal
 * moved), and `dealDelete` takes them in the same order.
 *
 * Three cycles are left, stated (CLAUDE.md, "Delete, and what it will not
 * delete"), each ended by Postgres aborting one side with 40P01 and nothing
 * half-written: a writer that holds one of those rows and then adds a row
 * naming the company (accepting a quote makes a task); an INSERT into
 * meetings, notes or quotes, whose foreign-key checks take the company's
 * key-share before the contact's (`book_meeting`, Record meeting, the
 * booking page, `add_note`, a quote naming a person) — the opposite of the
 * people-then-company order here; a reply's touch checks the contact first,
 * and is not one — and `approveDraft`, which locks a draft and then waits on
 * its recipient's key-share, while the delete holds the recipient and then
 * deletes the draft. When the delete is the side aborted it answers as a
 * fault — 500 on the web, "deleting it failed" in chat, nothing deleted —
 * and pressing it again works; an aborted `approveDraft` answers its
 * approver a bare 500.
 *
 * A never-sent `refused` row with no campaign, which would name nothing once
 * the company and its people are gone, is removed with them; one with a
 * campaign is kept, the campaign's record of what it stopped.
 *
 * Its `company.deleted` row carries the domain, name and Google place id —
 * `deletedCompanyKeys` reads them so the night shift and the agent do not
 * file it again — and for a business with no website its `.nosite.invalid`
 * placeholder, which is built from its own name and place, never from
 * anybody's address. Only a booking page's `.inbound` placeholder is kept
 * out, domain and name both: that IS a person's address, and its name theirs.
 */
export async function companyDelete(
  db: AgencyDb,
  args: DeleteArgs & { readonly companyId: string },
): Promise<CompanyDeleteResult> {
  const { orgId } = args
  const companyId = uuidOf(args.companyId)
  if (!companyId) return notFound('company')
  return inOne<CompanyDeleteResult, CompanyDeleteCode>(db, async (tx) => {
    const peopleOf = () =>
      tx
        .select({
          id: schema.contacts.id,
          phone: schema.contacts.phone,
          pausedReason: schema.contacts.pausedReason,
        })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.companyId, companyId)))
        .orderBy(asc(schema.contacts.id))
        .for('update')
    // Its people first, in id order, then the company: contact before
    // company, as an erasure and a reply hold them. Once the company is
    // locked no contact can be added under it (the insert's key-share waits),
    // so a second read locks any added in between.
    await peopleOf()
    const [company] = await tx
      .select({
        id: schema.companies.id,
        domain: schema.companies.domain,
        name: schema.companies.name,
        googlePlaceId: schema.companies.googlePlaceId,
      })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, companyId)))
      .limit(1)
      .for('update')
    if (!company) refuse('not_found', notFound('company').message)
    const people = await peopleOf()
    const ids = people.map((p) => p.id)
    const label = companyLabel(company)

    // Then the rows whose state decides the delete, each locked whatever its
    // state, in id order, and judged below in JS (see the header).
    const quotes = await tx
      .select({ id: schema.quotes.id, number: schema.quotes.number, status: schema.quotes.status, createdAt: schema.quotes.createdAt })
      .from(schema.quotes)
      .where(and(eq(schema.quotes.orgId, orgId), eq(schema.quotes.companyId, companyId)))
      .orderBy(asc(schema.quotes.id))
      .for('update')
    const proposals = await tx
      .select({ status: schema.proposals.status })
      .from(schema.proposals)
      .where(and(eq(schema.proposals.orgId, orgId), eq(schema.proposals.companyId, companyId)))
      .orderBy(asc(schema.proposals.id))
      .for('update')
    const meetings = await tx
      .select({ outcome: schema.meetings.outcome })
      .from(schema.meetings)
      .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.companyId, companyId)))
      .orderBy(asc(schema.meetings.id))
      .for('update')
    // Every task, not only calls and visits: a deal's delete locks the tasks
    // naming it before the deal, so a to-do left for the cascade, locked
    // after the deal here, would close that cycle (review, 2026-10-15).
    const tasks = await tx
      .select({ kind: schema.tasks.kind, doneAt: schema.tasks.doneAt, outcome: schema.tasks.outcome })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.companyId, companyId)))
      .orderBy(asc(schema.tasks.id))
      .for('update')
    const callTasks = tasks.filter((t) => t.kind === 'call' || t.kind === 'visit')
    const deals = await tx
      .select({ stage: schema.deals.stage })
      .from(schema.deals)
      .where(and(eq(schema.deals.orgId, orgId), eq(schema.deals.companyId, companyId)))
      .orderBy(asc(schema.deals.id))
      .for('update')

    const aboutIt = (): SQL =>
      and(
        eq(schema.touches.orgId, orgId),
        ids.length > 0
          ? or(eq(schema.touches.companyId, companyId), inArray(schema.touches.contactId, ids))!
          : eq(schema.touches.companyId, companyId),
      )!
    const history = async () =>
      tx
        .select({ direction: schema.touches.direction, status: schema.touches.status })
        .from(schema.touches)
        .where(and(aboutIt(), historyTouch()))
    const inFlight = `A message about ${label} is being sent right now. Try again in a minute.`
    const hadHistory =
      `Messages or calls went to or came from ${label}, so the company stays on the record. Close its deal as lost, ` +
      'or erase a person on /contacts.'

    const went = await history()
    if (went.some((t) => t.direction === 'out' && t.status === 'sending')) refuse('in_flight', inFlight)
    if (went.length > 0) refuse('has_history', hadHistory)
    const calls = await tx
      .select({ id: schema.calls.id })
      .from(schema.calls)
      .where(
        and(
          eq(schema.calls.orgId, orgId),
          ids.length > 0
            ? or(eq(schema.calls.companyId, companyId), inArray(schema.calls.contactId, ids))
            : eq(schema.calls.companyId, companyId),
        ),
      )
      .limit(1)
    if (calls.length > 0) refuse('has_history', hadHistory)
    // A person's call where they asked to stop: no code here dials, so the
    // calls the agency makes are call and visit tasks, and `taskDelete`
    // keeps this one. Its predicate, so the two cannot disagree (review,
    // 2026-10-15) — the cascade took it with the company.
    if (callTasks.some(recordsAnAskToStop)) {
      refuse(
        'call_record',
        `A call to ${label} is recorded where they asked to stop, and that is where the suppression on their number came ` +
          'from, so the company stays on the record. Close its deal as lost instead.',
      )
    }

    const kept = [...(await contactKeepReasons(tx, orgId, people)).values()]
    if (kept.includes('in_flight')) refuse('in_flight', inFlight)
    if (kept.includes('history')) refuse('has_history', hadHistory)
    if (kept.includes('unrecorded')) {
      refuse(
        'contact_must_be_erased',
        `A person at ${label} has an opt-out or an erasure that could not be recorded, and their record is what holds ` +
          `them until it is, so the company stays. ${RECORD_IT_THEN_ERASE}`,
      )
    }
    if (kept.includes('refusal')) {
      refuse(
        'contact_must_be_erased',
        `A person at ${label} said no to being contacted, and deleting the company would lift that refusal with no ` +
          'trace. An owner can erase them on /contacts first, which keeps their addresses on the suppression list.',
      )
    }
    if (kept.includes('shared_number')) {
      refuse(
        'shared_number',
        `A person at ${label} shares a number a text asked to stop from, and it could not be recorded — they may not ` +
          `have sent it. ${sharedNumberWayOut('the company')}`,
      )
    }

    if (deals.some((d) => d.stage === 'won')) {
      refuse('deal_won', 'Its deal is marked won. Move it off Won first if that was a mistake.')
    }

    const byAge = [...quotes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    const quote = byAge.find((q) => q.status !== 'draft')
    if (quote) {
      refuse(
        'quote_sent',
        quote.status === 'sent'
          ? `A quote was sent for ${label} (${quote.number}); withdraw it, but it stays on the record.`
          : `A quote for ${label} (${quote.number}) is ${quote.status}, so the company stays on the record.`,
      )
    }
    // A draft now that went out once — edited after it was sent, which
    // makes it a draft again (`quoteUpdate`) — is a number a buyer holds.
    const once = await quotesEverSent(tx, orgId, byAge.map((q) => q.id))
    const revised = byAge.find((q) => once.has(q.id))
    if (revised) {
      refuse(
        'quote_sent',
        `A quote for ${label} (${revised.number}) went out before it was revised back to a draft — a buyer holds its ` +
          'number — so the company stays on the record.',
      )
    }
    const proposal = proposals.find((p) => p.status !== 'draft')
    if (proposal) {
      refuse(
        'proposal_sent',
        proposal.status === 'sent'
          ? `A proposal was sent for ${label}; withdraw it, but it stays on the record.`
          : `A proposal for ${label} is ${proposal.status}, so the company stays on the record.`,
      )
    }
    if (meetings.some((m) => m.outcome !== null)) {
      refuse('meeting_held', `A meeting with ${label} has its outcome recorded, so the company stays.`)
    }

    // The writes. Never-sent drafts — its people's and its own — first.
    const drafts = await tx
      .delete(schema.touches)
      .where(and(aboutIt(), eq(schema.touches.direction, 'out'), inArray(schema.touches.status, [...LIVE_DRAFT])))
      .returning({ id: schema.touches.id })
    if ((await history()).length > 0) refuse('in_flight', inFlight)
    // A refused row with no campaign would name nothing once the company and
    // its people are gone (0008's CHECK). It never went: it goes with them.
    const orphans = await tx
      .delete(schema.touches)
      .where(
        and(
          aboutIt(),
          isNull(schema.touches.campaignId),
          eq(schema.touches.direction, 'out'),
          eq(schema.touches.status, 'refused'),
          or(isNull(schema.touches.companyId), eq(schema.touches.companyId, companyId)),
          ids.length > 0
            ? or(isNull(schema.touches.contactId), inArray(schema.touches.contactId, ids))
            : isNull(schema.touches.contactId),
        ),
      )
      .returning({ id: schema.touches.id })

    // What CASCADE is about to take, counted for the audit row: the rows
    // locked above are all there are — a new one naming the company waits
    // on its lock — and its scans are counted.
    const [scans] = await tx
      .select({ n: count })
      .from(schema.scans)
      .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.companyId, companyId)))
    const counts: CompanyDeleteCounts = {
      contacts: ids.length,
      drafts: drafts.length + orphans.length,
      deals: deals.length,
      meetings: meetings.length,
      quotes: quotes.length,
      proposals: proposals.length,
      scans: scans?.n ?? 0,
    }

    if (ids.length > 0) {
      await tx.delete(schema.contacts).where(and(eq(schema.contacts.orgId, orgId), inArray(schema.contacts.id, ids)))
    }
    await tx.delete(schema.companies).where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, companyId)))

    // A no-website business's placeholder is kept, so `deletedCompanyAt`
    // knows it again when add_company files the same name in the same place
    // (review, 2026-10-15: kept out, a deleted café came back on the next
    // search). Only a booking page's is not: it is a person's address.
    const inbound = company.domain.endsWith('.inbound')
    await appendAudit(tx, {
      orgId,
      actor: args.actor,
      action: 'company.deleted',
      subjectType: 'company',
      subjectId: companyId,
      detail: {
        domain: inbound ? null : company.domain,
        name: inbound ? null : company.name,
        placeId: company.googlePlaceId,
        ...counts,
      },
    })
    return { ok: true as const, ...counts }
  })
}

/**
 * The companies this org deleted, by domain — a business with no website
 * by its `.nosite.invalid` placeholder — and by Google place id, with when
 * each last was, read from `company.deleted` rows. The night shift and the
 * agent's `add_businesses`, `add_company`, `import_companies` and
 * `scan_company` do not file one of these again; a person adding one with a
 * website on /companies does, because that is a person deciding.
 *
 * A placeholder is `noSiteDomain(name, identity)`, and only the same
 * identity builds it again: a business found on Google Maps by its place id,
 * or one add_company filed by exactly the same name, city and address (an
 * address given once and left out the next time is another identity). Any
 * other spelling, or the same business filed by name and later found on
 * Maps (or the reverse), is a new placeholder and is not known (CLAUDE.md,
 * stated residuals).
 */
export interface DeletedCompanyKeys {
  readonly domains: ReadonlyMap<string, Date>
  readonly placeIds: ReadonlyMap<string, Date>
}

export async function deletedCompanyKeys(db: AgencyDb, orgId: string): Promise<DeletedCompanyKeys> {
  const rows = await db
    .select({
      domain: sql<string | null>`${schema.auditLog.detail}->>'domain'`,
      placeId: sql<string | null>`${schema.auditLog.detail}->>'placeId'`,
      at: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'company.deleted')))
  const domains = new Map<string, Date>()
  const placeIds = new Map<string, Date>()
  const latest = (map: Map<string, Date>, key: string | null, at: Date): void => {
    if (!key) return
    const was = map.get(key)
    if (!was || was < at) map.set(key, at)
  }
  for (const r of rows) {
    const domain = r.domain?.trim().toLowerCase() || null
    // Never a booking page's placeholder: it is a person's address, and the
    // writer stores none — a row that somehow carries one is not a key.
    latest(domains, domain && !domain.endsWith('.inbound') ? domain : null, r.at)
    latest(placeIds, r.placeId, r.at)
  }
  return { domains, placeIds }
}

/**
 * When this business was deleted, by its place id or its domain — its own,
 * or its no-website placeholder (review, 2026-10-15: the placeholder was
 * skipped here, so add_company's website "none" filed a deleted café again
 * at once) — or null.
 */
export function deletedCompanyAt(
  keys: DeletedCompanyKeys,
  business: { readonly domain?: string | null; readonly placeId?: string | null },
): Date | null {
  const byPlace = business.placeId ? keys.placeIds.get(business.placeId) : undefined
  const domain = business.domain?.trim().toLowerCase()
  const byDomain = domain ? keys.domains.get(domain) : undefined
  if (byPlace && byDomain) return byPlace > byDomain ? byPlace : byDomain
  return byPlace ?? byDomain ?? null
}

/**
 * What a writer that will not file a deleted company says, per business —
 * this one, matched by its key; nothing wider is promised. A business with
 * no website of its own (`noWebsite`) is named by its name, and is not
 * promised back on /companies: that page adds a domain, and a business with
 * none cannot be added there.
 */
export function deletedCompanyWords(label: string, at: Date, noWebsite = false): string {
  const day = at.toISOString().slice(0, 10)
  return noWebsite
    ? `${label} was deleted by a teammate on ${day}, so it is not filed again here; a business with no website ` +
        'cannot be added on /companies.'
    : `${label} was deleted by a teammate on ${day}; a person can add it again on /companies.`
}

// ---------------------------------------------------------------------------
// Deals, meetings, proposals, quotes, tasks
// ---------------------------------------------------------------------------

export type DealDeleteResult = { readonly ok: true; readonly companyId: string } | DeleteRefusal<'deal_won'>

/**
 * Delete a deal that is not won. Its meetings, proposals and tasks stay,
 * with the deal taken off them; the next automatic move opens a new one
 * (`deals_one_open_per_company`). Its moves stop counting in
 * `analyticsTransitions`, which reads only deals that exist.
 *
 * Lock order: the proposals, meetings and tasks its delete SETs NULL — every
 * row naming it, in id order — and only then the deal. Child before deal is
 * the order `companyDelete` and the status writers take (review,
 * 2026-10-15): locked first, the deal's SET NULL waited on a meeting a
 * company's delete held, while that delete waited on the deal.
 */
export async function dealDelete(db: AgencyDb, args: DeleteArgs & { readonly dealId: string }): Promise<DealDeleteResult> {
  const { orgId } = args
  const dealId = uuidOf(args.dealId)
  if (!dealId) return notFound('deal')
  return inOne<DealDeleteResult, 'deal_won'>(db, async (tx) => {
    await tx
      .select({ id: schema.proposals.id })
      .from(schema.proposals)
      .where(and(eq(schema.proposals.orgId, orgId), eq(schema.proposals.dealId, dealId)))
      .orderBy(asc(schema.proposals.id))
      .for('update')
    await tx
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.dealId, dealId)))
      .orderBy(asc(schema.meetings.id))
      .for('update')
    await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.dealId, dealId)))
      .orderBy(asc(schema.tasks.id))
      .for('update')
    const [deal] = await tx
      .select({ id: schema.deals.id, companyId: schema.deals.companyId, stage: schema.deals.stage })
      .from(schema.deals)
      .where(and(eq(schema.deals.orgId, orgId), eq(schema.deals.id, dealId)))
      .limit(1)
      .for('update')
    if (!deal) refuse('not_found', notFound('deal').message)
    if (deal.stage === 'won') refuse('deal_won', 'This deal is marked won, so it stays. Move it off Won first if that was a mistake.')
    await tx.delete(schema.deals).where(and(eq(schema.deals.orgId, orgId), eq(schema.deals.id, dealId)))
    await appendAudit(tx, {
      orgId, actor: args.actor, action: 'deal.deleted', subjectType: 'deal', subjectId: dealId,
      detail: { companyId: deal.companyId, stage: deal.stage },
    })
    return { ok: true as const, companyId: deal.companyId }
  })
}

export type MeetingDeleteCode = 'outcome_recorded' | 'replaces_rescheduled'

export type MeetingDeleteResult = { readonly ok: true; readonly companyId: string } | DeleteRefusal<MeetingDeleteCode>

/**
 * The meetings among these that replaced a rescheduled one — read from the
 * two rows `rescheduleMeeting` writes in one transaction: the new meeting's
 * `meeting.booked` naming the old (`rescheduledFrom`), and the old
 * meeting's `meeting.outcome_recorded` naming the new (`rescheduledTo`, never
 * caught). Either is enough. `meetingDelete` refuses one, and the meeting
 * page and the company page offer no Delete on one.
 */
export async function meetingsThatReplacedOne(
  db: AgencyDb,
  orgId: string,
  meetingIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(meetingIds.flatMap((raw) => uuidOf(raw) ?? []))]
  const found = new Set<string>()
  if (ids.length === 0) return found
  const a = schema.auditLog
  const rows = await db
    .select({
      action: a.action,
      subjectId: a.subjectId,
      to: sql<string | null>`${a.detail}->>'rescheduledTo'`,
    })
    .from(a)
    .where(
      and(
        eq(a.orgId, orgId),
        eq(a.subjectType, 'meeting'),
        or(
          and(eq(a.action, 'meeting.booked'), inArray(a.subjectId, ids), sql`${a.detail}->>'rescheduledFrom' IS NOT NULL`),
          and(eq(a.action, 'meeting.outcome_recorded'), inArray(sql`${a.detail}->>'rescheduledTo'`, ids)),
        ),
      ),
    )
  for (const r of rows) {
    const id = r.action === 'meeting.booked' ? r.subjectId : r.to
    if (id && ids.includes(id.toLowerCase())) found.add(id.toLowerCase())
  }
  return found
}

/**
 * Delete a meeting whose outcome is not recorded. The deal does not move
 * back: a booking moved it forward, and a person moves it on the board.
 *
 * Not one that replaced a rescheduled meeting (review, 2026-10-15): the
 * original's outcome says `rescheduled` and points at it, and with it gone
 * the original was "rescheduled" to nothing — a claim with no evidence that
 * no screen could correct, since a rescheduled outcome is never changed and
 * a meeting with an outcome is never deleted. It is cancelled instead.
 */
export async function meetingDelete(db: AgencyDb, args: DeleteArgs & { readonly meetingId: string }): Promise<MeetingDeleteResult> {
  const { orgId } = args
  const meetingId = uuidOf(args.meetingId)
  if (!meetingId) return notFound('meeting')
  return inOne<MeetingDeleteResult, MeetingDeleteCode>(db, async (tx) => {
    const [meeting] = await tx
      .select({
        id: schema.meetings.id, companyId: schema.meetings.companyId, startsAt: schema.meetings.startsAt,
        source: schema.meetings.source, outcome: schema.meetings.outcome, cancelledAt: schema.meetings.cancelledAt,
      })
      .from(schema.meetings)
      .where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.id, meetingId)))
      .limit(1)
      .for('update')
    if (!meeting) refuse('not_found', notFound('meeting').message)
    if (meeting.outcome !== null) refuse('outcome_recorded', 'Its outcome is recorded; it stays.')
    if ((await meetingsThatReplacedOne(tx, orgId, [meeting.id])).has(meeting.id)) {
      refuse(
        'replaces_rescheduled',
        meeting.cancelledAt === null
          ? 'It replaced a rescheduled meeting; cancel it instead.'
          : 'It replaced a rescheduled meeting, which points to it, so it stays; it is already cancelled.',
      )
    }
    await tx.delete(schema.meetings).where(and(eq(schema.meetings.orgId, orgId), eq(schema.meetings.id, meetingId)))
    await appendAudit(tx, {
      orgId, actor: args.actor, action: 'meeting.deleted', subjectType: 'meeting', subjectId: meetingId,
      detail: { companyId: meeting.companyId, startsAt: meeting.startsAt.toISOString(), source: meeting.source },
    })
    return { ok: true as const, companyId: meeting.companyId }
  })
}

export type ProposalDeleteResult = { readonly ok: true; readonly companyId: string } | DeleteRefusal<'not_draft'>

/** Delete a draft proposal; anything past draft is withdrawn instead, and stays. */
export async function proposalDelete(db: AgencyDb, args: DeleteArgs & { readonly proposalId: string }): Promise<ProposalDeleteResult> {
  const { orgId } = args
  const proposalId = uuidOf(args.proposalId)
  if (!proposalId) return notFound('proposal')
  return inOne<ProposalDeleteResult, 'not_draft'>(db, async (tx) => {
    const [proposal] = await tx
      .select({ id: schema.proposals.id, companyId: schema.proposals.companyId, status: schema.proposals.status })
      .from(schema.proposals)
      .where(and(eq(schema.proposals.orgId, orgId), eq(schema.proposals.id, proposalId)))
      .limit(1)
      .for('update')
    if (!proposal) refuse('not_found', notFound('proposal').message)
    if (proposal.status !== 'draft') refuse('not_draft', 'Only a draft can be deleted; mark it withdrawn.')
    await tx.delete(schema.proposals).where(and(eq(schema.proposals.orgId, orgId), eq(schema.proposals.id, proposalId)))
    await appendAudit(tx, {
      orgId, actor: args.actor, action: 'proposal.deleted', subjectType: 'proposal', subjectId: proposalId,
      detail: { companyId: proposal.companyId },
    })
    return { ok: true as const, companyId: proposal.companyId }
  })
}

export type QuoteDeleteResult =
  | { readonly ok: true; readonly companyId: string; readonly number: string }
  | DeleteRefusal<'not_draft'>

/**
 * The quotes among these that went out at least once, whatever their status
 * now: a `quote.sent` row names it, or a link was ever made for it (a
 * revoked one stays a row). Editing a sent quote makes it a draft again and
 * clears `sent_at` (`quoteUpdate`), so `status` alone cannot say — and a
 * buyer holds the number of one that went (review, 2026-10-15).
 */
export async function quotesEverSent(db: AgencyDb, orgId: string, quoteIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(quoteIds.flatMap((raw) => uuidOf(raw) ?? []))]
  const sent = new Set<string>()
  if (ids.length === 0) return sent
  const audited = await db
    .select({ id: schema.auditLog.subjectId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.action, 'quote.sent'),
        eq(schema.auditLog.subjectType, 'quote'),
        inArray(schema.auditLog.subjectId, ids),
      ),
    )
  const linked = await db
    .select({ id: schema.shareLinks.quoteId })
    .from(schema.shareLinks)
    .where(and(eq(schema.shareLinks.orgId, orgId), inArray(schema.shareLinks.quoteId, ids)))
  for (const r of [...audited, ...linked]) if (r.id) sent.add(r.id.toLowerCase())
  return sent
}

/**
 * Delete a draft quote that never went out; a sent one is withdrawn
 * instead, and stays — and so does one sent and then revised back to a
 * draft (`quotesEverSent`): its number is in a buyer's hands, and deleted,
 * the next quote raised would take it. Stated residual: the next quote
 * raised this year may take a deleted draft's number, because `nextNumber`
 * counts from the highest one on file. That draft was never marked sent and
 * never had a link, but its Print/PDF shows the number with no "draft" on
 * it, and a person may have handed that to a buyer by hand — then two
 * offers carry one number. A company's delete takes its drafts the same
 * way, and its row records how many, not their numbers.
 */
export async function quoteDelete(db: AgencyDb, args: DeleteArgs & { readonly quoteId: string }): Promise<QuoteDeleteResult> {
  const { orgId } = args
  const quoteId = uuidOf(args.quoteId)
  if (!quoteId) return notFound('quote')
  return inOne<QuoteDeleteResult, 'not_draft'>(db, async (tx) => {
    const [quote] = await tx
      .select({ id: schema.quotes.id, companyId: schema.quotes.companyId, number: schema.quotes.number, status: schema.quotes.status })
      .from(schema.quotes)
      .where(and(eq(schema.quotes.orgId, orgId), eq(schema.quotes.id, quoteId)))
      .limit(1)
      .for('update')
    if (!quote) refuse('not_found', notFound('quote').message)
    if (quote.status !== 'draft') refuse('not_draft', 'Only a draft quote can be deleted; withdraw a sent one.')
    if ((await quotesEverSent(tx, orgId, [quote.id])).has(quote.id)) {
      refuse(
        'not_draft',
        `${quote.number} went out before it was revised back to a draft, and a buyer holds its number, so it stays. ` +
          'Mark it sent and withdraw it if it is no longer offered.',
      )
    }
    await tx.delete(schema.quotes).where(and(eq(schema.quotes.orgId, orgId), eq(schema.quotes.id, quoteId)))
    await appendAudit(tx, {
      orgId, actor: args.actor, action: 'quote.deleted', subjectType: 'quote', subjectId: quoteId,
      detail: { companyId: quote.companyId, number: quote.number },
    })
    return { ok: true as const, companyId: quote.companyId, number: quote.number }
  })
}

export type TaskDeleteResult =
  | { readonly ok: true; readonly companyId: string | null; readonly kind: string }
  | DeleteRefusal<'linkedin_step' | 'call_record'>

/**
 * A done call or visit whose outcome was "asked to stop": where the number's
 * suppression came from. Kept by `taskDelete`, and keeps its company in
 * `companyDelete` — one predicate, so the two cannot disagree.
 */
function recordsAnAskToStop(t: { readonly doneAt: Date | null; readonly outcome: string | null }): boolean {
  return t.doneAt !== null && t.outcome === 'asked_to_stop'
}

/**
 * Delete a task. Not a LinkedIn step — closing one says whether a message
 * went, which is a person's word on /tasks — and not a call whose outcome
 * was "asked to stop": that is where the number's suppression came from.
 */
export async function taskDelete(db: AgencyDb, args: DeleteArgs & { readonly taskId: string }): Promise<TaskDeleteResult> {
  const { orgId } = args
  const taskId = uuidOf(args.taskId)
  if (!taskId) return notFound('task')
  return inOne<TaskDeleteResult, 'linkedin_step' | 'call_record'>(db, async (tx) => {
    const [task] = await tx
      .select({
        id: schema.tasks.id, companyId: schema.tasks.companyId, kind: schema.tasks.kind,
        doneAt: schema.tasks.doneAt, outcome: schema.tasks.outcome,
      })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.id, taskId)))
      .limit(1)
      .for('update')
    if (!task) refuse('not_found', notFound('task').message)
    if (task.kind === 'linkedin_send') {
      refuse('linkedin_step', 'A LinkedIn step is closed on /tasks with I sent it or I did not send it.')
    }
    if (recordsAnAskToStop(task)) {
      refuse('call_record', 'It records the call where they asked to stop; it stays.')
    }
    await tx.delete(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.id, taskId)))
    await appendAudit(tx, {
      orgId, actor: args.actor, action: 'task.deleted', subjectType: 'task', subjectId: taskId,
      detail: { companyId: task.companyId, kind: task.kind },
    })
    return { ok: true as const, companyId: task.companyId, kind: task.kind }
  })
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type CampaignDeleteCode = 'in_flight' | 'has_history' | 'answer_waiting'

export type CampaignDeleteResult = { readonly ok: true; readonly draftsRemoved: number } | DeleteRefusal<CampaignDeleteCode>

/**
 * Delete a campaign nothing ever went out under. Its waiting drafts go with
 * it, and its steps and follow-up runs cascade; a `refused` row under it is
 * kept with the campaign taken off, unless that would leave it naming
 * nothing (0008's CHECK) — then, never sent, it goes too.
 *
 * Refused while an answer to somebody's reply waits under it: deleting the
 * answer would leave the reply unanswered with nobody paused — a deny on
 * /approvals is what puts that pause back (`repauseForUnansweredReply`).
 */
export async function campaignDelete(
  db: AgencyDb,
  args: DeleteArgs & { readonly campaignId: string },
): Promise<CampaignDeleteResult> {
  const { orgId } = args
  const campaignId = uuidOf(args.campaignId)
  if (!campaignId) return notFound('campaign')
  return inOne<CampaignDeleteResult, CampaignDeleteCode>(db, async (tx) => {
    const [campaign] = await tx
      .select({ id: schema.campaigns.id, name: schema.campaigns.name, channel: schema.campaigns.channel })
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.orgId, orgId), eq(schema.campaigns.id, campaignId)))
      .limit(1)
      .for('update')
    if (!campaign) refuse('not_found', notFound('campaign').message)

    const under = and(eq(schema.touches.orgId, orgId), eq(schema.touches.campaignId, campaignId))!
    const inFlight = 'A message under this campaign is being sent right now. Try again in a minute.'
    const kept = async () =>
      tx
        .select({ status: schema.touches.status, answers: schema.touches.answersTouchId })
        .from(schema.touches)
        .where(and(under, historyTouch()))
    const before = await kept()
    if (before.some((t) => t.status === 'sending')) refuse('in_flight', inFlight)
    if (before.some((t) => (WENT_OR_MAY_HAVE as readonly string[]).includes(t.status))) {
      refuse('has_history', 'Messages went out under this campaign; set it to done instead.')
    }
    if (before.length > 0) {
      refuse(
        'answer_waiting',
        'An answer to somebody’s reply is waiting under this campaign. Deny it on /approvals first, or set the campaign to done instead.',
      )
    }

    const drafts = await tx
      .delete(schema.touches)
      .where(and(under, eq(schema.touches.direction, 'out'), inArray(schema.touches.status, [...LIVE_DRAFT])))
      .returning({ id: schema.touches.id })
    if ((await kept()).length > 0) refuse('in_flight', inFlight)
    // A refused row that names only this campaign would name nothing at all.
    const orphans = await tx
      .delete(schema.touches)
      .where(and(under, isNull(schema.touches.contactId), isNull(schema.touches.companyId), eq(schema.touches.status, 'refused')))
      .returning({ id: schema.touches.id })

    await tx.delete(schema.campaigns).where(and(eq(schema.campaigns.orgId, orgId), eq(schema.campaigns.id, campaignId)))
    const draftsRemoved = drafts.length + orphans.length
    await appendAudit(tx, {
      orgId, actor: args.actor, action: 'campaign.deleted', subjectType: 'campaign', subjectId: campaignId,
      detail: { name: campaign.name, channel: campaign.channel, draftsRemoved },
    })
    return { ok: true as const, draftsRemoved }
  })
}

// ---------------------------------------------------------------------------
// Templates and profiles: RESTRICT decides
// ---------------------------------------------------------------------------

export type TemplateDeleteResult = { readonly ok: true } | DeleteRefusal<'in_use'>

/**
 * Delete a registered template no message names. One that a message was
 * checked against — a draft's included — is kept by `ON DELETE RESTRICT`
 * (0019): it is the evidence that the words matched, and it is switched off
 * instead.
 */
export async function templateDelete(db: AgencyDb, args: DeleteArgs & { readonly templateId: string }): Promise<TemplateDeleteResult> {
  const { orgId } = args
  const templateId = uuidOf(args.templateId)
  if (!templateId) return notFound('template')
  try {
    return await inOne<TemplateDeleteResult, 'in_use'>(db, async (tx) => {
      const [template] = await tx
        .select({ id: schema.messageTemplates.id, channel: schema.messageTemplates.channel, externalId: schema.messageTemplates.externalId })
        .from(schema.messageTemplates)
        .where(and(eq(schema.messageTemplates.orgId, orgId), eq(schema.messageTemplates.id, templateId)))
        .limit(1)
        .for('update')
      if (!template) refuse('not_found', notFound('template').message)
      await tx
        .delete(schema.messageTemplates)
        .where(and(eq(schema.messageTemplates.orgId, orgId), eq(schema.messageTemplates.id, templateId)))
      await appendAudit(tx, {
        orgId, actor: args.actor, action: 'template.deleted', subjectType: 'message_template', subjectId: templateId,
        // A DLT template id is a registration's number, not anybody's data.
        detail: { channel: template.channel, externalId: template.externalId },
      })
      return { ok: true as const }
    })
  } catch (err) {
    if (isReferencedRowRefusal(err, CHECKED_AGAINST_A_TEMPLATE)) {
      return {
        ok: false,
        code: 'in_use',
        message: 'Messages were checked against this registration, so it stays; switch it off instead.',
      }
    }
    throw err
  }
}

export type IcpProfileDeleteResult = { readonly ok: true; readonly name: string } | DeleteRefusal<'active' | 'scored'>

/**
 * Delete a profile that is not active and never scored anything. A score
 * names the profile it was computed under (`ON DELETE RESTRICT`, 0002), so a
 * profile that scored a scan stays as that number's record. Campaigns that
 * named it keep their rows with the profile taken off. The route gates it to
 * owners, as creating and activating one are.
 */
export async function icpProfileDelete(
  db: AgencyDb,
  args: DeleteArgs & { readonly profileId: string },
): Promise<IcpProfileDeleteResult> {
  const { orgId } = args
  const profileId = uuidOf(args.profileId)
  if (!profileId) return notFound('profile')
  try {
    return await inOne<IcpProfileDeleteResult, 'active' | 'scored'>(db, async (tx) => {
      const [profile] = await tx
        .select({ id: schema.icpProfiles.id, name: schema.icpProfiles.name, active: schema.icpProfiles.active })
        .from(schema.icpProfiles)
        .where(and(eq(schema.icpProfiles.orgId, orgId), eq(schema.icpProfiles.id, profileId)))
        .limit(1)
        .for('update')
      if (!profile) refuse('not_found', notFound('profile').message)
      if (profile.active) refuse('active', 'This is the active profile. Activate another profile first.')
      await tx.delete(schema.icpProfiles).where(and(eq(schema.icpProfiles.orgId, orgId), eq(schema.icpProfiles.id, profileId)))
      await appendAudit(tx, {
        orgId, actor: args.actor, action: 'icp.deleted', subjectType: 'icp_profile', subjectId: profileId,
        detail: { label: profile.name },
      })
      return { ok: true as const, name: profile.name }
    })
  } catch (err) {
    if (isReferencedRowRefusal(err, SCORED_UNDER_A_PROFILE)) {
      return { ok: false, code: 'scored', message: 'Scores were computed under it, so it stays as their record.' }
    }
    throw err
  }
}
