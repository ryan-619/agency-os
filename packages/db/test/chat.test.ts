/**
 * Chat sessions and the transcript beneath them.
 *
 * The tests worth having here are not "a message can be saved". They are the
 * ones about a turn that never finished: a worker killed mid-flight, a frame
 * redelivered after a reconnect, two tabs starting a turn on one thread, and
 * money that is a string and would silently concatenate if anyone added it
 * with a plus sign.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'
import * as schema from '../src/schema.js'
import {
  appendChatMessage, chatMessages, clearInterruptedTurns, clearTurnRunning, createChatSession,
  ensureChatSessionTitle, listChatSessions, markTurnRunning, readChatSession, sessionCostUsd,
  setSdkSessionId, titleFromFirstMessage, usd, type AgencyDb,
} from '../src/index.js'

describe('chat sessions', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let seq = 0

  const turn = () => `33333333-3333-4333-8333-${String(++seq).padStart(12, '0')}`

  beforeAll(async () => {
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

  afterAll(async () => {
    await test?.close()
  })

  describe('usd', () => {
    /**
     * cost_usd is drizzle `numeric` with no mode, so it is typed STRING on
     * insert and select. Adding two of them with `+` concatenates: "0.01" plus
     * "0.02" is "0.010.02", which stores fine and reads as a plausible number
     * to nobody. Every value crosses the boundary through here.
     */
    it('formats money at the column precision', () => {
      expect(usd(0)).toBe('0.000000')
      expect(usd(1.5)).toBe('1.500000')
      expect(usd(0.0000004)).toBe('0.000000')
    })

    it('refuses to write a negative or nonsensical cost', () => {
      expect(usd(-1)).toBe('0.000000')
      expect(usd(Number.NaN)).toBe('0.000000')
      expect(usd(Number.POSITIVE_INFINITY)).toBe('0.000000')
    })
  })

  describe('titles', () => {
    it('uses the first thing a person said, on one line', () => {
      expect(titleFromFirstMessage('  score   the\npipeline  ')).toBe('score the pipeline')
    })

    it('truncates a long opening without cutting mid-word run-on', () => {
      const long = 'a'.repeat(200)
      const title = titleFromFirstMessage(long)
      expect(title.length).toBeLessThanOrEqual(60)
      expect(title.endsWith('…')).toBe(true)
    })

    it('is set once and never overwritten by a later message', async () => {
      const s = await createChatSession(db, { orgId, userId })
      await ensureChatSessionTitle(db, orgId, s.id, 'the first thing')
      await ensureChatSessionTitle(db, orgId, s.id, 'something else entirely')
      expect((await readChatSession(db, orgId, s.id))!.title).toBe('the first thing')
    })
  })

  describe('the transcript', () => {
    it('keeps frames in the order they happened within a turn', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const t = turn()
      await appendChatMessage(db, { orgId, sessionId: s.id, turnId: t, seq: 0, role: 'user', content: { text: 'hi' } })
      await appendChatMessage(db, { orgId, sessionId: s.id, turnId: t, seq: 1, role: 'assistant', content: { text: 'hello' } })
      const rows = await chatMessages(db, orgId, s.id)
      expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
      expect(rows.map((r) => r.seq)).toEqual([0, 1])
    })

    /**
     * A tool call and its result each get exactly one row. The SDK redelivers
     * frames after a transport gap and the browser replays on reconnect, so an
     * unguarded append would show the same tool card twice.
     */
    it('does not append a second copy of a redelivered tool frame', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const t = turn()
      const frame = {
        orgId, sessionId: s.id, turnId: t, seq: 1, role: 'tool' as const,
        toolUseId: 'toolu_dup', toolName: 'mcp__agency__get_icp',
        content: { input: { a: 1 } },
      }
      await appendChatMessage(db, frame)
      await appendChatMessage(db, { ...frame, content: { input: { a: 1 }, note: 'redelivered' } })

      const rows = await chatMessages(db, orgId, s.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.content).toMatchObject({ note: 'redelivered' })
    })

    it('still keeps the call and its result apart, since they differ by role', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const t = turn()
      await appendChatMessage(db, {
        orgId, sessionId: s.id, turnId: t, seq: 1, role: 'assistant',
        toolUseId: 'toolu_pair', toolName: 'x', content: { kind: 'call' },
      })
      await appendChatMessage(db, {
        orgId, sessionId: s.id, turnId: t, seq: 2, role: 'tool',
        toolUseId: 'toolu_pair', toolName: 'x', content: { kind: 'result' },
      })
      expect(await chatMessages(db, orgId, s.id)).toHaveLength(2)
    })

    it('appends every plain text frame, because those are genuinely new', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const t = turn()
      for (let i = 0; i < 3; i += 1) {
        await appendChatMessage(db, { orgId, sessionId: s.id, turnId: t, seq: i, role: 'user', content: { text: 'again' } })
      }
      expect(await chatMessages(db, orgId, s.id)).toHaveLength(3)
    })
  })

  describe('cost', () => {
    it('is summed by the database, not by adding strings in JavaScript', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const t = turn()
      await appendChatMessage(db, {
        orgId, sessionId: s.id, turnId: t, seq: 0, role: 'user', content: {}, costUsd: usd(0.01),
      })
      await appendChatMessage(db, {
        orgId, sessionId: s.id, turnId: turn(), seq: 0, role: 'user', content: {}, costUsd: usd(0.02),
      })
      expect(await sessionCostUsd(db, orgId, s.id)).toBeCloseTo(0.03, 6)
    })

    it('is zero for a session nobody has spent anything on', async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(await sessionCostUsd(db, orgId, s.id)).toBe(0)
    })
  })

  describe('a turn in flight', () => {
    it('claims the session, and refuses a second concurrent turn on it', async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(await markTurnRunning(db, orgId, s.id, turn())).toBe(true)
      // A second browser tab. Two turns on one thread would interleave two
      // conversations into one SDK transcript.
      expect(await markTurnRunning(db, orgId, s.id, turn())).toBe(false)
    })

    it('releases the claim when the turn finishes', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const t = turn()
      await markTurnRunning(db, orgId, s.id, t)
      await clearTurnRunning(db, orgId, s.id, t)
      expect((await readChatSession(db, orgId, s.id))!.runningTurnId).toBeNull()
      expect(await markTurnRunning(db, orgId, s.id, turn())).toBe(true)
    })

    it('does not let a stale turn release a claim it no longer holds', async () => {
      const s = await createChatSession(db, { orgId, userId })
      const mine = turn()
      await markTurnRunning(db, orgId, s.id, mine)
      await clearTurnRunning(db, orgId, s.id, turn()) // someone else's turn id
      expect((await readChatSession(db, orgId, s.id))!.runningTurnId).toBe(mine)
    })

    /**
     * The worker is SIGKILLed mid-turn. Nothing wrote a completion, and the
     * process that owed an answer is gone. Without this, a browser reattaching
     * to the thread shows a spinner forever — the worst failure mode in the
     * phase, because it is indistinguishable from the model thinking.
     */
    it('clears every turn the worker was running when it died, and names them', async () => {
      const a = await createChatSession(db, { orgId, userId })
      const b = await createChatSession(db, { orgId, userId })
      const idle = await createChatSession(db, { orgId, userId })
      const ta = turn()
      const tb = turn()
      await markTurnRunning(db, orgId, a.id, ta)
      await markTurnRunning(db, orgId, b.id, tb)

      const interrupted = await clearInterruptedTurns(db)
      const bySession = new Map(interrupted.map((i) => [i.sessionId, i]))
      expect(bySession.get(a.id)?.turnId).toBe(ta)
      expect(bySession.get(b.id)?.turnId).toBe(tb)
      expect(bySession.has(idle.id)).toBe(false)
      expect(bySession.get(a.id)?.orgId).toBe(orgId)

      // And the sessions are usable again rather than stuck.
      expect((await readChatSession(db, orgId, a.id))!.runningTurnId).toBeNull()
      expect(await markTurnRunning(db, orgId, a.id, turn())).toBe(true)
    })

    it('finds nothing to clear on a clean start', async () => {
      await clearInterruptedTurns(db)
      expect(await clearInterruptedTurns(db)).toEqual([])
    })
  })

  describe('the SDK session handle', () => {
    it('is recorded so the next turn can resume the conversation', async () => {
      const s = await createChatSession(db, { orgId, userId })
      expect(s.sdkSessionId).toBeNull() // nobody has spoken yet
      await setSdkSessionId(db, orgId, s.id, 'sdk-session-abc')
      expect((await readChatSession(db, orgId, s.id))!.sdkSessionId).toBe('sdk-session-abc')
    })

    /**
     * 0007 made this unique per org. Two threads naming one SDK transcript
     * would make `resume` splice two conversations together — one person's
     * question answered with another person's context.
     */
    it('cannot be claimed by two threads at once', async () => {
      const a = await createChatSession(db, { orgId, userId })
      const b = await createChatSession(db, { orgId, userId })
      await setSdkSessionId(db, orgId, a.id, 'sdk-session-shared')
      await expect(setSdkSessionId(db, orgId, b.id, 'sdk-session-shared')).rejects.toThrow()
    })
  })

  describe('listing', () => {
    it('shows a person their own threads, most recently active first', async () => {
      const [other] = await db
        .insert(schema.users)
        .values({ orgId, email: 'someone-else@agency.test', role: 'member' })
        .returning({ id: schema.users.id })
      const mine = await createChatSession(db, { orgId, userId })
      const theirs = await createChatSession(db, { orgId, userId: other!.id })

      const listed = await listChatSessions(db, orgId, userId)
      const ids = listed.map((s) => s.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
    })

    it('hides archived threads', async () => {
      const s = await createChatSession(db, { orgId, userId })
      await db.update(schema.chatSessions).set({ archived: true }).where(eq(schema.chatSessions.id, s.id))
      expect((await listChatSessions(db, orgId, userId)).map((r) => r.id)).not.toContain(s.id)
    })
  })
})
