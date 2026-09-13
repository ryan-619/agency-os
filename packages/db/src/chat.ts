/**
 * Chat sessions and the transcript beneath them (PROMPT.md §5.3, §8.1).
 *
 * HTTP is stateless and agent conversations are not, so two different notions
 * of "session" meet in this file. `chat_sessions` is OURS — a thread a person
 * sees in the sidebar. `sdk_session_id` is the SDK's, the handle passed back as
 * `resume` so the model keeps its context across requests. They are stored
 * together and they are not the same thing: a row can exist with no SDK
 * session yet (nobody has spoken), and an SDK transcript can vanish from disk
 * while our row survives.
 *
 * The recurring theme here is that a turn can be interrupted by something that
 * never gets to write a completion — a killed worker, a redeploy, a crash. The
 * schema carries a running-turn marker so that state is visible in the
 * database rather than only in the memory of a process that no longer exists.
 */
import { and, asc, desc, eq, isNotNull, lt, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type ChatSessionRow = typeof schema.chatSessions.$inferSelect
export type ChatMessageRow = typeof schema.chatMessages.$inferSelect
export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'

/**
 * Money, as a string.
 *
 * `chat_messages.cost_usd` is drizzle `numeric` with no mode, which is typed
 * STRING on both insert and select — so `a + b` on two of these silently
 * concatenates rather than adding. Every value crossing this boundary goes
 * through here, and every total is computed by the database.
 */
export function usd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '0.000000'
  return amount.toFixed(6)
}

export async function createChatSession(
  db: AgencyDb,
  args: { readonly orgId: string; readonly userId: string; readonly title?: string | null },
): Promise<ChatSessionRow> {
  const rows = await db
    .insert(schema.chatSessions)
    .values({ orgId: args.orgId, userId: args.userId, title: args.title ?? null })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('chat session insert returned no row')
  return row
}

export async function readChatSession(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<ChatSessionRow | null> {
  const rows = await db
    .select()
    .from(schema.chatSessions)
    .where(and(eq(schema.chatSessions.orgId, orgId), eq(schema.chatSessions.id, id)))
    .limit(1)
  return rows[0] ?? null
}

/** A person's threads, most recently active first. */
export async function listChatSessions(
  db: AgencyDb,
  orgId: string,
  userId: string,
  limit = 50,
): Promise<ChatSessionRow[]> {
  return db
    .select()
    .from(schema.chatSessions)
    .where(
      and(
        eq(schema.chatSessions.orgId, orgId),
        eq(schema.chatSessions.userId, userId),
        eq(schema.chatSessions.archived, false),
      ),
    )
    .orderBy(desc(schema.chatSessions.lastActiveAt))
    .limit(limit)
}

export async function chatMessages(
  db: AgencyDb,
  orgId: string,
  sessionId: string,
): Promise<ChatMessageRow[]> {
  return db
    .select()
    .from(schema.chatMessages)
    .where(and(eq(schema.chatMessages.orgId, orgId), eq(schema.chatMessages.sessionId, sessionId)))
    .orderBy(asc(schema.chatMessages.createdAt), asc(schema.chatMessages.seq))
}

export interface AppendMessage {
  readonly orgId: string
  readonly sessionId: string
  readonly turnId: string
  /** Position within the turn. `created_at` alone is not enough — several
   *  frames of one turn land inside the same millisecond. */
  readonly seq: number
  readonly role: ChatRole
  readonly content: Record<string, unknown>
  readonly toolName?: string | null
  /** Ties a tool call to its result, and makes a replayed frame idempotent. */
  readonly toolUseId?: string | null
  readonly tokensIn?: number | null
  readonly tokensOut?: number | null
  /** Already a string. Use `usd()`. */
  readonly costUsd?: string | null
}

/**
 * Append one frame of the transcript.
 *
 * Idempotent for the frames that can legitimately arrive twice. A tool call
 * and its result each get one row, keyed `(session_id, tool_use_id, role)`, so
 * an SDK redelivery or a replay after a reconnect updates the existing row
 * instead of appending a second copy. Frames with no `tool_use_id` — user
 * text, assistant text, system notices — are plain appends, because those are
 * genuinely new every time.
 */
export async function appendChatMessage(db: AgencyDb, msg: AppendMessage): Promise<ChatMessageRow> {
  const values = {
    orgId: msg.orgId,
    sessionId: msg.sessionId,
    turnId: msg.turnId,
    seq: msg.seq,
    role: msg.role,
    content: msg.content,
    toolName: msg.toolName ?? null,
    toolUseId: msg.toolUseId ?? null,
    tokensIn: msg.tokensIn ?? null,
    tokensOut: msg.tokensOut ?? null,
    costUsd: msg.costUsd ?? null,
  }

  const rows = msg.toolUseId
    ? await db
        .insert(schema.chatMessages)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.chatMessages.sessionId, schema.chatMessages.toolUseId, schema.chatMessages.role],
          // The index is PARTIAL (WHERE tool_use_id IS NOT NULL), and Postgres
          // will not use a partial index as a conflict arbiter unless the
          // statement repeats its predicate. Without this the insert fails
          // outright with "no unique or exclusion constraint matching" — so
          // every tool frame would error rather than deduplicate.
          targetWhere: isNotNull(schema.chatMessages.toolUseId),
          set: { content: values.content, toolName: values.toolName, seq: values.seq },
        })
        .returning()
    : await db.insert(schema.chatMessages).values(values).returning()

  const row = rows[0]
  if (!row) throw new Error('chat message insert returned no row')
  return row
}

