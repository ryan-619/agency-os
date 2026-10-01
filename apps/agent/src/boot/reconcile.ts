/**
 * What the last worker left behind.
 *
 * A worker that is killed mid-turn — a redeploy, an OOM, a SIGKILL — leaves
 * two kinds of row that nothing else will ever resolve:
 *
 *  1. A conversation marked as having a turn in flight. The process that owed
 *     it an answer is gone, so a browser reattaching to that thread shows a
 *     spinner with no end. This is the worst failure mode in the phase,
 *     because it is indistinguishable from the model still thinking.
 *
 *  2. An approval still pending. The `query()` call that would have consumed
 *     the decision does not exist any more, so the card is a trap: a person
 *     reads it, clicks Approve, and believes something happened. Nothing does.
 *
 * Both are cleared here, before the HTTP server accepts a single turn, and
 * both leave a trace — a `system` message in the transcript and an audit row —
 * because the useful outcome of a crash is a sentence someone can read, not a
 * quietly tidied database.
 *
 * Both are scoped by `bootAt`: a turn that began, or an approval that was
 * raised, AFTER this worker started belongs to a turn this worker or another
 * live one is serving. Only rows that predate the boot can have been orphaned
 * by the process that is gone.
 *
 * That scoping is what makes this safe, and the single-worker advisory lock is
 * a second layer rather than the first — because the lock cannot be verified
 * everywhere. Two connections through the PGlite socket bridge used for local
 * development BOTH acquire the same advisory lock: the bridge multiplexes them
 * onto one backend session, and Postgres lets a session re-take a lock it
 * already holds. Proved with two pg.Clients, and it is the same class of
 * limitation as the bridge silently dropping NOTIFY. On a real Postgres the
 * lock excludes a second worker; on a developer's machine it does not, and the
 * predicate above is what stops the second boot cancelling the first worker's
 * live turns.
 */
import { and, eq, lt, sql } from 'drizzle-orm'
import {
  appendAudit, appendChatMessage, clearInterruptedTurns, repauseForUnansweredReply, schema,
  type AgencyDb, type InterruptedTurn,
} from '@agency/db'
import type { Logger } from '../logger.js'

export interface ReconcileReport {
  readonly interruptedTurns: readonly InterruptedTurn[]
  readonly orphanedApprovals: number
  readonly prunedSignInLinks: number
}

