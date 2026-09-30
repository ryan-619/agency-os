/**
 * A person's chat threads, for the web — listing, switching, renaming and
 * archiving them. No worker is needed for any of it, because a thread is a
 * row: the worker is what STARTS a turn, and none of this starts one.
 *
 * Every function here takes the user as well as the org, and puts both in the
 * WHERE. `readChatSession` in `chat.ts` is org-scoped, which is right for the
 * worker (it re-checks the owner itself) and wrong for a page: a thread is a
 * person's own prompts (§2.3), and a teammate in the same org guessing — or
 * being sent — a thread's URL must get the same answer as a stranger. So the
 * boundary is in the query, not in a comparison the page might forget.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import type { ChatSessionRow } from './chat.js'

/**
 * A uuid, checked before it reaches a `uuid` column. The id arrives from a URL
 * segment, and Postgres answers a malformed one with a cast error (22P02) — a
 * 500 for what is only a thread that does not exist.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Long enough for any name a person gives a conversation; the input says so too. */
export const CHAT_TITLE_MAX = 120

/** The owner's predicate: this org, this person, this thread. */
function own(orgId: string, userId: string, id: string) {
  return and(
    eq(schema.chatSessions.orgId, orgId),
    eq(schema.chatSessions.userId, userId),
    eq(schema.chatSessions.id, id),
  )
}

/**
 * One of the viewer's own threads, or null.
 *
 * Null for a teammate's thread, another org's, a malformed id and a missing
 * one alike — the page turns all four into the same 404, so nothing about a
 * thread that is not yours can be learned from its URL.
 *
 * An ARCHIVED thread is returned: archiving hides a thread from the list, it
 * does not take it away from the person who owns it.
 */
export async function chatReadOwnSession(
  db: AgencyDb,
  orgId: string,
  userId: string,
  id: string,
): Promise<ChatSessionRow | null> {
  if (!UUID.test(id) || !UUID.test(userId)) return null
  const rows = await db.select().from(schema.chatSessions).where(own(orgId, userId, id)).limit(1)
  return rows[0] ?? null
}

export type ChatRenameResult =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: 'not_found' | 'invalid'; readonly message: string }

/**
 * Rename a thread.
 *
 * The title is folded onto one line, because a list entry with a newline in it
 * is two list entries to the eye. A blank one is refused rather than stored as
 * NULL: NULL means "nothing said yet", and `ensureChatSessionTitle` would
 * quietly replace it with the next message — a rename that undid itself.
 *
 * Over the limit is refused, not cut. A title silently shortened is not the
 * name the person gave it, and the input carries the same limit, so only a
 * request that went around the form can reach this.
 */
export async function chatRenameSession(
  db: AgencyDb,
  args: { readonly orgId: string; readonly userId: string; readonly id: string; readonly title: string },
): Promise<ChatRenameResult> {
  const title = args.title.replace(/\s+/g, ' ').trim()
  if (!title) return { ok: false, reason: 'invalid', message: 'A thread needs a name.' }
  // Code points, not UTF-16 units: an emoji is one character to the person typing it.
  if ([...title].length > CHAT_TITLE_MAX) {
    return { ok: false, reason: 'invalid', message: `A thread name is at most ${CHAT_TITLE_MAX} characters.` }
  }
  if (!UUID.test(args.id) || !UUID.test(args.userId)) {
    return { ok: false, reason: 'not_found', message: 'No such thread.' }
  }

  const rows = await db
    .update(schema.chatSessions)
    .set({ title })
    .where(own(args.orgId, args.userId, args.id))
    .returning({ title: schema.chatSessions.title })
  if (rows.length === 0) return { ok: false, reason: 'not_found', message: 'No such thread.' }
  return { ok: true, title }
}

/**
 * Archive a thread: hidden from the list, not deleted.
 *
 * Refused while a turn is running, and the refusal is IN the WHERE rather than
 * read first and then written. A turn can hold an approval open for thirty
 * minutes, and a thread archived underneath it would leave the approval card
 * — the only place a person can decide it — on a thread nobody can find in
 * the list. Checking and then updating would let a turn start in between.
 *
 * Archiving an already-archived thread succeeds: the person's intent is met.
 */
export async function chatArchiveSession(
  db: AgencyDb,
  args: { readonly orgId: string; readonly userId: string; readonly id: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'running' }> {
  if (!UUID.test(args.id) || !UUID.test(args.userId)) return { ok: false, reason: 'not_found' }
  const rows = await db
    .update(schema.chatSessions)
    .set({ archived: true })
    .where(and(own(args.orgId, args.userId, args.id), isNull(schema.chatSessions.runningTurnId)))
    .returning({ id: schema.chatSessions.id })
  if (rows.length === 1) return { ok: true }

  // Nothing matched. The read below only NAMES the refusal — the decision was
  // already made by the statement above — so a turn that ended in between is
  // reported as running, and the person's retry is what archives it.
  const existing = await chatReadOwnSession(db, args.orgId, args.userId, args.id)
  return { ok: false, reason: existing ? 'running' : 'not_found' }
}

/**
 * Put an archived thread back in the list.
 *
 * "Hidden, not deleted" is only true if the hiding can be undone; without this
 * an archived thread is reachable by its URL and by nothing else. Returns
 * false when the thread is not the viewer's.
 */
export async function chatRestoreSession(
  db: AgencyDb,
  args: { readonly orgId: string; readonly userId: string; readonly id: string },
): Promise<boolean> {
  if (!UUID.test(args.id) || !UUID.test(args.userId)) return false
  const rows = await db
    .update(schema.chatSessions)
    .set({ archived: false })
    .where(own(args.orgId, args.userId, args.id))
    .returning({ id: schema.chatSessions.id })
  return rows.length === 1
}

/**
 * What each of a person's threads has cost, keyed by thread id.
 *
 * Summed by the database and returned as the database's own text. `cost_usd`
 * is `numeric`, which drizzle types as a STRING — adding two in JavaScript
 * concatenates, "0.01" and "0.02" becoming "0.010.02" — so no total is ever
 * formed here. `chat_messages` carries no user id, so the person's scope comes
 * from the join to `chat_sessions`; the org is checked on both sides.
 *
 * A thread with no priced message is absent from the map rather than present
 * at zero: "nothing spent" and "nothing recorded" read the same in the list,
 * and neither is worth a figure.
 */
export async function chatSessionCosts(
  db: AgencyDb,
  orgId: string,
  userId: string,
): Promise<Map<string, string>> {
  if (!UUID.test(userId)) return new Map()
  const rows = await db
    .select({
      sessionId: schema.chatMessages.sessionId,
      total: sql<string>`sum(${schema.chatMessages.costUsd})::text`,
    })
    .from(schema.chatMessages)
    .innerJoin(schema.chatSessions, eq(schema.chatSessions.id, schema.chatMessages.sessionId))
    .where(
      and(
        eq(schema.chatMessages.orgId, orgId),
        eq(schema.chatSessions.orgId, orgId),
        eq(schema.chatSessions.userId, userId),
        isNotNull(schema.chatMessages.costUsd),
      ),
    )
    .groupBy(schema.chatMessages.sessionId)
  return new Map(rows.map((r) => [r.sessionId, r.total]))
}
