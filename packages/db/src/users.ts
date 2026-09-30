/**
 * The /settings/team queries: grant access, change a role, revoke WITHOUT
 * deleting (0018's `users.revoked_at`) so every row that names the person
 * keeps its name.
 *
 * 0004 said it first, in the comment on `approvals.decided_by`: "offboarding
 * is a role change, not a row deletion". `approvals.decided_by`,
 * `touches.approved_by` and `touches.handled_by` are RESTRICT, `audit_log.actor`
 * is text nobody can resolve once the row is gone, and `chat_messages.cost_usd`
 * is the per-person spend `tools/spend.sh` reports. So nothing here deletes a
 * user. A revoked person keeps every row, loses every live session, and is
 * refused by both legs of the magic-link flow and by the worker's
 * `resolvePrincipal` — each of which reads `revoked_at` for itself.
 *
 * Two rules are in the STATEMENT rather than in a check before it, because a
 * check before it is a race:
 *
 *   - the last owner cannot be demoted or revoked. A revoked owner does not
 *     count: `revoked_at IS NULL` is in the EXISTS, so revoking the last LIVE
 *     owner is refused even while a revoked one is on the books.
 *   - a person cannot revoke themselves. The page cannot lock its own viewer
 *     out mid-request, and the last-owner rule alone would allow it whenever
 *     there are two.
 *
 * The statement alone does NOT close the race between two owners removing
 * each other, and an earlier version of this comment said it did. Under READ
 * COMMITTED each UPDATE locks only its own target row, and each EXISTS reads
 * a snapshot in which the OTHER owner is still live — write skew: A revokes
 * B while B revokes A, both statements match, and the org has no owner. It
 * was reproduced on a real Postgres 16 with two sessions running exactly
 * that predicate. So every write that can take a live owner away — a revoke
 * and a demotion — runs in a transaction that first takes one advisory lock
 * per org (`lockOwners`). The second writer waits for the first to commit,
 * and its UPDATE then takes a fresh snapshot in which the first one's change
 * is visible, so the EXISTS answers the question it was written to ask.
 * Adding an owner (a grant, a promotion, a restore) can never leave the org
 * with none, and takes no lock.
 *
 * Zero rows back means the predicate refused, and the caller re-reads to say
 * WHICH clause did — the precedent is `decideApproval` and `advanceDeal`: one
 * statement arbitrates, the loser re-reads.
 *
 * `users_email_key` is GLOBAL, not per org (0001). That makes "does this
 * address exist" a question this module can only answer for the caller's own
 * roster: a 23505 from another org's row must come back as the ONE generic
 * sentence, or the grant form becomes the roster oracle `auth.ts` went to
 * some length to close (§2.3, CLAUDE.md §4 "Sign-in reveals nothing about who
 * has access").
 */
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import { normaliseEmail, type Role } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import type { User } from './schema.js'
import { appendAudit } from './approvals.js'
import { isUniqueViolation } from './pg-errors.js'

/**
 * One member as the team page shows them. What each field honestly means is
 * decided here rather than in the page, because it is the QUERY that knows:
 *
 *  - `createdAt` is "access granted". Never `updated_at`, which the
 *    `users_set_updated_at` trigger bumps on every magic-link sign-in
 *    (Auth.js re-stamps `email_verified` through `updateUser`) and which
 *    therefore means nothing a person would want to read.
 *  - `lastSignInAt` is `email_verified`. @auth/core@0.41.3 re-stamps it on
 *    EVERY completed magic link, not only the first, so it is the instant of
 *    the most recent sign-in — and it moves ONLY then. A person who signed in
 *    three weeks ago and has used the app every day since still reads three
 *    weeks ago; the live-session count is the honest companion figure.
 *  - `liveSessions` is the number of unexpired `sessions` rows: browsers that
 *    can use the app right now without a new link.
 */
export interface TeamMember {
  readonly id: string
  readonly email: string
  readonly name: string | null
  readonly role: Role
  readonly createdAt: Date
  readonly lastSignInAt: Date | null
  readonly liveSessions: number
  readonly revokedAt: Date | null
}

/** The one sentence every refusal the caller may not explain gets (§2.3). */
export const USERS_GRANT_REFUSED = 'That address cannot be added here.'

/**
 * "Some other owner of this org is still live." Correlated to the row being
 * updated, so it is evaluated by the same statement that writes — never by a
 * SELECT a moment earlier. Only sound after `lockOwners`: on its own it reads
 * a snapshot that a concurrent removal of the other owner is not yet in.
 */
const anotherLiveOwner = sql`EXISTS (
  SELECT 1 FROM ${schema.users} o
   WHERE o.org_id = ${schema.users.orgId}
     AND o.id <> ${schema.users.id}
     AND o.role = 'owner'
     AND o.revoked_at IS NULL)`

