/**
 * The team page's queries: grant, change a role, revoke WITHOUT deleting.
 *
 * Every rule that matters here is in a statement rather than in a check
 * before it — the last-owner rule and the self-revoke rule especially — so
 * these run against a real Postgres engine. And the one that is easiest to
 * get wrong quietly is the grant's refusal: `users_email_key` is global, so a
 * sentence that depends on WHICH org holds an address is a roster oracle
 * (§2.3). That test asserts the sentence and that nothing was written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import {
  USERS_GRANT_REFUSED, schema, usersGrant, usersList, usersRestore, usersRevoke, usersSetRole,
  type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const DAY = 86_400_000

describe('users (the team page)', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let ownerId: string

  const addUser = async (email: string, role: 'owner' | 'member', org = orgId): Promise<string> => {
    const [row] = await db
      .insert(schema.users)
      .values({ orgId: org, email, role })
      .returning({ id: schema.users.id })
    return row!.id
  }

  const addSession = async (userId: string, token: string, expires: Date): Promise<void> => {
    await db.insert(schema.sessions).values({ sessionToken: token, userId, expires })
  }

  const auditFor = (subjectId: string) =>
    db
      .select({
        action: schema.auditLog.action, actor: schema.auditLog.actor, detail: schema.auditLog.detail,
      })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.subjectId, subjectId)))

  const readUser = async (id: string) => {
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, id))
    return rows[0]
  }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Elsewhere' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    ownerId = await addUser('owner@agency.test', 'owner')
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------
  describe('usersList', () => {
    it('lists one org only: live owners, then live members, then the revoked', async () => {
      const zed = await addUser('zed@agency.test', 'member')
      await addUser('amy@agency.test', 'member')
      await addUser('second@agency.test', 'owner')
      await addUser('stranger@elsewhere.test', 'owner', otherOrgId)
      await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, zed))

      const list = await usersList(db, orgId)
      expect(list.map((m) => m.email)).toEqual([
        'owner@agency.test', 'second@agency.test', 'amy@agency.test', 'zed@agency.test',
      ])
      expect(list.at(-1)!.revokedAt).toBeInstanceOf(Date)
      expect(list.some((m) => m.email.includes('elsewhere'))).toBe(false)
    })

    /**
     * `email_verified` is the last completed magic link, NULL is "never", and
     * a live session is one whose `expires` is still ahead — an expired row
     * that nobody presented again is not a browser that can use the app.
     */
    it('reads the last sign-in from email_verified and counts only live sessions', async () => {
      const signedIn = new Date('2026-09-01T09:00:00Z')
      await db.update(schema.users).set({ emailVerified: signedIn }).where(eq(schema.users.id, ownerId))
      await addSession(ownerId, 'live-1', new Date(Date.now() + DAY))
      await addSession(ownerId, 'live-2', new Date(Date.now() + 2 * DAY))
      await addSession(ownerId, 'dead-1', new Date(Date.now() - DAY))
      const never = await addUser('never@agency.test', 'member')

      const list = await usersList(db, orgId)
      const owner = list.find((m) => m.id === ownerId)!
      expect(owner.lastSignInAt?.toISOString()).toBe(signedIn.toISOString())
      expect(owner.liveSessions).toBe(2)
      expect(owner.createdAt).toBeInstanceOf(Date)

      const fresh = list.find((m) => m.id === never)!
      expect(fresh.lastSignInAt).toBeNull()
      expect(fresh.liveSessions).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Grant
  // -------------------------------------------------------------------------
  describe('usersGrant', () => {
    it('folds the address the way sign-in looks it up, and audits the role only', async () => {
      const r = await usersGrant(db, {
        orgId, email: '  Priya@Agency.COM ', name: ' Priya ', role: 'member', actor: ownerId,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.user.email).toBe('priya@agency.com')
      expect(r.user.name).toBe('Priya')
      expect(r.user.role).toBe('member')
      expect(r.user.revokedAt).toBeNull()

      const audit = await auditFor(r.user.id)
      expect(audit).toEqual([{ action: 'user.granted', actor: ownerId, detail: { role: 'member' } }])
      // IDs and roles, never the address (§2.3).
      expect(JSON.stringify(audit)).not.toContain('@')
    })

    it('refuses an address it cannot read, and writes nothing', async () => {
      const r = await usersGrant(db, { orgId, email: 'not-an-email', role: 'member', actor: ownerId })
      expect(r).toMatchObject({ ok: false, reason: 'refused' })
      expect(await usersList(db, orgId)).toHaveLength(1)
    })

    it('says "already has access as <role>" for this org’s own roster', async () => {
      const r = await usersGrant(db, { orgId, email: 'OWNER@agency.test', role: 'member', actor: ownerId })
      expect(r).toEqual({
        ok: false, reason: 'already_member', message: 'That address already has access as owner.',
      })
    })

    it('points a revoked teammate at Restore rather than adding them twice', async () => {
      const gone = await addUser('gone@agency.test', 'member')
      await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, gone))
      const r = await usersGrant(db, { orgId, email: 'gone@agency.test', role: 'member', actor: ownerId })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toBe('already_member')
      expect(r.message).toMatch(/revoked/i)
      expect(r.message).toMatch(/restore/i)
    })

    /**
     * The roster oracle. `users_email_key` is global, so this address's row
     * in ANOTHER org makes the insert fail with 23505. What comes back must be
     * the one sentence every unexplained refusal gets, and must not mention
     * that the address exists, let alone where.
     */
    it('answers another org’s address with the one generic sentence and writes nothing', async () => {
      await addUser('taken@elsewhere.test', 'owner', otherOrgId)
      const before = await db.select().from(schema.auditLog)

      const r = await usersGrant(db, { orgId, email: 'Taken@Elsewhere.test', role: 'member', actor: ownerId })
      expect(r).toEqual({ ok: false, reason: 'refused', message: USERS_GRANT_REFUSED })
      expect(USERS_GRANT_REFUSED).toBe('That address cannot be added here.')
      expect(r.ok ? '' : r.message).not.toMatch(/exist|another|organi[sz]ation|taken|already/i)

      expect((await usersList(db, orgId)).map((m) => m.email)).toEqual(['owner@agency.test'])
      expect(await db.select().from(schema.auditLog)).toHaveLength(before.length)
    })
  })

  // -------------------------------------------------------------------------
  // Role
  // -------------------------------------------------------------------------
  describe('usersSetRole', () => {
    it('promotes a member and audits from → to', async () => {
      const m = await addUser('m@agency.test', 'member')
      expect(await usersSetRole(db, { orgId, userId: m, role: 'owner', actor: ownerId })).toEqual({ ok: true })
      expect((await readUser(m))!.role).toBe('owner')
      expect(await auditFor(m)).toEqual([
        { action: 'user.role_changed', actor: ownerId, detail: { from: 'member', to: 'owner' } },
      ])
    })

    it('refuses to demote the last owner', async () => {
      const r = await usersSetRole(db, { orgId, userId: ownerId, role: 'member', actor: ownerId })
      expect(r).toEqual({ ok: false, reason: 'last_owner' })
      expect((await readUser(ownerId))!.role).toBe('owner')
      expect(await auditFor(ownerId)).toEqual([])
    })

    it('demotes an owner when another live owner remains', async () => {
      await addUser('second@agency.test', 'owner')
      expect(await usersSetRole(db, { orgId, userId: ownerId, role: 'member', actor: ownerId })).toEqual({ ok: true })
      expect((await readUser(ownerId))!.role).toBe('member')
    })

    /** A revoked owner cannot sign in, so they cannot be the org's owner. */
    it('does not count a revoked owner as the other owner', async () => {
      const revoked = await addUser('revoked@agency.test', 'owner')
      await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, revoked))
      const r = await usersSetRole(db, { orgId, userId: ownerId, role: 'member', actor: ownerId })
      expect(r).toEqual({ ok: false, reason: 'last_owner' })
    })

    it('treats the same role again as done, and writes nothing', async () => {
      const m = await addUser('m@agency.test', 'member')
      expect(await usersSetRole(db, { orgId, userId: m, role: 'member', actor: ownerId })).toEqual({ ok: true })
      expect(await auditFor(m)).toEqual([])
    })

    it('cannot reach another org’s user', async () => {
      const stranger = await addUser('owner@elsewhere.test', 'member', otherOrgId)
      const r = await usersSetRole(db, { orgId, userId: stranger, role: 'owner', actor: ownerId })
      expect(r).toEqual({ ok: false, reason: 'not_found' })
      expect((await readUser(stranger))!.role).toBe('member')
    })
  })

  // -------------------------------------------------------------------------
  // Revoke and restore
  // -------------------------------------------------------------------------
  describe('usersRevoke', () => {
    it('refuses a person revoking themselves, even with another owner to spare', async () => {
      await addUser('second@agency.test', 'owner')
      const r = await usersRevoke(db, { orgId, userId: ownerId, actor: ownerId, actorUserId: ownerId })
      expect(r).toEqual({ ok: false, reason: 'self' })
      expect((await readUser(ownerId))!.revokedAt).toBeNull()
    })

    it('refuses to revoke the last owner', async () => {
      // A member cannot reach this through the route (users:write is owner
      // only); the query refuses it anyway, because the rule is the org's.
      const m = await addUser('m@agency.test', 'member')
      const r = await usersRevoke(db, { orgId, userId: ownerId, actor: m, actorUserId: m })
      expect(r).toEqual({ ok: false, reason: 'last_owner' })
      expect((await readUser(ownerId))!.revokedAt).toBeNull()
    })

    it('revokes one of two owners, and then the survivor is the last', async () => {
      const second = await addUser('second@agency.test', 'owner')
      const m = await addUser('m@agency.test', 'member')
      expect(await usersRevoke(db, { orgId, userId: second, actor: ownerId, actorUserId: ownerId }))
        .toEqual({ ok: true, sessionsEnded: 0 })
      // The revoked owner is still an owner on paper, and does not count.
      expect((await readUser(second))!.role).toBe('owner')
      const r = await usersRevoke(db, { orgId, userId: ownerId, actor: m, actorUserId: m })
      expect(r).toEqual({ ok: false, reason: 'last_owner' })
    })

    /**
     * §2.4: every decision stays attributable. The row stays, so the RESTRICT
     * parents are never tested; the sessions go, so no browser carries the
     * person for the thirty days a session lives.
     */
    it('ends every session, keeps the row and every decision that names it', async () => {
      const m = await addUser('m@agency.test', 'member')
      await addSession(m, 'm-laptop', new Date(Date.now() + DAY))
      await addSession(m, 'm-phone', new Date(Date.now() + DAY))
      await addSession(ownerId, 'owner-laptop', new Date(Date.now() + DAY))

      await test.pg.query(
        `INSERT INTO approvals (org_id, requested_by, tool_name, risk, status, decided_by, decided_at, expires_at)
         VALUES ($1, 'human', 'send_email', 'high', 'approved', $2, now(), now() + interval '1 hour')`,
        [orgId, m],
      )
      const [company] = await db
        .insert(schema.companies)
        .values({ orgId, domain: 'rentman.io' })
        .returning({ id: schema.companies.id })
      await test.pg.query(
        `INSERT INTO touches (org_id, company_id, channel, direction, status, approved_by, approved_at)
         VALUES ($1, $2, 'email', 'out', 'approved', $3, now())`,
        [orgId, company!.id, m],
      )

      const at = new Date('2026-09-30T12:00:00Z')
      const r = await usersRevoke(db, { orgId, userId: m, actor: ownerId, actorUserId: ownerId, now: at })
      expect(r).toEqual({ ok: true, sessionsEnded: 2 })

      const row = await readUser(m)
      expect(row!.revokedAt?.toISOString()).toBe(at.toISOString())
      expect(row!.role).toBe('member')

      const sessions = await db.select({ userId: schema.sessions.userId }).from(schema.sessions)
      expect(sessions).toEqual([{ userId: ownerId }])

      const approvals = await test.pg.query(`SELECT 1 FROM approvals WHERE decided_by = $1`, [m])
      expect(approvals.rows).toHaveLength(1)
      const touches = await test.pg.query(`SELECT 1 FROM touches WHERE approved_by = $1`, [m])
      expect(touches.rows).toHaveLength(1)

      const audit = await auditFor(m)
      expect(audit).toEqual([
        { action: 'user.revoked', actor: ownerId, detail: { role: 'member', sessionsEnded: 2 } },
      ])
      expect(JSON.stringify(audit)).not.toContain('@')

      const listed = (await usersList(db, orgId)).find((x) => x.id === m)!
      expect(listed.revokedAt?.toISOString()).toBe(at.toISOString())
      expect(listed.liveSessions).toBe(0)
    })

    it('leaves an already-revoked person as they are', async () => {
      const m = await addUser('m@agency.test', 'member')
      await usersRevoke(db, { orgId, userId: m, actor: ownerId, actorUserId: ownerId })
      expect(await usersRevoke(db, { orgId, userId: m, actor: ownerId, actorUserId: ownerId }))
        .toEqual({ ok: true, sessionsEnded: 0 })
      expect((await auditFor(m)).map((a) => a.action)).toEqual(['user.revoked'])
    })

    it('cannot reach another org’s user, and writes nothing', async () => {
      const stranger = await addUser('m@elsewhere.test', 'member', otherOrgId)
      await addSession(stranger, 'stranger-laptop', new Date(Date.now() + DAY))
      const r = await usersRevoke(db, { orgId, userId: stranger, actor: ownerId, actorUserId: ownerId })
      expect(r).toEqual({ ok: false, reason: 'not_found' })
      expect((await readUser(stranger))!.revokedAt).toBeNull()
      expect(await db.select().from(schema.sessions)).toHaveLength(1)
    })
  })

  describe('usersRestore', () => {
    it('clears the revocation, keeps the role, and audits it', async () => {
      const second = await addUser('second@agency.test', 'owner')
      await usersRevoke(db, { orgId, userId: second, actor: ownerId, actorUserId: ownerId })

      expect(await usersRestore(db, { orgId, userId: second, actor: ownerId })).toEqual({ ok: true })
      const row = await readUser(second)
      expect(row!.revokedAt).toBeNull()
      expect(row!.role).toBe('owner')
      expect((await auditFor(second)).map((a) => a.action)).toEqual(['user.revoked', 'user.restored'])

      // A restored owner counts again: the first owner may now be demoted.
      expect(await usersSetRole(db, { orgId, userId: ownerId, role: 'member', actor: second })).toEqual({ ok: true })
    })

    it('treats restoring somebody who is not revoked as done, and writes nothing', async () => {
      const m = await addUser('m@agency.test', 'member')
      expect(await usersRestore(db, { orgId, userId: m, actor: ownerId })).toEqual({ ok: true })
      expect(await auditFor(m)).toEqual([])
    })

    it('cannot reach another org’s user', async () => {
      const stranger = await addUser('m@elsewhere.test', 'member', otherOrgId)
      await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, stranger))
      expect(await usersRestore(db, { orgId, userId: stranger, actor: ownerId })).toEqual({ ok: false, reason: 'not_found' })
      expect((await readUser(stranger))!.revokedAt).toBeInstanceOf(Date)
    })
  })
})
