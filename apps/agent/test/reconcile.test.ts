/**
 * What a killed worker leaves behind, and what happens next time one starts.
 *
 * This is the recovery path, so the tests set up the exact wreckage a SIGKILL
 * produces — a conversation marked as running, an approval still pending —
 * and assert that a fresh boot turns both into something a person can read.
 * Against a real Postgres engine, because every assertion here is about rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  createChatSession, ensureApproval, markTurnRunning, readChatSession, schema,
  type AgencyDb,
} from '@agency/db'
import { freshDb, migrations, type TestDb } from '../../../packages/db/test/helpers.js'
import { migrateUp } from '../../../packages/db/src/migrator.js'
import { reconcileAfterRestart, sweepExpired } from '../src/boot/reconcile.js'
import { WORKER_LOCK_KEY } from '../src/boot/singleton.js'

const MINUTE = 60_000
const silent = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as unknown as Parameters<typeof reconcileAfterRestart>[2]

describe('recovering from an interrupted worker', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let seq = 0

  const turn = () => `55555555-5555-4555-8555-${String(++seq).padStart(12, '0')}`

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /**
   * The single most important thing this function does. Without it the
   * conversation stays marked as running forever, and a browser reattaching to
   * it spins on a process that no longer exists.
   */
  it('unblocks a conversation whose turn died, and says why in the transcript', async () => {
    const session = await createChatSession(db, { orgId, userId })
    const t = turn()
    await markTurnRunning(db, orgId, session.id, t)

    const report = await reconcileAfterRestart(db, new Date(Date.now() + 1000), silent)

    expect(report.interruptedTurns.map((i) => i.turnId)).toEqual([t])
    expect((await readChatSession(db, orgId, session.id))!.runningTurnId).toBeNull()

    const messages = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, session.id))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toMatchObject({ kind: 'worker_restart', turnId: t })

    // And the conversation is usable again rather than permanently claimed.
    expect(await markTurnRunning(db, orgId, session.id, turn())).toBe(true)
  })

  /**
   * A pending approval whose turn is gone is a trap: a person reads the card,
   * approves, and believes something happened. Nothing is waiting to consume
   * the decision.
   */
  it('expires an approval nobody is left waiting on, without inventing a decider', async () => {
    const session = await createChatSession(db, { orgId, userId })
    const raised = await ensureApproval(db, {
      orgId,
      chatSessionId: session.id,
      turnId: turn(),
      toolUseId: 'toolu_orphan',
      toolName: 'mcp__agency__queue_touch',
      payload: { channel: 'email' },
      payloadSha256: 'a'.repeat(64),
      risk: 'high',
      expiresAt: new Date(Date.now() + 30 * MINUTE),
    })

    // Boot AFTER the approval was created — the row predates this process.
    const report = await reconcileAfterRestart(db, new Date(Date.now() + 1000), silent)

    expect(report.orphanedApprovals).toBe(1)
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, raised.id))
    expect(row!.status).toBe('expired')
    // A lapse is not an answer, and must never read like one.
    expect(row!.decidedBy).toBeNull()
    expect(row!.decidedAt).toBeNull()
  })

  /**
   * The boot timestamp is the whole safety of the previous rule. An approval
   * raised after this worker started belongs to a turn it is serving right
   * now, and expiring it would cancel live work.
   */
  it('leaves alone an approval raised after this worker started', async () => {
    const session = await createChatSession(db, { orgId, userId })
    const bootAt = new Date(Date.now() - 60_000)
    const mine = await ensureApproval(db, {
      orgId,
      chatSessionId: session.id,
      turnId: turn(),
      toolUseId: 'toolu_live',
      toolName: 'mcp__agency__queue_touch',
      payload: {},
      payloadSha256: 'b'.repeat(64),
      risk: 'high',
      expiresAt: new Date(Date.now() + 30 * MINUTE),
    })

    const report = await reconcileAfterRestart(db, bootAt, silent)

    expect(report.orphanedApprovals).toBe(0)
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, mine.id))
    expect(row!.status).toBe('pending')
  })

  it('records every recovery in the audit log', async () => {
    const session = await createChatSession(db, { orgId, userId })
    await markTurnRunning(db, orgId, session.id, turn())
    await reconcileAfterRestart(db, new Date(Date.now() + 1000), silent)

    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId))
    expect(rows.map((r) => r.action)).toContain('turn.interrupted_by_worker_restart')
  })

  it('says nothing happened on a clean start', async () => {
    const report = await reconcileAfterRestart(db, new Date(), silent)
    expect(report.interruptedTurns).toEqual([])
    expect(report.orphanedApprovals).toBe(0)
  })

  /**
   * CLAUDE.md records this debt and names this worker as where the sweep
   * belongs: an anonymous caller can create verification_token rows for
   * non-members, and nothing prunes them.
   */
  it('prunes expired verification tokens, a debt the repo had written down', async () => {
    await db.insert(schema.verificationTokens).values([
      { identifier: 'stale@example.com', token: 'tok-old', expires: new Date(Date.now() - MINUTE) },
      { identifier: 'live@agency.test', token: 'tok-new', expires: new Date(Date.now() + MINUTE) },
    ])
    const report = await reconcileAfterRestart(db, new Date(Date.now() + 1000), silent)
    expect(report.prunedSignInLinks).toBe(1)
    const left = await db.select().from(schema.verificationTokens)
    expect(left.map((t) => t.token)).toEqual(['tok-new'])
  })
})

describe('the periodic sweep', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let sessionId: string

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'o@a.test', role: 'owner' })
      .returning({ id: schema.users.id })
    const s = await createChatSession(db, { orgId, userId: user!.id })
    sessionId = s.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /**
   * The waiter expires the row IT is waiting on. This is for the rows nobody
   * is waiting on — a timed-out turn, a closed browser — which otherwise sit
   * on the approvals page looking actionable.
   */
  it('expires lapsed rows that no waiter is left to notice', async () => {
    const lapsed = await ensureApproval(db, {
      orgId, chatSessionId: sessionId, turnId: '66666666-6666-4666-8666-666666666666',
      toolUseId: 'toolu_lapsed', toolName: 'mcp__agency__queue_touch', payload: {},
      payloadSha256: 'c'.repeat(64), risk: 'high',
      expiresAt: new Date(Date.now() - MINUTE),
    })
    const live = await ensureApproval(db, {
      orgId, chatSessionId: sessionId, turnId: '77777777-7777-4777-8777-777777777777',
      toolUseId: 'toolu_live2', toolName: 'mcp__agency__queue_touch', payload: {},
      payloadSha256: 'd'.repeat(64), risk: 'high',
      expiresAt: new Date(Date.now() + 30 * MINUTE),
    })

    expect(await sweepExpired(db, silent)).toBe(1)

    const rows = await db.select().from(schema.approvals)
    expect(rows.find((r) => r.id === lapsed.id)!.status).toBe('expired')
    expect(rows.find((r) => r.id === live.id)!.status).toBe('pending')
  })

  it('does nothing, quietly, when there is nothing to do', async () => {
    expect(await sweepExpired(db, silent)).toBe(0)
  })
})

describe('the worker lock key', () => {
  /**
   * Derived from a string rather than written as a magic integer, so a second
   * component taking a different lock is obviously a different name and not a
   * typo in a digit.
   */
  it('is a stable positive integer', () => {
    expect(Number.isInteger(WORKER_LOCK_KEY)).toBe(true)
    expect(WORKER_LOCK_KEY).toBeGreaterThan(0)
    expect(WORKER_LOCK_KEY).toBeLessThan(2 ** 32)
  })
})