/**
 * What this session has cost so far.
 *
 * Summed by the database rather than stored on `chat_sessions`. A stored total
 * that can disagree with the rows beneath it is the same class of bug 0006
 * closed for scores, and this is one indexed query.
 */
export async function sessionCostUsd(db: AgencyDb, orgId: string, sessionId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(sum(${schema.chatMessages.costUsd}), 0)::text` })
    .from(schema.chatMessages)
    .where(and(eq(schema.chatMessages.orgId, orgId), eq(schema.chatMessages.sessionId, sessionId)))
  return Number.parseFloat(rows[0]?.total ?? '0')
}

/** Record the SDK's session handle so the next turn can `resume` it (§5.3). */
export async function setSdkSessionId(
  db: AgencyDb,
  orgId: string,
  sessionId: string,
  sdkSessionId: string,
): Promise<void> {
  await db
    .update(schema.chatSessions)
    .set({ sdkSessionId, lastActiveAt: sql`now()` })
    .where(and(eq(schema.chatSessions.orgId, orgId), eq(schema.chatSessions.id, sessionId)))
}

/**
 * Claim a session for a turn.
 *
 * Conditional on no turn already running, so two browser tabs cannot start
 * concurrent turns on one thread — which would interleave two conversations
 * into one SDK transcript. Returns false if someone got there first.
 */
export async function markTurnRunning(
  db: AgencyDb,
  orgId: string,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.chatSessions)
    .set({ runningTurnId: turnId, runningSince: sql`now()`, lastActiveAt: sql`now()` })
    .where(
      and(
        eq(schema.chatSessions.orgId, orgId),
        eq(schema.chatSessions.id, sessionId),
        sql`${schema.chatSessions.runningTurnId} IS NULL`,
      ),
    )
    .returning({ id: schema.chatSessions.id })
  return rows.length === 1
}

export async function clearTurnRunning(
  db: AgencyDb,
  orgId: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await db
    .update(schema.chatSessions)
    .set({ runningTurnId: null, runningSince: null, lastActiveAt: sql`now()` })
    .where(
      and(
        eq(schema.chatSessions.orgId, orgId),
        eq(schema.chatSessions.id, sessionId),
        eq(schema.chatSessions.runningTurnId, turnId),
      ),
    )
}

export interface InterruptedTurn {
  readonly sessionId: string
  readonly orgId: string
  readonly turnId: string
  readonly startedAt: Date | null
}

/**
 * Find and clear every turn that was already running before `startedAt`.
 *
 * This is the single most important anti-hang measure in the phase. A browser
 * reattaching to a session whose turn died mid-flight otherwise shows a
 * spinner with no end — the process that owed it an answer is gone, and
 * nothing else knows the question was ever asked. Clearing the marker and
 * writing a `system` frame turns an invisible death into a sentence the person
 * can read and act on.
 *
 * `startedAt` is the caller's boot time, and it is what makes this safe rather
 * than merely careful. A turn that began AFTER this worker booted belongs to
 * this worker or to another live one; only a turn that predates the boot can
 * have been orphaned by the process that is gone. The approval sweep has
 * always been scoped this way; this is the same rule, applied consistently.
 *
 * That matters more than it looks, because the single-worker advisory lock
 * cannot be verified everywhere. On the PGlite socket bridge used for local
 * development, two connections both acquire the same advisory lock — the
 * bridge multiplexes them onto one backend session and Postgres lets a session
 * re-take its own lock. So on a developer's machine the lock does not actually
 * exclude a second worker, and without this predicate the second worker's boot
 * would cancel the first worker's live turns.
 */
export async function clearInterruptedTurns(
  db: AgencyDb,
  startedAt: Date,
): Promise<InterruptedTurn[]> {
  // Read BEFORE the update, not with RETURNING. Postgres returns the NEW row
  // from an UPDATE ... RETURNING, so asking for running_turn_id there hands
  // back the null we just wrote and the caller learns nothing about what was
  // interrupted. Two statements are safe here because this runs at boot under
  // the single-worker advisory lock, before the HTTP server accepts a turn.
  const orphaned = and(
    isNotNull(schema.chatSessions.runningTurnId),
    lt(schema.chatSessions.runningSince, startedAt),
  )

  const running = await db
    .select({
      sessionId: schema.chatSessions.id,
      orgId: schema.chatSessions.orgId,
      turnId: schema.chatSessions.runningTurnId,
      startedAt: schema.chatSessions.runningSince,
    })
    .from(schema.chatSessions)
    .where(orphaned)

  if (running.length === 0) return []

  await db.update(schema.chatSessions).set({ runningTurnId: null, runningSince: null }).where(orphaned)

  return running.flatMap((r) =>
    r.turnId ? [{ sessionId: r.sessionId, orgId: r.orgId, turnId: r.turnId, startedAt: r.startedAt }] : [],
  )
}

/**
 * The first line of a thread, used as its title.
 *
 * Deliberately not a model call: naming a conversation is not worth a second
 * `query()` and the money it costs, and the first sentence someone typed is
 * what they would have called it anyway.
 */
export function titleFromFirstMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= 60) return oneLine
  return `${oneLine.slice(0, 59).trimEnd()}…`
}

/** Set the title once, on the first thing a person says in a thread. */
export async function ensureChatSessionTitle(
  db: AgencyDb,
  orgId: string,
  sessionId: string,
  firstMessage: string,
): Promise<void> {
  await db
    .update(schema.chatSessions)
    .set({ title: titleFromFirstMessage(firstMessage) })
    .where(
      and(
        eq(schema.chatSessions.orgId, orgId),
        eq(schema.chatSessions.id, sessionId),
        sql`${schema.chatSessions.title} IS NULL`,
      ),
    )
}
