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
  appendAudit, appendChatMessage, clearInterruptedTurns, schema,
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
