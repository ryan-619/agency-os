/**
 * Who is asking, as the worker decides it: `resolvePrincipal`.
 *
 * The web app names a user in the turn request; the worker checks the
 * conversation belongs to them and reads their role from the row. Revoking
 * access keeps that row (§2.4), so the join alone would still find them —
 * these pin that a revoked person cannot start a turn, and that restoring
 * them undoes it without anything else changing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createChatSession, schema, usersRestore, usersRevoke, type AgencyDb } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { resolvePrincipal } from '../src/runtime/session.js'

describe('resolvePrincipal', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let memberId: string
  let threadId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [owner] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    ownerId = owner!.id
    const [member] = await db
      .insert(schema.users)
      .values({ orgId, email: 'member@agency.test', role: 'member' })
      .returning({ id: schema.users.id })
    memberId = member!.id
    threadId = (await createChatSession(db, { orgId, userId: memberId })).id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('resolves a live member to their org and role', async () => {
    const who = await resolvePrincipal(db, threadId, memberId)
    expect(who).toEqual({
      orgId,
      orgName: 'Agency',
      sdkSessionId: null,
      principal: { id: memberId, orgId, role: 'member' },
    })
  })

  it('resolves a revoked member to nobody, on their own conversation', async () => {
    const r = await usersRevoke(db, { orgId, userId: memberId, actor: ownerId, actorUserId: ownerId })
    expect(r.ok).toBe(true)
    expect(await resolvePrincipal(db, threadId, memberId)).toBeNull()
  })

  /** The stamp is what the worker reads — not the session rows revoking deletes. */
  it('refuses on the column alone, whoever wrote it', async () => {
    await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, memberId))
    expect(await resolvePrincipal(db, threadId, memberId)).toBeNull()
  })

  it('resolves them again once restored, with the role they had', async () => {
    await usersRevoke(db, { orgId, userId: memberId, actor: ownerId, actorUserId: ownerId })
    await usersRestore(db, { orgId, userId: memberId, actor: ownerId })
    const who = await resolvePrincipal(db, threadId, memberId)
    expect(who?.principal).toEqual({ id: memberId, orgId, role: 'member' })
  })

  it('still refuses a conversation that belongs to somebody else', async () => {
    expect(await resolvePrincipal(db, threadId, ownerId)).toBeNull()
  })
})
