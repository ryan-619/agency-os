/**
 * One call's conversation (PROMPT.md §8.5, §2.1), against a real engine.
 *
 * The rules themselves are tested pure in `packages/core/test/voice.test.ts`.
 * What is tested here is that the SESSION applies them in the right order
 * and writes what it is obliged to write — the disclosure, the transcript,
 * the suppression row. A rule that is correct in `core` and skipped here is
 * not enforced.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { schema, startCall, type AgencyDb } from '@agency/db'
import { freshDb, migrations, type TestDb } from '../../../packages/db/test/helpers.js'
import { migrateUp } from '../../../packages/db/src/migrator.js'
import { VoiceSession } from '../src/session.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const NOW = new Date('2026-09-21T12:00:00.000Z')
const THEIR = '+14155550100'

describe('a voice session', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let callId: string

  const open = async (mayQualify = true): Promise<VoiceSession> => {
    const call = await startCall(db, {
      orgId, direction: 'in', fromNumber: THEIR, toNumber: '+14155550199',
      providerCallSid: `CA-${Math.round(NOW.getTime())}`, now: NOW,
    })
    callId = call.id
    return new VoiceSession({
      db, log: silent, orgId, orgName: 'Agency', callId,
      theirNumber: THEIR, mayQualify, now: () => NOW,
    })
  }

  const callRow = async () => (await db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0]!

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
  }, 30_000)

  afterEach(async () => { await test?.close() })

  describe('setup', () => {
    /** §2.1. The greeting is spoken by the carrier; this records that it was. */
    it('records the AI disclosure before it asks anything', async () => {
      const s = await open()
      const action = await s.onSetup()
      const row = await callRow()
      expect(row.disclosedAiAt).toEqual(NOW)
      expect(row.status).toBe('in_progress')
      expect(action.say).toMatch(/what does your company build/i)
      expect(action.end).toBe(false)
    })

    /** A suppressed number is answered, and asked nothing. */
    it('answers a suppressed caller in service-only mode', async () => {
      const s = await open(false)
      const action = await s.onSetup()
      expect(action.say).toMatch(/do-not-contact list/i)
      expect(action.say).not.toMatch(/what does your company build/i)
      // The disclosure is still recorded — they still spoke to an AI.
      expect((await callRow()).disclosedAiAt).toEqual(NOW)
    })
  })

  describe('an opt-out beats everything', () => {
    it('suppresses the number, ends the call, and says so', async () => {
      const s = await open()
      await s.onSetup()
      const action = await s.onPrompt('stop calling me')

      expect(action.end).toBe(true)
      expect(action.handoff?.reason).toBe('opted-out')
      expect(action.say).toMatch(/nobody from Agency contacts you again/i)

      const row = await callRow()
      expect(row.optedOutAt).toEqual(NOW)
      const sup = await db.select().from(schema.suppressions)
      expect(sup).toHaveLength(1)
      expect(sup[0]).toMatchObject({ kind: 'phone', value: THEIR })
    })

    it('is honoured even from a suppressed caller in service-only mode', async () => {
      const s = await open(false)
      await s.onSetup()
      const action = await s.onPrompt('take me off your list')
      expect(action.end).toBe(true)
      expect(action.handoff?.reason).toBe('opted-out')
    })

    /** It must not be reachable only at the end of the script. */
    it('is honoured mid-script, not just at the close', async () => {
      const s = await open()
      await s.onSetup()
      await s.onPrompt('We build a B2B SaaS platform')
      const action = await s.onPrompt('Actually, do not contact me again')
      expect(action.end).toBe(true)
      expect((await callRow()).optedOutAt).toEqual(NOW)
    })
  })

  describe('a person', () => {
    it('is offered the moment they ask, whatever step the script is on', async () => {
      const s = await open()
      await s.onSetup()
      const action = await s.onPrompt('can I speak to a real person')
      expect(action.end).toBe(true)
      expect(action.handoff?.reason).toBe('live-agent-handoff')
      expect((await callRow()).handoffReason).toMatch(/asked to speak to a person/)
    })

    it('is offered when they press 0', async () => {
      const s = await open()
      await s.onSetup()
      const action = await s.onDtmf('0')
      expect(action.handoff?.reason).toBe('live-agent-handoff')
      expect((await callRow()).handoffReason).toMatch(/pressed 0/)
    })

    it('is offered when the caller is plainly unhappy, without being asked for', async () => {
      const s = await open()
      await s.onSetup()
      const action = await s.onPrompt('this is ridiculous and a complete waste of my time')
      expect(action.end).toBe(true)
      expect(action.handoff?.reason).toBe('live-agent-handoff')
    })
  })

  describe('the script', () => {
    it('qualifies a caller and ends by email', async () => {
      const s = await open()
      await s.onSetup()
      await s.onPrompt('We build a B2B SaaS platform, customers log in')
      await s.onPrompt('Yes, a security questionnaire last quarter')
      await s.onPrompt('This month')
      const action = await s.onPrompt('Email is fine')

      expect(action.end).toBe(true)
      expect(action.handoff?.reason).toBe('done')
      await s.finish('completed')
      const row = await callRow()
      expect(row.outcome).toBe('qualified')
      expect(row.status).toBe('completed')
      expect(row.summary).toMatch(/^Outcome: qualified\./)
    })

    it('writes every turn to the transcript, in order', async () => {
      const s = await open()
      await s.onSetup()
      await s.onPrompt('We build a platform')
      const t = (await callRow()).transcript as { role: string; text: string }[]
      expect(t.map((e) => e.role)).toEqual(['system', 'agent', 'caller', 'agent'])
      expect(t[2]!.text).toBe('We build a platform')
    })

    it('ignores an empty utterance rather than advancing a step', async () => {
      const s = await open()
      await s.onSetup()
      const before = ((await callRow()).transcript as unknown[]).length
      const action = await s.onPrompt('   ')
      expect(action.say).toBe('')
      expect(((await callRow()).transcript as unknown[]).length).toBe(before)
    })

    it('says nothing more once the call has ended', async () => {
      const s = await open()
      await s.onSetup()
      await s.onPrompt('stop')
      const action = await s.onPrompt('hello? are you there?')
      expect(action).toEqual({ say: '', end: false })
    })
  })

  it('closes the record with an outcome even when the caller just hung up', async () => {
    const s = await open()
    await s.onSetup()
    await s.onPrompt('We build software')
    await s.finish('completed')
    const row = await callRow()
    // Two answers were never given, so it is incomplete — not "not qualified",
    // which would be a judgement nobody made.
    expect(row.outcome).toBe('incomplete')
    expect(row.endedAt).not.toBeNull()
  })
})
