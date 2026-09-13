/**
 * The approval queue, against a real Postgres engine.
 *
 * PROMPT.md §2.4 makes this the thing standing between an agent and an action
 * that leaves the building, and §5.4 makes a permission callback wait on it.
 * That combination means the interesting cases are not the happy path — they
 * are the ones where nobody answers, two people answer at once, the SDK asks
 * twice for one intent, or a worker dies holding the question.
 *
 * Every test here drives the same functions the agent worker calls. None of
 * them needs an API key, because none of this is the model's half.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { expectRejection, freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'
import * as schema from '../src/schema.js'
import {
  appendAudit, approvalsForSession, canonicalJson, decideApproval, ensureApproval,
  expireApproval, pendingApprovals, readApproval, sweepExpiredApprovals,
  type AgencyDb, type ApprovalRequest,
} from '../src/index.js'

const MINUTE = 60_000

describe('the approval queue', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let otherOrgId: string
  let sessionId: string
  let seq = 0

  beforeAll(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Someone Else' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [session] = await db
      .insert(schema.chatSessions)
      .values({ orgId, userId })
      .returning({ id: schema.chatSessions.id })
    sessionId = session!.id
  }, 30_000)

  afterAll(async () => {
    await test?.close()
  })

  beforeEach(() => {
    seq += 1
  })

  /** A distinct, valid request each time, so tests do not collide on the keys. */
  const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    orgId,
    chatSessionId: sessionId,
    turnId: `22222222-2222-4222-8222-${String(seq).padStart(12, '0')}`,
    toolUseId: `toolu_${seq}`,
    toolName: 'mcp__agency__queue_touch',
    payload: { companyId: 'c1', channel: 'email', body: 'hello' },
    payloadSha256: String(seq).padStart(64, 'b'),
    risk: 'high',
    expiresAt: new Date(Date.now() + 30 * MINUTE),
    ...over,
  })

  describe('canonicalJson', () => {
    it('hashes the same call the same way whatever order the keys arrive in', () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
      expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe(canonicalJson({ x: { c: 2, d: 1 } }))
    })

    it('does not collapse two genuinely different calls into one', () => {
      expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }))
      expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
      expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
    })
  })

  describe('ensureApproval', () => {
    it('raises a pending approval that names the call it gates', async () => {
      const req = request()
      const row = await ensureApproval(db, req)
      expect(row.status).toBe('pending')
      expect(row.requestedBy).toBe('agent')
      expect(row.toolUseId).toBe(req.toolUseId)
      expect(row.turnId).toBe(req.turnId)
      expect(row.chatSessionId).toBe(sessionId)
    })

    /**
     * The SDK's own doc on Query.reinitialize: "a request whose response was
     * lost in the gap will be dispatched again". Two rows would mean two cards
     * and two humans for one action.
     */
    it('returns the same row when the SDK redelivers the same tool_use_id', async () => {
      const req = request()
      const first = await ensureApproval(db, req)
      const second = await ensureApproval(db, req)
      expect(second.id).toBe(first.id)
      expect(await countApprovals(db, req.turnId)).toBe(1)
    })

    /**
     * And the case tool_use_id alone misses: the SDK denies a call that raced
     * an unanswered hook, then retries it — with a NEW tool_use_id and the
     * same arguments. One human intent, so one card.
     */
    it('returns the same row when the call is retried under a new tool_use_id', async () => {
      const req = request()
      const first = await ensureApproval(db, req)
      const retried = await ensureApproval(db, { ...req, toolUseId: `${req.toolUseId}_retry` })
      expect(retried.id).toBe(first.id)
      expect(await countApprovals(db, req.turnId)).toBe(1)
    })

    /**
     * The consequence that matters most: a redelivery of an ALREADY ANSWERED
     * call inherits the answer. Nobody is asked twice, and in particular a
     * denial is not quietly converted into a second chance to say yes.
     */
    it('inherits an existing decision rather than asking again', async () => {
      const req = request()
      const raised = await ensureApproval(db, req)
      await decideApproval(db, { orgId, id: raised.id, decision: 'denied', decidedBy: userId })

      const redelivered = await ensureApproval(db, { ...req, toolUseId: `${req.toolUseId}_again` })
      expect(redelivered.id).toBe(raised.id)
      expect(redelivered.status).toBe('denied')
    })

    it('keeps two different calls in the same turn apart', async () => {
      const req = request()
      await ensureApproval(db, req)
      await ensureApproval(db, {
        ...req,
        toolUseId: `${req.toolUseId}_b`,
        payload: { companyId: 'c2' },
        payloadSha256: String(seq).padStart(64, 'c'),
      })
      expect(await countApprovals(db, req.turnId)).toBe(2)
    })

    it('refuses to raise a row that cannot be traced to a tool call', async () => {
      // Through the raw driver: the point is that the DATABASE refuses this,
      // not that ensureApproval declines to ask. Drizzle wraps the driver
      // error and the constraint name ends up on the cause, so the assertion
      // would be meaningless through the query builder.
      const msg = await expectRejection(() =>
        test.driver.select(
          `INSERT INTO approvals (org_id, requested_by, tool_name, risk, expires_at)
           VALUES ($1, 'agent', 'x', 'high', now() + interval '30 minutes')`,
          [orgId],
        ),
      )
      expect(msg).toContain('approvals_agent_request_is_traceable')
    })
  })

  describe('decideApproval', () => {
    it('records the decision, the decider and the time in one statement', async () => {
      const raised = await ensureApproval(db, request())
      const out = await decideApproval(db, {
        orgId, id: raised.id, decision: 'approved', decidedBy: userId, reason: 'checked the draft',
      })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.row.status).toBe('approved')
      expect(out.row.decidedBy).toBe(userId)
      expect(out.row.decidedAt).not.toBeNull()
      expect(out.row.decidedReason).toBe('checked the draft')
    })

    /**
     * Two people click Approve at the same moment. The database arbitrates —
     * exactly one UPDATE matches a pending row — and the loser is told WHO
     * won, so their screen can say so instead of showing an error.
     */
    it('lets exactly one of two simultaneous decisions win, and names the winner to the loser', async () => {
      const raised = await ensureApproval(db, request())
      const [a, b] = await Promise.all([
        decideApproval(db, { orgId, id: raised.id, decision: 'approved', decidedBy: userId }),
        decideApproval(db, { orgId, id: raised.id, decision: 'denied', decidedBy: userId }),
      ])
      const winners = [a, b].filter((r) => r.ok)
      const losers = [a, b].filter((r) => !r.ok)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      const loser = losers[0]!
      expect(loser.ok).toBe(false)
      if (loser.ok || loser.reason !== 'already_decided') {
        throw new Error(`expected already_decided, got ${JSON.stringify(loser)}`)
      }
      expect(loser.row.decidedBy).toBe(userId)
      expect(loser.row.status).toMatch(/approved|denied/)
    })

    /**
     * The stale-tab case. CLAUDE.md records that the schema deliberately does
     * NOT forbid an approved row whose decided_at is past its expires_at, so
     * that this surfaces as a clean answer here rather than as a constraint
     * violation and a 500. This is that promise being kept.
     */
    it('refuses a decision on a lapsed approval, cleanly', async () => {
      const raised = await ensureApproval(db, request({ expiresAt: new Date(Date.now() - MINUTE) }))
      const out = await decideApproval(db, { orgId, id: raised.id, decision: 'approved', decidedBy: userId })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.reason).toBe('expired')
      const after = await readApproval(db, orgId, raised.id)
      expect(after!.status).toBe('pending') // untouched; the sweeper owns the transition
    })

    it('refuses a decider from another org', async () => {
      const [outsider] = await db
        .insert(schema.users)
        .values({ orgId: otherOrgId, email: `outsider-${seq}@elsewhere.test`, role: 'owner' })
        .returning({ id: schema.users.id })
      const raised = await ensureApproval(db, request())
      const out = await decideApproval(db, {
        orgId, id: raised.id, decision: 'approved', decidedBy: outsider!.id,
      })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.reason).toBe('not_permitted')
    })

    it('will not decide an approval belonging to another org', async () => {
      const raised = await ensureApproval(db, request())
      const out = await decideApproval(db, {
        orgId: otherOrgId, id: raised.id, decision: 'approved', decidedBy: userId,
      })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.reason).toBe('not_found')
    })

    it('says not_found for an id that does not exist', async () => {
      const out = await decideApproval(db, {
        orgId, id: '00000000-0000-4000-8000-00000000dead', decision: 'approved', decidedBy: userId,
      })
      expect(out).toEqual({ ok: false, reason: 'not_found' })
    })
  })

  describe('expiry is a lapse, not an answer', () => {
    it('expires a lapsed row and leaves no decider on it', async () => {
      const raised = await ensureApproval(db, request({ expiresAt: new Date(Date.now() - MINUTE) }))
      const expired = await expireApproval(db, orgId, raised.id)
      expect(expired!.status).toBe('expired')
      expect(expired!.decidedBy).toBeNull()
      expect(expired!.decidedAt).toBeNull()
    })

    it('does not expire a row that is still live', async () => {
      const raised = await ensureApproval(db, request())
      expect(await expireApproval(db, orgId, raised.id)).toBeNull()
      expect((await readApproval(db, orgId, raised.id))!.status).toBe('pending')
    })

    /**
     * A decision landing in the same instant as the deadline must win. The
     * UPDATE is conditional on `status = 'pending'`, so the expiry simply
     * matches nothing — which is why the waiter re-reads on a zero result
     * instead of assuming it expired the row.
     */
    it('loses to a decision that arrives first', async () => {
      const raised = await ensureApproval(db, request())
      await decideApproval(db, { orgId, id: raised.id, decision: 'approved', decidedBy: userId })
      // Backdate it so the expiry predicate would otherwise match.
      await db.update(schema.approvals)
        .set({ expiresAt: new Date(Date.now() - MINUTE) })
        .where(eq(schema.approvals.id, raised.id))

      expect(await expireApproval(db, orgId, raised.id)).toBeNull()
      expect((await readApproval(db, orgId, raised.id))!.status).toBe('approved')
    })

    /**
     * The waiter handles the row it is waiting on. A worker that DIED leaves
     * rows nobody is waiting on at all, and those sit on the approvals page
     * looking actionable until someone clicks a button that cannot work.
     */
    it('sweeps every lapsed row, including ones no waiter is left to notice', async () => {
      const past = new Date(Date.now() - MINUTE)
      const orphan1 = await ensureApproval(db, request({ expiresAt: past }))
      seq += 1
      const orphan2 = await ensureApproval(db, request({ expiresAt: past }))
      seq += 1
      const live = await ensureApproval(db, request())

      const swept = await sweepExpiredApprovals(db, orgId)
      const sweptIds = swept.map((r) => r.id)
      expect(sweptIds).toContain(orphan1.id)
      expect(sweptIds).toContain(orphan2.id)
      expect(sweptIds).not.toContain(live.id)
      expect(swept.every((r) => r.decidedBy === null)).toBe(true)
    })
  })

  describe('reading the queue', () => {
    it('lists only what is still waiting on a human', async () => {
      const live = await ensureApproval(db, request())
      seq += 1
      const answered = await ensureApproval(db, request())
      await decideApproval(db, { orgId, id: answered.id, decision: 'approved', decidedBy: userId })

      const pending = await pendingApprovals(db, orgId)
      const ids = pending.map((r) => r.id)
      expect(ids).toContain(live.id)
      expect(ids).not.toContain(answered.id)
      expect(pending.every((r) => r.status === 'pending')).toBe(true)
    })

    it('rebuilds the cards raised inside one chat session', async () => {
      const mine = await ensureApproval(db, request())
      const rows = await approvalsForSession(db, orgId, sessionId)
      expect(rows.map((r) => r.id)).toContain(mine.id)
      expect(rows.every((r) => r.chatSessionId === sessionId)).toBe(true)
    })
  })

  describe('the audit log', () => {
    it('records a tool call without being able to rewrite it afterwards', async () => {
      await appendAudit(db, {
        orgId, actor: 'agent', action: 'agent.tool_pre',
        subjectType: 'tool', detail: { toolName: 'mcp__agency__get_icp' },
      })
      const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId))
      expect(rows.length).toBeGreaterThan(0)

      const msg = await expectRejection(() =>
        test.driver.select(`UPDATE audit_log SET action = 'nothing.happened' WHERE org_id = $1`, [orgId]),
      )
      expect(msg).toContain('append-only')
    })
  })
})

async function countApprovals(db: AgencyDb, turnId: string): Promise<number> {
  const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.turnId, turnId))
  return rows.length
}
