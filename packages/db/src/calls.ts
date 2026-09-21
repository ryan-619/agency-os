/**
 * Calls — the record of every conversation on the phone (PROMPT.md §8.5).
 *
 * A call is not a message, so it is not a `touches` row: it carries a
 * transcript, an outcome, a sentiment and who it was handed to. What it
 * shares with the send path is the part that matters — §2.1's rules — and
 * this module does not reimplement them. Placing an OUTBOUND call goes
 * through `decideSend` with channel `voice` like everything else, and the
 * `calls_outbound_names_its_touch` constraint (0014) makes that structural:
 * a row that claims `direction = 'out'` must name the touch whose approval
 * put it there.
 *
 * Two obligations are recorded as columns rather than trusted to code,
 * because after the fact they are the only evidence that they happened:
 *
 *   * `disclosed_ai_at` — §2.1 and the FCC's February 2024 ruling that an
 *     AI voice is an "artificial voice". The service writes it before the
 *     conversation starts; a completed call with a NULL there is a call that
 *     did not disclose, and that is a question somebody can be made to
 *     answer;
 *   * `opted_out_at` — the instant the caller asked to be left alone. It is
 *     written in the same call as the suppression row, below, so the two
 *     cannot drift.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  normalisePhone, qualificationOutcome, sentimentOf, summariseCall,
  type CallOutcome, type QualificationState, type Sentiment, type TranscriptEntry,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { addSuppression } from './campaigns.js'

export type CallRow = typeof schema.calls.$inferSelect

export interface StartCallInput {
  readonly orgId: string
  readonly direction: 'in' | 'out'
  readonly fromNumber: string
  readonly toNumber: string
  readonly providerCallSid: string
  readonly provider?: string
  /** Outbound only: the touch whose approval placed the call (§2.4). */
  readonly touchId?: string | null
  readonly now?: Date
}

/**
 * Who is this, if we know them?
 *
 * Matched on the NORMALISED number, because that is the only form the
 * database stores (`suppressions_value_is_normalised`, and `createContact`
 * normalises on the way in). A number that cannot be normalised matches
 * nothing — correctly: an unmatchable number is one no suppression row
 * could ever have protected either.
 */
export async function contactByPhone(
  db: AgencyDb,
  orgId: string,
  phone: string,
): Promise<{ id: string; companyId: string; firstName: string | null; lastName: string | null } | null> {
  const e164 = normalisePhone(phone)
  if (!e164) return null
  const rows = await db
    .select({
      id: schema.contacts.id,
      companyId: schema.contacts.companyId,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
    })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.phone, e164)))
    .limit(1)
  return rows[0] ?? null
}

/** Is this number on the do-not-contact list? Checked before the AI says anything. */
export async function phoneIsSuppressed(db: AgencyDb, orgId: string, phone: string): Promise<boolean> {
  const e164 = normalisePhone(phone)
  // An unreadable number is treated as suppressed rather than clear: the
  // send path makes the same choice for the same reason (§2.1). "We could
  // not parse it" is not "they never asked us to stop".
  if (!e164) return true
  const rows = await db
    .select({ id: schema.suppressions.id })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.orgId, orgId),
        eq(schema.suppressions.kind, 'phone'),
        eq(schema.suppressions.value, e164),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Open the record for a call, tying it to whoever we recognise.
 *
 * Idempotent on `provider_call_sid`: Twilio retries webhooks, and the status
 * callback, the TwiML request and the relay session all arrive separately
 * and must all find the SAME row (0004's partial unique
 * index `calls_provider_sid_key`).
 */
export async function startCall(db: AgencyDb, input: StartCallInput): Promise<CallRow> {
  const now = input.now ?? new Date()
  const provider = input.provider ?? 'twilio'
  const theirNumber = input.direction === 'in' ? input.fromNumber : input.toNumber
  const known = await contactByPhone(db, input.orgId, theirNumber)

  const rows = await db
    .insert(schema.calls)
    .values({
      orgId: input.orgId,
      direction: input.direction,
      status: 'ringing',
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      provider,
      providerCallSid: input.providerCallSid,
      contactId: known?.id ?? null,
      companyId: known?.companyId ?? null,
      touchId: input.touchId ?? null,
      startedAt: now,
    })
    // 0004's `calls_provider_sid_key` is a PARTIAL unique index —
    // `(provider_call_sid) WHERE provider_call_sid IS NOT NULL` — so the
    // predicate has to be repeated here or Postgres cannot match an arbiter
    // index and rejects the statement outright.
    .onConflictDoNothing({
      target: schema.calls.providerCallSid,
      where: sql`provider_call_sid IS NOT NULL`,
    })
    .returning()

  const created = rows[0]
  if (created) return created
  // Somebody else inserted it first — a retried webhook. Theirs is the row.
  const existing = await callByProviderSid(db, provider, input.providerCallSid)
  if (!existing) throw new Error('call insert conflicted but no row was found')
  return existing
}