/**
 * Serialise, per org, every write that could take a live owner away (see the
 * module comment). Transaction-scoped, so it is released by COMMIT or
 * ROLLBACK and a crashed request cannot leave it held. The key is the org, not
 * the target row: the two writes that race are on DIFFERENT rows.
 *
 * PGlite runs one session, so the suite cannot interleave two; what it pins
 * is that both writers take this lock, inside their transaction, before the
 * UPDATE (`users.test.ts`, by tracing the statements and by reading this
 * file).
 */
async function lockOwners(tx: AgencyDb, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('users.owners'), hashtext(${orgId}))`)
}

/**
 * Every member of ONE org: the live ones first, owners before members, then
 * by address; the revoked ones after, in the same order. Never crosses orgs.
 * `verification_tokens` is deliberately not read — it holds rows for
 * strangers who typed their address at /signin, and listing those as
 * "pending" would turn a sign-in attempt by an outsider into a roster entry.
 */
export async function usersList(db: AgencyDb, orgId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      createdAt: schema.users.createdAt,
      lastSignInAt: schema.users.emailVerified,
      liveSessions: sql<number>`(
        SELECT count(*) FROM ${schema.sessions} s
         WHERE s.user_id = ${schema.users.id} AND s.expires > now())`.mapWith(Number),
      revokedAt: schema.users.revokedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.orgId, orgId))
    .orderBy(
      sql`${schema.users.revokedAt} IS NOT NULL`,
      sql`${schema.users.role} <> 'owner'`,
      asc(schema.users.email),
    )
  return rows.map((r) => ({ ...r, role: r.role as Role }))
}

/**
 * Grant access. There is no invitation mail — nothing is sent by this. The
 * person goes to /signin and asks for a link, and the row written here is
 * what lets `sendVerificationRequest` send one.
 *
 * The address is folded through `normaliseEmail`, the same fold the sign-in
 * lookup and the suppression list use; `users_email_is_normalised` would
 * refuse anything else, and an address stored un-folded is one Auth.js could
 * never find. `already_member` is the viewer's own roster and may say the
 * role. `refused` is everything else, in one sentence.
 */
export async function usersGrant(
  db: AgencyDb,
  input: {
    readonly orgId: string
    readonly email: string
    readonly name?: string | null
    readonly role: Role
    /** A users.id, for the audit row. */
    readonly actor: string
  },
): Promise<
  | { ok: true; user: User }
  | { ok: false; reason: 'already_member' | 'refused'; message: string }
> {
  const email = normaliseEmail(input.email)
  if (!email) {
    return { ok: false, reason: 'refused', message: `"${input.email}" could not be read as an email address.` }
  }

  const onRoster = await sameOrgMember(db, input.orgId, email)
  if (onRoster) return onRoster

  let user: User | undefined
  try {
    const rows = await db
      .insert(schema.users)
      .values({ orgId: input.orgId, email, name: input.name?.trim() || null, role: input.role })
      .returning()
    user = rows[0]
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Two owners adding the same person at once: the loser's 23505 is a
    // same-org row and gets the precise sentence. Anything else — the address
    // belongs to another organisation on this deployment — gets the generic
    // one, and this module does not look at whose it is.
    const raced = await sameOrgMember(db, input.orgId, email)
    if (raced) return raced
    return { ok: false, reason: 'refused', message: USERS_GRANT_REFUSED }
  }
  if (!user) throw new Error('users insert returned no row')

  await appendAudit(db, {
    orgId: input.orgId,
    actor: input.actor,
    action: 'user.granted',
    subjectType: 'user',
    subjectId: user.id,
    // The role and nothing else. The address is on the row; the audit log is
    // read more widely than the table (§2.3).
    detail: { role: input.role },
  })
  return { ok: true, user }
}

/** The address on THIS org's roster, phrased for the person who typed it. */
async function sameOrgMember(
  db: AgencyDb,
  orgId: string,
  email: string,
): Promise<{ ok: false; reason: 'already_member'; message: string } | null> {
  const rows = await db
    .select({ role: schema.users.role, revokedAt: schema.users.revokedAt })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), eq(schema.users.email, email)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  if (row.revokedAt) {
    return {
      ok: false,
      reason: 'already_member',
      message: 'That address is on this team already, with access revoked. Restore them rather than adding them again.',
    }
  }
  return { ok: false, reason: 'already_member', message: `That address already has access as ${row.role}.` }
}

/**
 * Change a role. One UPDATE whose predicate refuses demoting the last live
 * owner, after `lockOwners` (two owners demoting each other at once is the
 * same write skew as two revoking each other); promoting never needs the
 * guard. The same role again is a no-op that writes nothing and audits
 * nothing.
 *
 * A role change reaches the web on the next request (`auth.ts`'s session
 * callback re-reads `users.role` every time) and the worker on the next turn
 * (`resolvePrincipal` joins it per turn). Nobody has to sign out.
 */
export async function usersSetRole(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly userId: string
    readonly role: Role
    readonly actor: string
  },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'last_owner' }> {
  const current = await readMember(db, args.orgId, args.userId)
  if (!current) return { ok: false, reason: 'not_found' }
  if (current.role === args.role) return { ok: true }

  // Demoting a REVOKED owner takes no live owner away, so it needs no guard.
  const guard = args.role === 'owner'
    ? undefined
    : sql`(${schema.users.role} <> 'owner' OR ${schema.users.revokedAt} IS NOT NULL OR ${anotherLiveOwner})`
  const rows = await db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    await lockOwners(t, args.orgId)
    return t
      .update(schema.users)
      .set({ role: args.role })
      .where(and(eq(schema.users.orgId, args.orgId), eq(schema.users.id, args.userId), guard))
      .returning({ id: schema.users.id })
  })

  if (rows.length === 0) {
    // The row was there a moment ago. Either it is gone, or the guard refused.
    const again = await readMember(db, args.orgId, args.userId)
    return { ok: false, reason: again ? 'last_owner' : 'not_found' }
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'user.role_changed',
    subjectType: 'user',
    subjectId: args.userId,
    detail: { from: current.role, to: args.role },
  })
  return { ok: true }
}

/**
 * Revoke access: stamp `revoked_at`, end every live session, keep the row.
 *
 * Self and the last owner are refused IN the statement, which runs after
 * `lockOwners` (see the module comment). The session delete is in the same
 * transaction as the stamp, so there is no moment where the row says revoked
 * and a browser still holds a session that would carry it for thirty days —
 * Auth.js reads `sessions`, not `users.revoked_at`, on every request.
 *
 * An already-revoked person is left as they are and reported as done with no
 * sessions ended: the state asked for is the state they are in.
 */
export async function usersRevoke(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly userId: string
    /** A users.id, for the audit row. */
    readonly actor: string
    /** The person clicking. The statement refuses `userId === actorUserId`. */
    readonly actorUserId: string
    readonly now?: Date
  },
): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: 'not_found' | 'self' | 'last_owner' }> {
  const now = args.now ?? new Date()

  const outcome = await db.transaction(async (tx) => {
    await lockOwners(tx as unknown as AgencyDb, args.orgId)
    const rows = await tx
      .update(schema.users)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.users.orgId, args.orgId),
          eq(schema.users.id, args.userId),
          isNull(schema.users.revokedAt),
          ne(schema.users.id, args.actorUserId),
          sql`(${schema.users.role} <> 'owner' OR ${anotherLiveOwner})`,
        ),
      )
      .returning({ id: schema.users.id, role: schema.users.role })
    const revoked = rows[0]
    if (!revoked) return null

    // The count, never the tokens: a session token is a bearer credential and
    // does not belong in a return value any more than in a log line (§2.3).
    const ended = await tx
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, args.userId))
      .returning({ userId: schema.sessions.userId })
    return { role: revoked.role, sessionsEnded: ended.length }
  })

  if (!outcome) {
    const row = await readMember(db, args.orgId, args.userId)
    if (!row) return { ok: false, reason: 'not_found' }
    if (row.id === args.actorUserId) return { ok: false, reason: 'self' }
    if (row.revokedAt) return { ok: true, sessionsEnded: 0 }
    return { ok: false, reason: 'last_owner' }
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'user.revoked',
    subjectType: 'user',
    subjectId: args.userId,
    detail: { role: outcome.role, sessionsEnded: outcome.sessionsEnded },
  })
  return { ok: true, sessionsEnded: outcome.sessionsEnded }
}

/**
 * Restore a revoked person. Their role is whatever it was; a restored owner is
 * an owner again, which is why revoking was the reversible primitive and not
 * a delete. Restoring somebody who is not revoked changes nothing and audits
 * nothing.
 */
export async function usersRestore(
  db: AgencyDb,
  args: { readonly orgId: string; readonly userId: string; readonly actor: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const rows = await db
    .update(schema.users)
    .set({ revokedAt: null })
    .where(
      and(
        eq(schema.users.orgId, args.orgId),
        eq(schema.users.id, args.userId),
        sql`${schema.users.revokedAt} IS NOT NULL`,
      ),
    )
    .returning({ id: schema.users.id, role: schema.users.role })
  const restored = rows[0]
  if (!restored) {
    const row = await readMember(db, args.orgId, args.userId)
    return row ? { ok: true } : { ok: false, reason: 'not_found' }
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'user.restored',
    subjectType: 'user',
    subjectId: args.userId,
    detail: { role: restored.role },
  })
  return { ok: true }
}

/** One row of this org's roster, or null. A stranger's id is null too. */
async function readMember(
  db: AgencyDb,
  orgId: string,
  userId: string,
): Promise<{ id: string; role: string; revokedAt: Date | null } | null> {
  const rows = await db
    .select({ id: schema.users.id, role: schema.users.role, revokedAt: schema.users.revokedAt })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), eq(schema.users.id, userId)))
    .limit(1)
  return rows[0] ?? null
}
