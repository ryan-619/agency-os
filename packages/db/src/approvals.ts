/**
 * The approval queue — the table a running agent turn blocks on (PROMPT.md §2.4).
 *
 * Separate from repository.ts because the rules here are about a decision
 * rather than about data: who may make one, what happens when two people make
 * one at once, and what a lapse means as distinct from an answer. Every
 * function is written so that the database, not the caller, settles the race.
 *
 * The shape of the problem, which is what most of this file is about: an agent
 * asks; a human answers, possibly never; and the thing waiting is a permission
 * callback whose only bad outcome is a hang. So nothing here throws on a
 * contended path, every write is a single statement that a constraint can
 * arbitrate, and every read tells the caller what is actually true rather than
 * what it hoped.
 */
import { and, eq, lte, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type ApprovalRow = typeof schema.approvals.$inferSelect
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'
export type Risk = 'low' | 'medium' | 'high'

/**
 * What the agent knows when it asks. `toolUseId` and `turnId` are not optional
 * on this path: `approvals_agent_request_is_traceable` refuses a row that
 * cannot be traced back to the tool call it gates.
 */
export interface ApprovalRequest {
  readonly orgId: string
  readonly chatSessionId: string
  readonly turnId: string
  /** The SDK's `options.toolUseID`. */
  readonly toolUseId: string
  readonly toolName: string
  readonly payload: Record<string, unknown>
  /** sha256 over the canonical payload — see `payloadFingerprint`. */
  readonly payloadSha256: string
  readonly risk: Risk
  readonly expiresAt: Date
}

/** Postgres's unique_violation. Drizzle wraps the driver error, so look at the cause too. */
function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    if ((cur as { code?: unknown }).code === '23505') return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/**
 * A stable fingerprint of a tool call's arguments.
 *
 * Object key order is not stable across a JSON round trip, and the same call
 * arriving twice must hash the same or the retry key below is decorative. Keys
 * are sorted at every level; everything else is left exactly as it is, because
 * a fingerprint that normalises values would let two different calls collide.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = (v as Record<string, unknown>)[k]
    }
    return out
  })
}

async function findByTurnPayload(
  db: AgencyDb,
  orgId: string,
  turnId: string,
  toolName: string,
  payloadSha256: string,
): Promise<ApprovalRow | null> {
  const rows = await db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.orgId, orgId),
        eq(schema.approvals.turnId, turnId),
        eq(schema.approvals.toolName, toolName),
        eq(schema.approvals.payloadSha256, payloadSha256),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

async function findByToolUse(db: AgencyDb, orgId: string, toolUseId: string): Promise<ApprovalRow | null> {
  const rows = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, orgId), eq(schema.approvals.toolUseId, toolUseId)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Raise the approval for a tool call, or return the one that already exists.
 *
 * Idempotent on BOTH keys 0007 added, because the SDK produces two different
 * duplicates. A redelivered permission request after a transport gap repeats
 * the same `tool_use_id`; a call the SDK denied-and-retried arrives with a NEW
 * one and the same arguments. The turn+payload lookup catches both, so it goes
 * first, and the `tool_use_id` lookup is only there for the race.
 *
 * Written select-then-insert-then-catch rather than `ON CONFLICT` on purpose:
 * there are two unique indexes that can arbitrate and `ON CONFLICT` names one
 * of them, and both are partial, which needs a conflict target most callers
 * get subtly wrong. Losing that race is rare; getting it wrong denies every
 * gated call.
 *
 * The important consequence: because this returns the EXISTING row with its
 * decision attached, a redelivery or a retry of an already-answered call
 * inherits that answer. Nobody is asked twice for one intent.
 */
export async function ensureApproval(db: AgencyDb, req: ApprovalRequest): Promise<ApprovalRow> {
  const existing = await findByTurnPayload(db, req.orgId, req.turnId, req.toolName, req.payloadSha256)
  if (existing) return existing

  try {
    const inserted = await db
      .insert(schema.approvals)
      .values({
        orgId: req.orgId,
        requestedBy: 'agent',
        toolName: req.toolName,
        payload: req.payload,
        risk: req.risk,
        status: 'pending',
        expiresAt: req.expiresAt,
        chatSessionId: req.chatSessionId,
        turnId: req.turnId,
        toolUseId: req.toolUseId,
        payloadSha256: req.payloadSha256,
      })
      .returning()
    const row = inserted[0]
    if (!row) throw new Error('approval insert returned no row')
    return row
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Lost a race on one of the two indexes. Whichever it was, the row that
    // won is the one this call must adopt.
    const won =
      (await findByTurnPayload(db, req.orgId, req.turnId, req.toolName, req.payloadSha256)) ??
      (await findByToolUse(db, req.orgId, req.toolUseId))
    if (!won) throw new Error('approval insert conflicted but no existing row was found')
    return won
  }
}

export async function readApproval(db: AgencyDb, orgId: string, id: string): Promise<ApprovalRow | null> {
  const rows = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, orgId), eq(schema.approvals.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export type DecideOutcome =
  | { readonly ok: true; readonly row: ApprovalRow }
  | { readonly ok: false; readonly reason: 'not_found' }
  /** The decider is not a member of the org that owns the approval. */
  | { readonly ok: false; readonly reason: 'not_permitted' }
  | { readonly ok: false; readonly reason: 'expired'; readonly row: ApprovalRow }
  /** Someone else got there first. `row` is THEIR decision, so the loser's
   *  screen can say who decided and when instead of showing an error. */
  | { readonly ok: false; readonly reason: 'already_decided'; readonly row: ApprovalRow }

/**
 * Record a human's decision.
 *
 * One statement, for two reasons. `approvals_decided_has_decider` requires
 * status, decider and time to move together, so a two-step update is rejected
 * by the database. And the `status = 'pending'` predicate is what arbitrates
 * two people clicking Approve at the same moment: exactly one UPDATE matches a
 * row, and the other gets zero and is told who won.
 *
 * The `expires_at > now()` predicate is the other half of a promise the schema
 * made. CLAUDE.md records that 0004 deliberately does NOT forbid an approved
 * row with `decided_at > expires_at`, so that a stale browser tab surfaces as
 * a clean "this request expired" rather than as a constraint violation and a
 * 500. This is where that surfaces.
 */
export async function decideApproval(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly id: string
    readonly decision: 'approved' | 'denied'
    readonly decidedBy: string
    readonly reason?: string | null
  },
): Promise<DecideOutcome> {
  const updated = await db
    .update(schema.approvals)
    .set({
      status: args.decision,
      decidedBy: args.decidedBy,
      decidedAt: sql`now()`,
      decidedReason: args.reason ?? null,
    })
    .where(
      and(
        eq(schema.approvals.id, args.id),
        eq(schema.approvals.orgId, args.orgId),
        eq(schema.approvals.status, 'pending'),
        sql`${schema.approvals.expiresAt} > now()`,
        sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${args.decidedBy} AND u.org_id = ${args.orgId})`,
      ),
    )
    .returning()

  const row = updated[0]
  if (row) return { ok: true, row }

  // Nothing matched. Read the row back and say WHY, rather than returning a
  // bare failure the UI has to guess at.
  const current = await readApproval(db, args.orgId, args.id)
  if (!current) return { ok: false, reason: 'not_found' }
  if (current.status !== 'pending') return { ok: false, reason: 'already_decided', row: current }
  if (current.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired', row: current }
  // Still pending and still live, so the only remaining predicate that can
  // have failed is the org membership of the decider.
  return { ok: false, reason: 'not_permitted' }
}

/**
 * Mark one lapsed approval expired.
 *
 * Conditional on `status = 'pending'`, so a decision landing in the same
 * millisecond wins and this matches nothing. The caller re-reads on a zero
 * result rather than assuming.
 */
export async function expireApproval(db: AgencyDb, orgId: string, id: string): Promise<ApprovalRow | null> {
  const updated = await db
    .update(schema.approvals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(schema.approvals.id, id),
        eq(schema.approvals.orgId, orgId),
        eq(schema.approvals.status, 'pending'),
        sql`${schema.approvals.expiresAt} <= now()`,
      ),
    )
    .returning()
  return updated[0] ?? null
}

/**
 * Expire every lapsed approval in the org.
 *
 * A waiter reaching its own deadline handles the row it is waiting on, but a
 * worker that died leaves rows nobody is waiting on at all — and those sit on
 * the approvals page looking actionable until someone clicks a button that
 * cannot do anything. This is what makes the queue self-correcting.
 *
 * Expiry deliberately records no decider: `approvals_expired_has_no_decider`
 * refuses one, because a lapse is not an answer and must never read like one.
 */
export async function sweepExpiredApprovals(db: AgencyDb, orgId: string): Promise<ApprovalRow[]> {
  return db
    .update(schema.approvals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(schema.approvals.orgId, orgId),
        eq(schema.approvals.status, 'pending'),
        lte(schema.approvals.expiresAt, sql`now()`),
      ),
    )
    .returning()
}

/** Everything still awaiting a human, newest first. Drives the queue page and
 *  the pending count in the sidebar. */
export async function pendingApprovals(db: AgencyDb, orgId: string, limit = 100): Promise<ApprovalRow[]> {
  return db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, orgId), eq(schema.approvals.status, 'pending')))
    .orderBy(schema.approvals.createdAt)
    .limit(limit)
}

/** The approvals raised inside one chat session, so a reattaching browser can
 *  rebuild the cards it missed. */
export async function approvalsForSession(
  db: AgencyDb,
  orgId: string,
  chatSessionId: string,
): Promise<ApprovalRow[]> {
  return db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, orgId), eq(schema.approvals.chatSessionId, chatSessionId)))
    .orderBy(schema.approvals.createdAt)
}

/**
 * Append to the audit log (§5.4: "Approval decides; the audit log remembers").
 *
 * Deliberately not batched and deliberately not transactional with the thing
 * it records: an audit write that fails must not roll back the action, and an
 * action that fails must still leave the attempt on record. 0007 makes the
 * table append-only, so there is no update path to offer.
 */
export async function appendAudit(
  db: AgencyDb,
  entry: {
    readonly orgId: string
    /** A users.id, or the literal 'agent'. */
    readonly actor: string
    readonly action: string
    readonly subjectType?: string | null
    readonly subjectId?: string | null
    readonly detail?: Record<string, unknown>
  },
): Promise<void> {
  await db.insert(schema.auditLog).values({
    orgId: entry.orgId,
    actor: entry.actor,
    action: entry.action,
    subjectType: entry.subjectType ?? null,
    subjectId: entry.subjectId ?? null,
    detail: entry.detail ?? {},
  })
}
