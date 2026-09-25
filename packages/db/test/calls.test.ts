/**
 * The call record (PROMPT.md §8.5, §2.1), against a real engine.
 *
 * Two of these columns are not data, they are evidence that an obligation
 * was met: `disclosed_ai_at` (the AI said it was an AI) and `opted_out_at`
 * (and the suppression row written in the same breath). The tests are about
 * those, and about the one that cannot be allowed to fail quietly — an
 * opt-out that never reached the suppression list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  appendTranscript, callByProviderSid, callsThatDidNotDisclose, contactByPhone, endCall,
  listCalls, markAnswered, phoneIsSuppressed, recordDisclosure, recordHandoff, recordOptOut, schema,
  startCall, type AgencyDb,
} from '../src/index.js'
import { migratedDb,type TestDb } from './helpers.js'

const NOW = new Date('2026-09-21T12:00:00.000Z')
const THEIR = '+14155550100'

describe('calls', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [company] = await db
      .insert(schema.companies).values({ orgId, domain: 'rentman.io' }).returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', email: 'priya@rentman.io', phone: THEIR, timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
  }, 30_000)

  afterEach(async () => { await test?.close() })

  const answer = (over: Record<string, unknown> = {}) =>
    startCall(db, {
      orgId, direction: 'in', fromNumber: THEIR, toNumber: '+14155550199',
      providerCallSid: 'CA-test-1', now: NOW, ...over,
    } as never)

  it('ties an inbound call to the person whose number it is', async () => {
    const call = await answer()
    expect(call).toMatchObject({ direction: 'in', status: 'ringing', contactId, companyId })
  })

  it('does not invent a contact for a number nobody has on file', async () => {
    const call = await answer({ fromNumber: '+19995550000', providerCallSid: 'CA-unknown' })
    expect(call.contactId).toBeNull()
    expect(call.companyId).toBeNull()
  })

  /**
   * Twilio retries webhooks, and the TwiML request, the relay socket and the
   * status callback arrive separately. All three must find ONE row.
   */
  it('is idempotent on the provider call sid', async () => {
    const a = await answer()
    const b = await answer()
    expect(b.id).toBe(a.id)
    expect(await db.select().from(schema.calls)).toHaveLength(1)
    expect((await callByProviderSid(db, 'twilio', 'CA-test-1'))!.id).toBe(a.id)
  })

  describe('the AI disclosure (§2.1)', () => {
    it('is recorded once, and does NOT stamp answered_at', async () => {
      const call = await answer()
      await markAnswered(db, call.id, NOW)
      await recordDisclosure(db, call.id, NOW)
      const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
      expect(row!.disclosedAiAt).toEqual(NOW)
      expect(row!.status).toBe('in_progress')
    })

    it('is never overwritten by a second call — the first utterance is the one that counts', async () => {
      const call = await answer()
      await recordDisclosure(db, call.id, NOW)
      await recordDisclosure(db, call.id, new Date('2026-09-21T12:05:00.000Z'))
      const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
      expect(row!.disclosedAiAt).toEqual(NOW)
    })

    /**
     * THE regression. This test used to force `answered_at` by hand, which
     * made it pass while the audit was structurally incapable of firing:
     * `answered_at` was only ever written by the same statement that wrote
     * `disclosed_ai_at`, so "answered but not disclosed" could not exist.
     * It now drives the REAL production sequence — answer, then disclose —
     * so the query is exercised against a state the service can reach.
     */
    it('reports a call that was answered and never disclosed, using the real sequence', async () => {
      const call = await answer()
      expect(await callsThatDidNotDisclose(db, orgId)).toEqual([])

      // What the service does on a signed inbound webhook, and nothing more:
      // the relay never opened, so the disclosure never happened.
      await markAnswered(db, call.id, NOW)
      expect((await callsThatDidNotDisclose(db, orgId)).map((c) => c.id)).toEqual([call.id])

      await recordDisclosure(db, call.id, NOW)
      expect(await callsThatDidNotDisclose(db, orgId)).toEqual([])
    })

    it('marks answered without touching the disclosure, and only once', async () => {
      const call = await answer()
      await markAnswered(db, call.id, NOW)
      const later = new Date('2026-09-21T12:09:00.000Z')
      await markAnswered(db, call.id, later)
      const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
      expect(row!.answeredAt).toEqual(NOW)
      expect(row!.disclosedAiAt).toBeNull()
    })
  })

  describe('a spoken opt-out (§8.5)', () => {
    it('writes the suppression row, not just the column', async () => {
      const call = await answer()
      const out = await recordOptOut(db, { orgId, callId: call.id, phone: THEIR, now: NOW })
      expect(out.suppressed).toBe(true)

      const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
      expect(row!.optedOutAt).toEqual(NOW)
      // The suppression is what every later send path consults; the column
      // is only the record of when.
      const sup = await db.select().from(schema.suppressions)
      expect(sup).toHaveLength(1)
      expect(sup[0]).toMatchObject({ kind: 'phone', value: THEIR })
      expect(await phoneIsSuppressed(db, orgId, THEIR)).toBe(true)
    })

    /**
     * §2.1's obligation is that a failed opt-out fails LOUDLY. It used to
     * fail silently for the case that actually happens — a database fault,
     * which THROWS rather than returning a sentence — and the exception
     * escaped the session and left the caller listening to nothing.
     */
    it('survives the suppression write throwing, and still reports it', async () => {
      const call = await answer()
      const flaky = new Proxy(db as object, {
        get(target, prop, receiver) {
          if (prop === 'insert') return () => { throw new Error('Connection terminated unexpectedly') }
          return Reflect.get(target, prop, receiver)
        },
      }) as AgencyDb

      const out = await recordOptOut(flaky, { orgId, callId: call.id, phone: THEIR, now: NOW })
      expect(out.suppressed).toBe(false)
      expect(out.message).toMatch(/could not be written/)
      // The column is still stamped: the caller DID ask, and that is a fact
      // worth keeping even when the list write failed.
      const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
      expect(row!.optedOutAt).toEqual(NOW)
    })

    it('reports failure rather than swallowing it when the number cannot be stored', async () => {
      const call = await answer()
      // A number that cannot be normalised cannot be suppressed — §2.1 says
      // that must fail loudly to a human, never fall through.
      const out = await recordOptOut(db, { orgId, callId: call.id, phone: 'not a number', now: NOW })
      expect(out.suppressed).toBe(false)
      expect(out.message).toBeTruthy()
      expect(await db.select().from(schema.suppressions)).toEqual([])
    })

    it('does not put the number in the audit detail', async () => {
      const call = await answer()
      await recordOptOut(db, { orgId, callId: call.id, phone: THEIR, now: NOW })
      const audit = await db.select().from(schema.auditLog)
      const row = audit.find((a) => a.action === 'call.opted_out')!
      expect(row).toBeDefined()
      expect(JSON.stringify(row.detail)).not.toContain(THEIR)
    })
  })

  describe('phoneIsSuppressed', () => {
    it('treats a number it cannot read as suppressed, not as clear', async () => {
      // "We could not parse it" is not "they never asked us to stop".
      expect(await phoneIsSuppressed(db, orgId, 'nonsense')).toBe(true)
      expect(await phoneIsSuppressed(db, orgId, THEIR)).toBe(false)
    })
  })

  it('appends transcript lines in the database, so concurrent turns cannot lose one', async () => {
    const call = await answer()
    await Promise.all([
      appendTranscript(db, call.id, { role: 'agent', text: 'one', at: NOW.toISOString() }),
      appendTranscript(db, call.id, { role: 'caller', text: 'two', at: NOW.toISOString() }),
      appendTranscript(db, call.id, { role: 'caller', text: 'three', at: NOW.toISOString() }),
    ])
    const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
    expect((row!.transcript as unknown[]).length).toBe(3)
  })

  describe('closing the record', () => {
    it('derives the outcome, sentiment and summary from what was actually said', async () => {
      const call = await answer()
      await appendTranscript(db, call.id, { role: 'caller', text: 'We build a B2B SaaS platform, customers log in', at: NOW.toISOString() })
      await appendTranscript(db, call.id, { role: 'caller', text: 'Yes, a questionnaire last quarter', at: NOW.toISOString() })
      await appendTranscript(db, call.id, { role: 'caller', text: 'This month', at: NOW.toISOString() })

      const ended = await endCall(db, {
        orgId, callId: call.id, status: 'completed',
        state: { step: 'done', answers: { what: 'B2B SaaS, customers log in', pain: 'Yes, a questionnaire', timeline: 'This month' } },
        now: new Date('2026-09-21T12:03:20.000Z'),
      })
      expect(ended).toMatchObject({ status: 'completed', outcome: 'qualified' })
      expect(ended!.durationS).toBe(200)
      expect(ended!.summary).toMatch(/^Outcome: qualified\./)
      expect(ended!.sentiment).toBeTruthy()
    })

    /**
     * Two things legitimately close a call — the socket and Twilio's status
     * callback — and they race. The second must not rewrite the first's
     * outcome from a state it does not have.
     */
    it('does not let a second close overwrite the first outcome', async () => {
      const call = await answer()
      await appendTranscript(db, call.id, { role: 'caller', text: 'stop calling me', at: NOW.toISOString() })
      const first = await endCall(db, {
        orgId, callId: call.id, status: 'completed',
        state: { step: 'done', answers: { what: 'a platform' }, ending: 'opted_out' }, now: NOW,
      })
      expect(first!.outcome).toBe('opted_out')

      // The status callback, arriving later with no knowledge of the state.
      const second = await endCall(db, {
        orgId, callId: call.id, status: 'completed', durationS: 95,
        recordingUrl: 'https://api.twilio.com/rec/abc', now: new Date('2026-09-21T12:10:00.000Z'),
      })
      expect(second!.outcome).toBe('opted_out')
      expect(second!.summary).toBe(first!.summary)
      // ...but Twilio's numbers ARE better than ours, so they land.
      expect(second!.durationS).toBe(95)
      expect(second!.recordingUrl).toBe('https://api.twilio.com/rec/abc')
    })

    it('records a call nobody answered as no_answer, not as a failure to qualify', async () => {
      const call = await answer()
      const ended = await endCall(db, { orgId, callId: call.id, status: 'no_answer', now: NOW })
      expect(ended).toMatchObject({ status: 'no_answer', outcome: 'no_answer' })
    })

    it('leaves a summary even when nothing was transcribed', async () => {
      const call = await answer()
      const ended = await endCall(db, { orgId, callId: call.id, status: 'completed', now: NOW })
      expect(ended!.summary).toMatch(/did not say anything/)
    })
  })

  it('records a handoff with its reason', async () => {
    const call = await answer()
    await recordHandoff(db, { orgId, callId: call.id, reason: 'they asked for a person' })
    const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
    expect(row!.handoffReason).toBe('they asked for a person')
  })

  it('lists calls with who they were with', async () => {
    await answer()
    const [row] = await listCalls(db, orgId)
    expect(row).toMatchObject({ companyDomain: 'rentman.io', contactName: 'Priya' })
  })

  it('finds a contact by their normalised number, and nobody by an unreadable one', async () => {
    expect((await contactByPhone(db, orgId, '+1 415 555 0100'))?.id).toBe(contactId)
    expect(await contactByPhone(db, orgId, 'nonsense')).toBeNull()
  })

  /**
   * §2.4 in the schema: an outbound call is a message leaving the building,
   * so the row must name the touch whose approval placed it.
   */
  it('refuses an outbound call that names no touch, at the database', async () => {
    await expect(
      db.insert(schema.calls).values({
        orgId, direction: 'out', fromNumber: '+14155550199', toNumber: THEIR,
        provider: 'twilio', providerCallSid: 'CA-outbound', startedAt: NOW,
      }),
    ).rejects.toThrow()
  })
})