export async function reconcileAfterRestart(
  db: AgencyDb,
  bootAt: Date,
  log: Logger,
): Promise<ReconcileReport> {
  // --- turns nobody is going to finish ---------------------------------------
  const interrupted = await clearInterruptedTurns(db, bootAt)
  for (const turn of interrupted) {
    try {
      await appendChatMessage(db, {
        orgId: turn.orgId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        seq: 9999,
        role: 'system',
        content: {
          kind: 'worker_restart',
          turnId: turn.turnId,
          startedAt: turn.startedAt ? turn.startedAt.toISOString() : null,
        },
      })
      await appendAudit(db, {
        orgId: turn.orgId,
        actor: 'agent',
        action: 'turn.interrupted_by_worker_restart',
        subjectType: 'chat_session',
        subjectId: turn.sessionId,
        detail: { turnId: turn.turnId },
      })
    } catch (err) {
      // The marker is already cleared, which is the part that unblocks the
      // conversation. Failing to write the explanation must not stop the
      // worker from starting.
      log.error('could not record an interrupted turn', {
        sessionId: turn.sessionId,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }

  // --- approvals nobody is waiting on ---------------------------------------
  //
  // Only rows the AGENT raised, and only ones older than this boot: a pending
  // approval created after we started belongs to a turn this process is
  // serving. Expiry records no decider, because a lapse is not an answer —
  // `approvals_expired_has_no_decider` enforces that.
  const orphaned = await db
    .update(schema.approvals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(schema.approvals.status, 'pending'),
        eq(schema.approvals.requestedBy, 'agent'),
        lt(schema.approvals.createdAt, bootAt),
      ),
    )
    .returning({
      id: schema.approvals.id,
      orgId: schema.approvals.orgId,
      toolName: schema.approvals.toolName,
      chatSessionId: schema.approvals.chatSessionId,
      turnId: schema.approvals.turnId,
    })

  for (const row of orphaned) {
    try {
      await appendAudit(db, {
        orgId: row.orgId,
        actor: 'agent',
        action: 'approval.orphaned_by_worker_restart',
        subjectType: 'approval',
        subjectId: row.id,
        detail: { toolName: row.toolName },
      })
      if (row.chatSessionId && row.turnId) {
        await appendChatMessage(db, {
          orgId: row.orgId,
          sessionId: row.chatSessionId,
          turnId: row.turnId,
          seq: 9999,
          role: 'system',
          content: { kind: 'approval_orphaned', approvalId: row.id, toolName: row.toolName },
        })
      }
    } catch (err) {
      log.error('could not record an orphaned approval', {
        approvalId: row.id,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }

  // --- a debt the repo already wrote down -----------------------------------
  //
  // CLAUDE.md records that an anonymous caller can create verification_token
  // rows for addresses that are not team members — single-use, 15-minute,
  // granting nothing, but nothing prunes them — and names this worker as where
  // the sweep belongs. It is three lines and it runs on a tick that already
  // exists.
  //
  // Reported as `prunedSignInLinks`, not `...Tokens`: redact() matches on key
  // NAMES and blanks anything matching /token/i, so a COUNT called
  // prunedVerificationTokens logs as "[redacted]". Harmless but useless, and
  // the fix belongs at the call site — redact() is deliberately blunt.
  let prunedSignInLinks = 0
  try {
    const pruned = await db
      .delete(schema.verificationTokens)
      .where(lt(schema.verificationTokens.expires, sql`now()`))
      .returning({ identifier: schema.verificationTokens.identifier })
    prunedSignInLinks = pruned.length
  } catch (err) {
    log.warn('could not prune expired verification tokens', {
      error: err instanceof Error ? err.name : 'UnknownError',
    })
  }

  const report: ReconcileReport = {
    interruptedTurns: interrupted,
    orphanedApprovals: orphaned.length,
    prunedSignInLinks,
  }

  if (interrupted.length > 0 || orphaned.length > 0) {
    log.warn('recovered state from an interrupted worker', {
      interruptedTurns: interrupted.length,
      orphanedApprovals: orphaned.length,
    })
  } else {
    log.info('clean start; nothing to reconcile', { prunedSignInLinks })
  }
  return report
}

/**
 * The periodic sweep.
 *
 * The waiter expires the row it is itself waiting on, so this is for the rows
 * nobody is waiting on: a turn that timed out, a worker that died between
 * boots, a browser that closed. Without it those sit on the approvals page
 * looking actionable until someone clicks a button that cannot do anything.
 */
export async function sweepExpired(db: AgencyDb, log: Logger): Promise<number> {
  try {
    const expired = await db
      .update(schema.approvals)
      .set({ status: 'expired' })
      .where(and(eq(schema.approvals.status, 'pending'), lt(schema.approvals.expiresAt, sql`now()`)))
      .returning({ id: schema.approvals.id })
    if (expired.length > 0) log.info('expired lapsed approvals', { count: expired.length })
    return expired.length
  } catch (err) {
    log.warn('approval sweep failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return 0
  }
}

/**
 * A message the last worker claimed and never finished (Phase 4).
 *
 * `sending` is the sender tick's claim on a row. A worker that died between
 * the claim and the provider's answer leaves that row claimed forever, and
 * nobody can tell whether the mail went. So it is marked `failed`, with a
 * reason a person can read and act on — the SAFE direction. The alternative,
 * putting it back to `approved`, is guessing that the provider was not
 * reached, and being wrong means the recipient gets it twice.
 *
 * Scoped by boot time like everything else here: only a claim older than this
 * process can be one this process did not make.
 *
 * An ANSWER to a reply settled here also puts the reply's own pause back
 * (`repauseForUnansweredReply`, review round 4), in the same transaction:
 * the inbox resumed the person when the answer was drafted, and an answer
 * that "may or may not have gone" must not leave them live in every campaign
 * with their reply possibly unanswered — the conservative direction, under
 * the helper's own guard (this answer resumed them, nobody resumed them
 * since, no other answer of theirs is live).
 */
export async function recoverStuckSends(db: AgencyDb, bootAt: Date, log: Logger): Promise<number> {
  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as AgencyDb
      const stuck = await recoverStuckRows(tx, bootAt)
      const now = new Date()
      for (const row of stuck) {
        if (!row.answersTouchId) continue
        await repauseForUnansweredReply(tx, {
          orgId: row.orgId,
          answer: { id: row.id, answersTouchId: row.answersTouchId },
          actor: 'system',
          because: 'failed',
          now,
        })
      }
      if (stuck.length > 0) log.warn('marked messages the last worker left mid-send as failed', { count: stuck.length })
      return stuck.length
    })
  } catch (err) {
    log.warn('could not recover stuck sends', { error: err instanceof Error ? err.name : 'UnknownError' })
    return 0
  }
}

/**
 * What a person reads on a row the last worker left mid-send, by the row's
 * OWN channel (review round 5). One sentence used to serve every channel —
 * "check the mailbox, then re-approve to send it again" — and since 0019 the
 * worker claims SMS rows too: the place a text's fate is recorded is the
 * DoveSoft console, not a mailbox. And nothing re-approves a `failed` row
 * (`approveDraft` takes only `awaiting_approval`), so the only way to send it
 * "again" is a new draft — a second text or a second mail to somebody who may
 * already have the first. Each sentence names where to look BEFORE that.
 */
export const STUCK_SEND_ERRORS = {
  sms:
    'The worker restarted while this text was being sent. It may or may not have gone; check the DoveSoft console before drafting it again.',
  email:
    'The worker restarted while this was being sent. It may or may not have gone; check the mailbox before drafting it again.',
  // A LinkedIn row is claimed by a person's Start on /tasks, not by the
  // worker, and its words reach the screen only in Start's success response,
  // written after the row says `sent` — so one still `sending` was never
  // shown here (`LINKEDIN_STEP_STUCK_ERROR`'s reading).
  linkedin:
    'Found when the worker restarted: the hand-over of this LinkedIn step never finished, so the message was never shown to anybody here. Check the LinkedIn conversation in case it went some other way before drafting it again.',
  other:
    'The worker restarted while this was being sent. It may or may not have gone; check with the provider before drafting it again.',
} as const

async function recoverStuckRows(
  db: AgencyDb,
  bootAt: Date,
): Promise<{ id: string; orgId: string; answersTouchId: string | null }[]> {
  return db
    .update(schema.touches)
    .set({
      status: 'failed',
      error: sql`CASE ${schema.touches.channel}
        WHEN 'sms' THEN ${STUCK_SEND_ERRORS.sms}
        WHEN 'email' THEN ${STUCK_SEND_ERRORS.email}
        WHEN 'linkedin' THEN ${STUCK_SEND_ERRORS.linkedin}
        ELSE ${STUCK_SEND_ERRORS.other} END`,
    })
    // `updated_at` is set by a trigger on UPDATE and is NULL until then; the
    // claim itself is an update, so it is normally set — but a row that
    // was inserted as `sending` (nothing does, today) would be invisible
    // to a bare comparison. Coalesce, so "older than the boot" is answered
    // for every row.
    .where(
      and(
        eq(schema.touches.status, 'sending'),
        lt(sql`coalesce(${schema.touches.updatedAt}, ${schema.touches.createdAt})`, bootAt),
      ),
    )
    .returning({ id: schema.touches.id, orgId: schema.touches.orgId, answersTouchId: schema.touches.answersTouchId })
}
