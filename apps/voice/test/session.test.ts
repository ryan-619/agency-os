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
import { callsThatDidNotDisclose, markAnswered, schema, startCall, type AgencyDb } from '@agency/db'
import { migratedDb,type TestDb } from '../../../packages/db/test/helpers.js'
import { fakeProvider } from '@agency/llm'
import { VoiceSession } from '../src/session.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const NOW = new Date('2026-09-21T12:00:00.000Z')
const THEIR = '+14155550100'

describe('a voice session', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let callId: string

  const openWith = async (deps: Partial<ConstructorParameters<typeof VoiceSession>[0]>): Promise<VoiceSession> => {
    const call = await startCall(db, {
      orgId, direction: 'in', fromNumber: THEIR, toNumber: '+14155550199',
      providerCallSid: `CA-${Math.round(NOW.getTime())}`, now: NOW,
    })
    callId = call.id
    await markAnswered(db, call.id, NOW)
    return new VoiceSession({
      db, log: silent, orgId, orgName: 'Agency', callId,
      theirNumber: THEIR, mayQualify: true, canHandOff: true, now: () => NOW, ...deps,
    })
  }

  const open = async (mayQualify = true, canHandOff = true): Promise<VoiceSession> => {
    const call = await startCall(db, {
      orgId, direction: 'in', fromNumber: THEIR, toNumber: '+14155550199',
      providerCallSid: `CA-${Math.round(NOW.getTime())}`, now: NOW,
    })
    callId = call.id
    // What the signed inbound webhook does before the socket opens. Kept
    // here so the test drives the same sequence production does — the
    // previous version skipped it, which is how a structurally vacuous
    // disclosure audit passed its own test.
    await markAnswered(db, call.id, NOW)
    return new VoiceSession({
      db, log: silent, orgId, orgName: 'Agency', callId,
      theirNumber: THEIR, mayQualify, canHandOff, now: () => NOW,
    })
  }

  const callRow = async () => (await db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0]!

  beforeEach(async () => {
    test = await migratedDb()
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
      expect(row.answeredAt).toEqual(NOW)
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

    /**
     * A caller must never be told they are being connected to somebody who
     * does not exist. With no TaskRouter workflow and no on-call number,
     * the call still ends as a handoff so a person picks it up — but the
     * promise changes.
     */
    it('does not promise a transfer a deployment cannot perform', async () => {
      const s = await open(true, false)
      await s.onSetup()
      const action = await s.onPrompt('can I speak to a real person')
      expect(action.handoff?.reason).toBe('live-agent-handoff')
      expect(action.say).not.toMatch(/connect you to a person now/i)
      expect(action.say).toMatch(/somebody calls you back/i)
    })

    it('is offered when the caller is plainly unhappy, without being asked for', async () => {
      const s = await open()
      await s.onSetup()
      const action = await s.onPrompt('this is ridiculous and a complete waste of my time')
      expect(action.end).toBe(true)
      expect(action.handoff?.reason).toBe('live-agent-handoff')
    })
  })

  /**
   * Twilio documents TTS failures as non-fatal — the session carries on and
   * the caller heard nothing. If what went unheard was the disclosure, the
   * record must stop claiming it happened.
   */
  describe('a greeting that never played is not a disclosure', () => {
    it('takes the disclosure back and ends the call', async () => {
      const s = await open()
      await s.onSetup()
      expect((await callRow()).disclosedAiAt).toEqual(NOW)

      const action = await s.onRelayError('64111 TTS Provider Service Error')
      expect(action.end).toBe(true)
      expect(action.say).toMatch(/I am an AI assistant/i)

      const row = await callRow()
      expect(row.disclosedAiAt).toBeNull()
      // ...and the audit can now see it, which is the whole point.
      expect((await callsThatDidNotDisclose(db, orgId)).map((c) => c.id)).toEqual([callId])
    })

    it('leaves the record alone once the caller has already been talking', async () => {
      const s = await open()
      await s.onSetup()
      await s.onPrompt('We build a platform')
      const action = await s.onRelayError('64112 TTS Conversion Error')
      expect(action.end).toBe(false)
      expect((await callRow()).disclosedAiAt).toEqual(NOW)
    })

    it('does not treat an unrelated relay error as a failed disclosure', async () => {
      const s = await open()
      await s.onSetup()
      const action = await s.onRelayError('64107 Invalid Message Received')
      expect(action.end).toBe(false)
      expect((await callRow()).disclosedAiAt).toEqual(NOW)
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

  /**
   * §5.5's seam, in its first real consumer. The deterministic extractive
   * summary is what the product has always written; a model is allowed to
   * improve on it and never to be required for it.
   */
  describe('the call summary (§5.5)', () => {
    it('uses a local model when one is configured', async () => {
      const llm = fakeProvider('They have a login-bearing product and failed a questionnaire.')
      const s = await openWith({ llm })
      await s.onSetup()
      await s.onPrompt('We build a B2B SaaS platform')
      await s.finish('completed')

      expect((await callRow()).summary).toBe('They have a login-bearing product and failed a questionnaire.')
      // The transcript went to the model — and only the caller/agent turns.
      expect(llm.seen[0]!.prompt).toMatch(/Caller: We build a B2B SaaS platform/)
      expect(llm.seen[0]!.prompt).not.toMatch(/welcome greeting/)
    })

    /**
     * THE rule. A transcript is a named person's words, so a remote model
     * nobody approved never sees it — and the record still gets a summary.
     */
    it('refuses to send the transcript to an unapproved remote model, and still writes a summary', async () => {
      const llm = fakeProvider('never asked', { name: 'openai', local: false })
      const s = await openWith({ llm })
      await s.onSetup()
      await s.onPrompt('We build a platform')
      await s.finish('completed')

      expect(llm.seen).toEqual([])
      const row = await callRow()
      // The deterministic one, written by endCall exactly as before.
      expect(row.summary).toMatch(/^Outcome: /)
    })

    it('sends it once the operator has accepted that', async () => {
      const llm = fakeProvider('a remote summary', { name: 'openai', local: false })
      const s = await openWith({ llm, allowRemoteForLeadData: true })
      await s.onSetup()
      await s.onPrompt('We build a platform')
      await s.finish('completed')
      expect((await callRow()).summary).toBe('a remote summary')
    })

    it('falls back to the deterministic summary when the model is down', async () => {
      const s = await openWith({
        llm: {
          name: 'ollama', model: 'llama3', local: true,
          complete: () => Promise.reject(new Error('ECONNREFUSED')),
        },
      })
      await s.onSetup()
      await s.onPrompt('We build a platform')
      await s.finish('completed')
      expect((await callRow()).summary).toMatch(/^Outcome: /)
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