export async function callByProviderSid(db: AgencyDb, provider: string, sid: string): Promise<CallRow | null> {
  const rows = await db
    .select()
    .from(schema.calls)
    .where(and(eq(schema.calls.provider, provider), eq(schema.calls.providerCallSid, sid)))
    .limit(1)
  return rows[0] ?? null
}

export async function readCall(db: AgencyDb, orgId: string, id: string): Promise<CallRow | null> {
  const rows = await db
    .select()
    .from(schema.calls)
    .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.id, id)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The AI said it was an AI.
 *
 * Written once, before anything else is said. `answered_at` is stamped with
 * it because in practice they are the same instant — the disclosure IS the
 * first thing the caller hears (`aiDisclosure` in packages/core).
 */
export async function recordDisclosure(db: AgencyDb, callId: string, at: Date = new Date()): Promise<void> {
  await db
    .update(schema.calls)
    .set({ disclosedAiAt: at, answeredAt: at, status: 'in_progress' })
    .where(and(eq(schema.calls.id, callId), isNull(schema.calls.disclosedAiAt)))
}

/**
 * Append one line to the transcript.
 *
 * Appended IN THE DATABASE (`jsonb || jsonb`) rather than read-modify-written
 * in the service: a call is a stream of turns arriving faster than a round
 * trip, and two overlapping appends done in application code silently lose
 * one of them. The transcript is the evidence of what was said, so losing a
 * line is not cosmetic.
 */
export async function appendTranscript(db: AgencyDb, callId: string, entry: TranscriptEntry): Promise<void> {
  await db
    .update(schema.calls)
    .set({ transcript: sql`${schema.calls.transcript} || ${JSON.stringify([entry])}::jsonb` })
    .where(eq(schema.calls.id, callId))
}

/**
 * The caller asked to be left alone — honoured immediately (§8.5).
 *
 * Both halves in one call, because doing one without the other is the bug:
 * a call marked `opted_out` that never reached the suppression list is a
 * person who asked to be left alone and will be contacted again. The
 * suppression is what every later send path actually consults; the column
 * is only the record of when it happened.
 */
export async function recordOptOut(
  db: AgencyDb,
  args: { readonly orgId: string; readonly callId: string; readonly phone: string; readonly now?: Date },
): Promise<{ suppressed: boolean; message?: string }> {
  const now = args.now ?? new Date()
  await db.update(schema.calls).set({ optedOutAt: now }).where(eq(schema.calls.id, args.callId))

  const added = await addSuppression(db, {
    orgId: args.orgId,
    kind: 'phone',
    value: args.phone,
    reason: 'asked to be removed during a call',
  })
  await appendAudit(db, {
    orgId: args.orgId,
    actor: 'voice',
    action: 'call.opted_out',
    subjectType: 'call',
    subjectId: args.callId,
    // The number is NOT in the detail: it is already on the suppression row,
    // and an audit log is read by more people than that list is (§2.3).
    detail: { suppressed: added.ok },
  }).catch(() => {})

  return added.ok
    ? { suppressed: true }
    : {
        suppressed: false,
        // §2.1's Phase 4 obligation, restated for voice: a suppression that
        // failed to store is an opt-out that was never recorded, and it must
        // fail loudly to a human rather than be swallowed.
        message: added.message,
      }
}

export async function recordHandoff(
  db: AgencyDb,
  args: { readonly orgId: string; readonly callId: string; readonly toUserId?: string | null; readonly reason: string },
): Promise<void> {
  await db
    .update(schema.calls)
    .set({ handoffToUserId: args.toUserId ?? null, handoffReason: args.reason.slice(0, 300) })
    .where(eq(schema.calls.id, args.callId))
  await appendAudit(db, {
    orgId: args.orgId,
    actor: 'voice',
    action: 'call.handoff',
    subjectType: 'call',
    subjectId: args.callId,
    detail: { reason: args.reason.slice(0, 200), toUserId: args.toUserId ?? null },
  }).catch(() => {})
}

