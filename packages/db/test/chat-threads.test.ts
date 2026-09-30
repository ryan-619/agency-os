/**
 * A person's chat threads, read and changed from the web with no worker.
 *
 * The tests that matter are the boundaries. A thread is somebody's own
 * prompts (§2.3), so the owner's read must refuse a teammate in the same org
 * exactly as it refuses a stranger in another one. Archiving must be refused
 * while a turn is running, because that turn may hold an approval open on the
 * thread. And a thread's cost must be a sum, not a concatenation — the column
 * is `numeric`, which arrives in JavaScript as a string.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  CHAT_TITLE_MAX, appendChatMessage, chatArchiveSession, chatReadOwnSession, chatRenameSession,
  chatRestoreSession, chatSessionCosts, clearTurnRunning, createChatSession, ensureChatSessionTitle,
  listChatSessions, markTurnRunning, readChatSession, schema, usd, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('chat threads', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let teammateId: string
  let strangerId: string
  let seq = 0

  const turn = () => `44444444-4444-4444-8444-${String(++seq).padStart(12, '0')}`

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'owner@agency.test', role: 'owner' },
        { orgId, email: 'teammate@agency.test', role: 'member' },
        { orgId: otherOrgId, email: 'owner@rival.test', role: 'owner' },
      ])
      .returning({ id: schema.users.id, email: schema.users.email })
    userId = users.find((u) => u.email === 'owner@agency.test')!.id
    teammateId = users.find((u) => u.email === 'teammate@agency.test')!.id
    strangerId = users.find((u) => u.email === 'owner@rival.test')!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  describe('chatReadOwnSession', () => {
    it('returns a thread to the person who owns it', async () => {
      const s = await createChatSession(db, { orgId, userId, title: 'score the pipeline' })
      const row = await chatReadOwnSession(db, orgId, userId, s.id)
      expect(row?.id).toBe(s.id)
      expect(row?.title).toBe('score the pipeline')
    })

    /**
     * The org-scoped `readChatSession` WOULD return it — that is the worker's
     * read, and the worker re-checks the owner itself. A page must not, and
     * the difference is the whole reason this function exists.
     */
    it('returns null for a teammate in the same org', async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(await readChatSession(db, orgId, s.id)).not.toBeNull()
      expect(await chatReadOwnSession(db, orgId, teammateId, s.id)).toBeNull()
    })

    it('returns null for another org, whichever org the caller claims', async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(await chatReadOwnSession(db, otherOrgId, strangerId, s.id)).toBeNull()
      // The right user named under the wrong org is still not a match.
      expect(await chatReadOwnSession(db, otherOrgId, userId, s.id)).toBeNull()
    })

    it('answers a malformed id with null, not a cast error', async () => {
      expect(await chatReadOwnSession(db, orgId, userId, 'not-a-uuid')).toBeNull()
      expect(await chatReadOwnSession(db, orgId, userId, "'; drop table chat_sessions; --")).toBeNull()
    })

    it('still returns an archived thread to its owner — hidden is not gone', async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(await chatArchiveSession(db, { orgId, userId, id: s.id })).toEqual({ ok: true })
      const row = await chatReadOwnSession(db, orgId, userId, s.id)
      expect(row?.archived).toBe(true)
    })
  })

  describe('chatArchiveSession', () => {
    it('hides a thread from the list without deleting it', async () => {
      const keep = await createChatSession(db, { orgId, userId })
      const hide = await createChatSession(db, { orgId, userId })
      expect(await chatArchiveSession(db, { orgId, userId, id: hide.id })).toEqual({ ok: true })

      const listed = (await listChatSessions(db, orgId, userId)).map((s) => s.id)
      expect(listed).toContain(keep.id)
      expect(listed).not.toContain(hide.id)
      expect(await readChatSession(db, orgId, hide.id)).not.toBeNull()
    })

    /**
     * A running turn can hold an approval open on the thread for as long as
     * the approval lives. Archive it underneath and the card a person must
     * decide on is on a thread the list no longer shows.
     */
    it('is refused while a turn is running, and leaves the thread listed', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const t = turn()
      await markTurnRunning(db, orgId, s.id, t)

      expect(await chatArchiveSession(db, { orgId, userId, id: s.id })).toEqual({ ok: false, reason: 'running' })
      expect((await readChatSession(db, orgId, s.id))!.archived).toBe(false)

      await clearTurnRunning(db, orgId, s.id, t)
      expect(await chatArchiveSession(db, { orgId, userId, id: s.id })).toEqual({ ok: true })
    })

    it("refuses a teammate's thread as not found, and leaves it alone", async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(await chatArchiveSession(db, { orgId, userId: teammateId, id: s.id })).toEqual({
        ok: false, reason: 'not_found',
      })
      expect(await chatArchiveSession(db, { orgId: otherOrgId, userId: strangerId, id: s.id })).toEqual({
        ok: false, reason: 'not_found',
      })
      expect((await readChatSession(db, orgId, s.id))!.archived).toBe(false)
    })

    it('does not report a stranger\'s RUNNING thread as running — that would confirm it exists', async () => {
      const s = await createChatSession(db, { orgId, userId })
      await markTurnRunning(db, orgId, s.id, turn())
      expect(await chatArchiveSession(db, { orgId, userId: teammateId, id: s.id })).toEqual({
        ok: false, reason: 'not_found',
      })
    })

    it('is idempotent, and a malformed id is simply not found', async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(await chatArchiveSession(db, { orgId, userId, id: s.id })).toEqual({ ok: true })
      expect(await chatArchiveSession(db, { orgId, userId, id: s.id })).toEqual({ ok: true })
      expect(await chatArchiveSession(db, { orgId, userId, id: 'nope' })).toEqual({ ok: false, reason: 'not_found' })
    })

    it('can be undone by the owner, and only by the owner', async () => {
      const s = await createChatSession(db, { orgId, userId })
      await chatArchiveSession(db, { orgId, userId, id: s.id })
      expect(await chatRestoreSession(db, { orgId, userId: teammateId, id: s.id })).toBe(false)
      expect((await readChatSession(db, orgId, s.id))!.archived).toBe(true)

      expect(await chatRestoreSession(db, { orgId, userId, id: s.id })).toBe(true)
      expect((await listChatSessions(db, orgId, userId)).map((r) => r.id)).toContain(s.id)
    })
  })

  describe('chatRenameSession', () => {
    it('renames the owner\'s thread, folded onto one line', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const result = await chatRenameSession(db, { orgId, userId, id: s.id, title: '  Tier A\n  follow-ups  ' })
      expect(result).toEqual({ ok: true, title: 'Tier A follow-ups' })
      expect((await readChatSession(db, orgId, s.id))!.title).toBe('Tier A follow-ups')
    })

    it('accepts exactly the limit and refuses one past it, without cutting', async () => {
      const s = await createChatSession(db, { orgId, userId, title: 'before' })
      const atLimit = 'a'.repeat(CHAT_TITLE_MAX)
      expect(await chatRenameSession(db, { orgId, userId, id: s.id, title: atLimit })).toEqual({ ok: true, title: atLimit })

      const over = await chatRenameSession(db, { orgId, userId, id: s.id, title: 'b'.repeat(CHAT_TITLE_MAX + 1) })
      expect(over).toMatchObject({ ok: false, reason: 'invalid' })
      expect((await readChatSession(db, orgId, s.id))!.title).toBe(atLimit)
    })

    it('counts characters as a person does — an emoji is one', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const emoji = '🔒'.repeat(CHAT_TITLE_MAX) // 240 UTF-16 units, 120 characters
      expect(await chatRenameSession(db, { orgId, userId, id: s.id, title: emoji })).toMatchObject({ ok: true })
    })

    /**
     * NULL means "nothing said yet", and the first message fills it in. A
     * blank rename stored as NULL would be undone by the next thing typed.
     */
    it('refuses a blank name rather than clearing the title', async () => {
      const s = await createChatSession(db, { orgId, userId, title: 'kept' })
      expect(await chatRenameSession(db, { orgId, userId, id: s.id, title: ' \n\t ' })).toMatchObject({
        ok: false, reason: 'invalid',
      })
      expect((await readChatSession(db, orgId, s.id))!.title).toBe('kept')
    })

    it('is not undone by the first message of a thread renamed before anything was said', async () => {
      const s = await createChatSession(db, { orgId, userId })
      await chatRenameSession(db, { orgId, userId, id: s.id, title: 'Named first' })
      await ensureChatSessionTitle(db, orgId, s.id, 'what is worth working this week?')
      expect((await readChatSession(db, orgId, s.id))!.title).toBe('Named first')
    })

    it("cannot rename a teammate's thread or another org's", async () => {
      const s = await createChatSession(db, { orgId, userId, title: 'mine' })
      expect(await chatRenameSession(db, { orgId, userId: teammateId, id: s.id, title: 'theirs' })).toMatchObject({
        ok: false, reason: 'not_found',
      })
      expect(await chatRenameSession(db, { orgId: otherOrgId, userId: strangerId, id: s.id, title: 'theirs' })).toMatchObject({
        ok: false, reason: 'not_found',
      })
      expect((await readChatSession(db, orgId, s.id))!.title).toBe('mine')
    })
  })

  describe('chatSessionCosts', () => {
    it('sums in the database — 0.01 and 0.02 are 0.03, not "0.010.02"', async () => {
      const s = await createChatSession(db, { orgId, userId })
      await appendChatMessage(db, {
        orgId, sessionId: s.id, turnId: turn(), seq: 0, role: 'assistant', content: {}, costUsd: '0.01',
      })
      await appendChatMessage(db, {
        orgId, sessionId: s.id, turnId: turn(), seq: 0, role: 'assistant', content: {}, costUsd: '0.02',
      })
      const costs = await chatSessionCosts(db, orgId, userId)
      const total = costs.get(s.id)
      expect(total).not.toBe('0.010.02')
      expect(total).toBe('0.030000')
      expect(Number.parseFloat(total!)).toBeCloseTo(0.03, 6)
    })

    it('keeps each thread separate, and leaves out one that has cost nothing', async () => {
      const a = await createChatSession(db, { orgId, userId })
      const b = await createChatSession(db, { orgId, userId })
      const idle = await createChatSession(db, { orgId, userId })
      await appendChatMessage(db, { orgId, sessionId: a.id, turnId: turn(), seq: 0, role: 'assistant', content: {}, costUsd: usd(0.5) })
      await appendChatMessage(db, { orgId, sessionId: b.id, turnId: turn(), seq: 0, role: 'assistant', content: {}, costUsd: usd(0.25) })
      // A user frame carries no cost at all; it must not turn the sum into NULL.
      await appendChatMessage(db, { orgId, sessionId: b.id, turnId: turn(), seq: 1, role: 'user', content: { text: 'hi' } })

      const costs = await chatSessionCosts(db, orgId, userId)
      expect(costs.get(a.id)).toBe('0.500000')
      expect(costs.get(b.id)).toBe('0.250000')
      expect(costs.has(idle.id)).toBe(false)
    })

    it("carries only the viewer's own threads — never a teammate's or another org's", async () => {
      const mine = await createChatSession(db, { orgId, userId })
      const theirs = await createChatSession(db, { orgId, userId: teammateId })
      const foreign = await createChatSession(db, { orgId: otherOrgId, userId: strangerId })
      for (const [o, s] of [[orgId, mine.id], [orgId, theirs.id], [otherOrgId, foreign.id]] as const) {
        await appendChatMessage(db, { orgId: o, sessionId: s, turnId: turn(), seq: 0, role: 'assistant', content: {}, costUsd: usd(1) })
      }
      const costs = await chatSessionCosts(db, orgId, userId)
      expect([...costs.keys()]).toEqual([mine.id])
    })
  })
})