export interface EndCallInput {
  readonly orgId: string
  readonly callId: string
  readonly status: 'completed' | 'failed' | 'no_answer' | 'busy' | 'cancelled'
  readonly outcome?: CallOutcome | null
  readonly summary?: string | null
  readonly durationS?: number | null
  readonly recordingUrl?: string | null
  readonly state?: QualificationState
  readonly now?: Date
}

/**
 * Close the record: outcome, sentiment, summary, duration (§8.5).
 *
 * The summary and the sentiment are DERIVED from the transcript that was
 * stored, by the pure functions in `packages/core`, rather than accumulated
 * in the service's memory — so a call whose service crashed halfway still
 * gets an honest summary of the part that was recorded, and two people
 * reading the same call read the same words.
 */
export async function endCall(db: AgencyDb, input: EndCallInput): Promise<CallRow | null> {
  const now = input.now ?? new Date()
  const call = await readCall(db, input.orgId, input.callId)
  if (!call) return null

  const transcript = (call.transcript ?? []) as TranscriptEntry[]
  const outcome: CallOutcome =
    input.outcome ??
    (input.status === 'completed'
      ? input.state
        ? qualificationOutcome(input.state)
        : 'incomplete'
      : input.status === 'no_answer' || input.status === 'busy'
        ? 'no_answer'
        : 'failed')
  const sentiment: Sentiment = sentimentOf(transcript)
  const duration =
    input.durationS ??
    (call.startedAt ? Math.max(0, Math.round((now.getTime() - call.startedAt.getTime()) / 1000)) : null)

  const rows = await db
    .update(schema.calls)
    .set({
      status: input.status,
      endedAt: now,
      durationS: duration,
      outcome,
      sentiment,
      summary: input.summary ?? summariseCall(transcript, outcome, input.state),
      ...(input.recordingUrl ? { recordingUrl: input.recordingUrl } : {}),
    })
    .where(and(eq(schema.calls.orgId, input.orgId), eq(schema.calls.id, input.callId)))
    .returning()

  await appendAudit(db, {
    orgId: input.orgId,
    actor: 'voice',
    action: 'call.ended',
    subjectType: 'call',
    subjectId: input.callId,
    detail: { status: input.status, outcome, sentiment, durationS: duration, disclosed: call.disclosedAiAt !== null },
  }).catch(() => {})

  return rows[0] ?? null
}

export interface CallListRow extends CallRow {
  readonly companyDomain: string | null
  readonly companyName: string | null
  readonly contactName: string | null
}

/** Every call in an org, newest first, with whoever it was with. */
export async function listCalls(db: AgencyDb, orgId: string, limit = 100): Promise<CallListRow[]> {
  const rows = await db
    .select({
      call: schema.calls,
      companyDomain: schema.companies.domain,
      companyName: schema.companies.name,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
    })
    .from(schema.calls)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.calls.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.calls.contactId))
    .where(eq(schema.calls.orgId, orgId))
    .orderBy(desc(schema.calls.startedAt))
    .limit(limit)
  return rows.map((r) => ({
    ...r.call,
    companyDomain: r.companyDomain,
    companyName: r.companyName,
    contactName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
  }))
}

export async function callsForCompany(db: AgencyDb, orgId: string, companyId: string): Promise<CallRow[]> {
  return db
    .select()
    .from(schema.calls)
    .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.companyId, companyId)))
    .orderBy(desc(schema.calls.startedAt))
}

/**
 * Calls the AI answered without ever disclosing itself.
 *
 * Should always be empty. It is a query rather than an assumption because
 * "the code writes it first" is exactly the kind of claim that stays true
 * until somebody reorders two lines, and this is the one §2.1 obligation
 * whose absence is invisible from the outside.
 */
export async function callsThatDidNotDisclose(db: AgencyDb, orgId: string): Promise<CallRow[]> {
  return db
    .select()
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.orgId, orgId),
        eq(schema.calls.direction, 'in'),
        isNull(schema.calls.disclosedAiAt),
        sql`${schema.calls.answeredAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(schema.calls.startedAt))
}
