/**
 * Phase 6's Definition of Done, against the real service (PROMPT.md §9).
 *
 * *"An inbound call is answered by the agent, discloses AI, qualifies, hands
 * off to a human, and writes a transcript and summary."*
 *
 * `session.test.ts` drives the conversation object and `twilio.test.ts`
 * drives the signature; between them sat `index.ts` — the HTTP routes, the
 * WebSocket upgrade, the pending-call map, the boot wiring — with no test
 * at all. Everything those two files prove could be correct while the
 * service answered nothing, and the first thing to notice would have been a
 * real phone call.
 *
 * So this test IS Twilio: it signs a webhook the way Twilio signs one,
 * reads the TwiML back, opens the relay socket against the URL that TwiML
 * hands out, speaks, and reads the frames the service sends. The only thing
 * it does not prove is Twilio itself — the carrier, the STT and the TTS —
 * and that cannot be proved from here at all. Everything on this side of
 * the wire is exercised.
 *
 * The database is a real Postgres engine (PGlite) with the real migrations,
 * so the rows asserted at the end are the rows a deployment would have.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { schema, type AgencyDb } from '@agency/db'
import { fakeProvider } from '@agency/llm'
import type { LlmProvider } from '@agency/core'
import { freshDb, migrations, type TestDb } from '../../../packages/db/test/helpers.js'
import { migrateUp } from '../../../packages/db/src/migrator.js'
import { twilioSignature } from '../src/twilio.js'
import { loadEnv } from '../src/env.js'
import { startVoiceService, type VoiceService } from '../src/index.js'

const TOKEN = 'a-test-auth-token'
const PUBLIC = 'https://voice.example.test'
const THEIR = '+14155550100'
const OURS = '+14155550199'
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/**
 * A port nothing else is on.
 *
 * `VOICE_PORT: 0` would be the obvious thing and the schema rejects it —
 * correctly: a deployment that binds a random port answers no healthcheck
 * and Twilio reaches nothing. So the test asks the OS for one and hands
 * back the number.
 */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const env = (port: number, over: Record<string, string> = {}) =>
  loadEnv({
    DATABASE_URL: 'postgres://unused-by-the-factory',
    LOG_LEVEL: 'error',
    VOICE_PORT: String(port),
    VOICE_BIND: '127.0.0.1',
    VOICE_PUBLIC_URL: PUBLIC,
    TWILIO_ACCOUNT_SID: 'AC-test',
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_FROM_NUMBER: OURS,
    VOICE_HANDOFF_NUMBER: '+14155550123',
    ...over,
  })

/**
 * A signed form POST, exactly as Twilio makes one.
 *
 * Note the two URLs: the request goes to 127.0.0.1 on an ephemeral port,
 * and the signature is computed over VOICE_PUBLIC_URL. That difference is
 * the design — behind a proxy the URL Twilio signed is never the one the
 * socket saw — so a test that signed the local URL would be testing
 * something this service deliberately does not do.
 */
function post(
  port: number, path: string, form: Record<string, string>, opts: { sign?: boolean | string } = {},
): Promise<{ status: number; body: string }> {
  const payload = new URLSearchParams(form).toString()
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(Buffer.byteLength(payload)),
  }
  if (opts.sign !== false) {
    headers['x-twilio-signature'] =
      typeof opts.sign === 'string' ? opts.sign : twilioSignature(TOKEN, `${PUBLIC}${path}`, form)
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** The relay socket, with the frames it receives queued for reading. */
class Relay {
  readonly frames: Record<string, unknown>[] = []
  private closedWith: { code: number } | null = null
  private constructor(private readonly ws: WebSocket) {}

  static async open(port: number, sign: boolean | string = true): Promise<Relay> {
    const headers: Record<string, string> = {}
    if (sign !== false) {
      headers['x-twilio-signature'] =
        typeof sign === 'string' ? sign : twilioSignature(TOKEN, `${PUBLIC}/relay`, {})
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers })
    const relay = new Relay(ws)
    ws.on('message', (raw) => relay.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>))
    ws.on('close', (code) => { relay.closedWith = { code } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
      ws.once('close', () => reject(new Error('refused')))
    })
    return relay
  }

  /**
   * Say something and wait for the service to finish answering.
   *
   * Not "wait for one frame": a turn is a `text` frame and then, when the
   * call is ending, a separate `end` frame carrying the HandoffData. Those
   * are two `ws.send` calls, and returning after the first would make every
   * assertion about the second depend on them landing in the same tick —
   * true today, and a flake rather than a failure the day it stops being
   * true. So it waits for the frames to STOP arriving.
   */
  async say(message: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const before = this.frames.length
    this.ws.send(JSON.stringify(message))
    await this.until(() => this.frames.length > before || this.closedWith !== null)
    let settled = this.frames.length
    for (;;) {
      await new Promise((r) => setTimeout(r, 60))
      if (this.frames.length === settled) break
      settled = this.frames.length
    }
    return this.frames.slice(before)
  }

  /** Send without expecting an answer — the caller closing the line. */
  hangUp(): Promise<void> {
    this.ws.close()
    return this.until(() => this.closedWith !== null)
  }

  get closed(): { code: number } | null { return this.closedWith }

  async until(done: () => boolean, ms = 4000): Promise<void> {
    const deadline = Date.now() + ms
    while (!done()) {
      if (Date.now() > deadline) throw new Error('timed out waiting on the relay')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

const said = (frames: Record<string, unknown>[]): string =>
  frames.filter((f) => f['type'] === 'text').map((f) => String(f['token'])).join(' ')

const attr = (xml: string, name: string): string | null =>
  new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1] ?? null

describe('the voice service, end to end', () => {
  let test: TestDb
  let db: AgencyDb
  let service: VoiceService
  let orgId: string

  const start = async (over: Record<string, string> = {}, llm: LlmProvider | null = null): Promise<void> => {
    service = await startVoiceService({
      env: env(await freePort(), over), db, log: silent, ping: () => Promise.resolve(), llm,
    })
  }

  /** Answer a call the way Twilio does, and return what the TwiML said. */
  const answer = async (sid: string, from = THEIR) => {
    const res = await post(service.port, '/twiml/voice', {
      CallSid: sid, From: from, To: OURS, Direction: 'inbound',
    })
    expect(res.status).toBe(200)
    return res.body
  }

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
  }, 30_000)

  afterEach(async () => {
    await service?.close()
    await test?.close()
  })

  /**
   * THE Phase 6 test. Everything in the Definition of Done, in one call,
   * through the wire the carrier actually uses.
   */
  it('answers, discloses, qualifies, hands off, and writes a transcript and summary', async () => {
    await start()
    const sid = 'CA-the-definition-of-done'
    const twiml = await answer(sid)

    // Answered with a relay, and the disclosure rides on the noun itself so
    // that nothing of ours can precede it.
    expect(twiml).toContain('<ConversationRelay')
    const greeting = attr(twiml, 'welcomeGreeting')
    expect(greeting).toMatch(/\bAI\b/)
    expect(attr(twiml, 'welcomeGreetingInterruptible')).toBe('none')
    // And the caller can talk over the agent, which is what makes "say stop
    // at any time" true while it is still talking.
    expect(attr(twiml, 'reportInputDuringAgentSpeech')).toBe('any')

    const wsUrl = attr(twiml, 'url')
    expect(wsUrl).toBe(`${PUBLIC.replace('https', 'wss')}/relay`)

    const relay = await Relay.open(service.port)
    const opening = await relay.say({ type: 'setup', callSid: sid, from: THEIR, to: OURS })
    expect(said(opening)).toBeTruthy()

    // The four scripted questions. Each answer comes back with the next one.
    await relay.say({ type: 'prompt', voicePrompt: 'We run a B2B SaaS platform with a customer login', last: true })
    await relay.say({ type: 'prompt', voicePrompt: 'A customer sent us a security questionnaire and we stalled', last: true })
    await relay.say({ type: 'prompt', voicePrompt: 'We need it sorted this quarter', last: true })
    const last = await relay.say({ type: 'prompt', voicePrompt: 'Yes, put me through to someone', last: true })

    // Handing off is an `end` frame carrying HandoffData — that string is
    // what Twilio posts back to /twiml/action.
    expect(said(last)).toMatch(/connect you to a person/i)
    const end = last.find((f) => f['type'] === 'end')
    expect(end).toBeDefined()
    const handoffData = String(end!['handoffData'])
    expect(JSON.parse(handoffData)).toMatchObject({ reason: 'live-agent-handoff' })

    // Twilio then asks what to do with the call.
    const action = await post(service.port, '/twiml/action', { CallSid: sid, HandoffData: handoffData })
    expect(action.status).toBe(200)
    expect(action.body).toMatch(/<Dial|<Enqueue/)

    await relay.hangUp()
    const status = await post(service.port, '/twiml/status', {
      CallSid: sid, CallStatus: 'completed', CallDuration: '96',
      RecordingUrl: 'https://api.twilio.com/recordings/RE-abc',
    })
    expect(status.status).toBe(204)

    const [row] = await db.select().from(schema.calls).where(eq(schema.calls.providerCallSid, sid))
    expect(row).toBeDefined()
    expect(row!.answeredAt).not.toBeNull()
    // The evidence that §2.1's obligation was met on THIS call.
    expect(row!.disclosedAiAt).not.toBeNull()
    expect(row!.outcome).toBe('handoff')
    // The socket closed the record first, so the outcome above is the
    // session's — and the two things only Twilio knows still landed.
    expect(row!.durationS).toBe(96)
    expect(row!.recordingUrl).toBe('https://api.twilio.com/recordings/RE-abc')
    expect(row!.summary).toBeTruthy()

    // A transcript of the call, with the caller's own words in it.
    const transcript = row!.transcript as { role: string; text: string }[]
    expect(transcript.length).toBeGreaterThanOrEqual(5)
    expect(transcript.map((t) => t.text).join(' ')).toContain('security questionnaire')
    expect(transcript.some((t) => t.role === 'caller')).toBe(true)
    expect(transcript.some((t) => t.role === 'agent')).toBe(true)
  }, 30_000)

  /** §5.5 in situ: the seam reaches the row through the real service. */
  it('summarises with the configured local model, over the wire', async () => {
    await start({}, fakeProvider('They stalled on a security questionnaire and want a call.'))
    const sid = 'CA-summarised'
    await answer(sid)
    const relay = await Relay.open(service.port)
    await relay.say({ type: 'setup', callSid: sid })
    await relay.say({ type: 'prompt', voicePrompt: 'We run a SaaS platform', last: true })
    await relay.hangUp()

    await new Promise((r) => setTimeout(r, 150))
    const [row] = await db.select().from(schema.calls).where(eq(schema.calls.providerCallSid, sid))
    expect(row!.summary).toBe('They stalled on a security questionnaire and want a call.')
  }, 30_000)

  describe('the boundary', () => {
    it('refuses an unsigned webhook', async () => {
      await start()
      const res = await post(service.port, '/twiml/voice', { CallSid: 'CA-x', From: THEIR, To: OURS }, { sign: false })
      expect(res.status).toBe(403)
      expect(await db.select().from(schema.calls)).toHaveLength(0)
    })

    it('refuses a webhook whose parameters were changed after signing', async () => {
      await start()
      const honest = { CallSid: 'CA-y', From: THEIR, To: OURS }
      const sig = twilioSignature(TOKEN, `${PUBLIC}/twiml/voice`, honest)
      const res = await post(service.port, '/twiml/voice', { ...honest, From: '+14155550999' }, { sign: sig })
      expect(res.status).toBe(403)
    })

    /**
     * The one that matters most. An unconfigured deployment must refuse
     * everything rather than accept everything.
     */
    it('refuses every webhook when no auth token is configured', async () => {
      await start({ TWILIO_AUTH_TOKEN: '' })
      const res = await post(service.port, '/twiml/voice', { CallSid: 'CA-z', From: THEIR, To: OURS })
      expect(res.status).toBe(403)
    })

    it('refuses an unsigned relay upgrade', async () => {
      await start()
      await expect(Relay.open(service.port, false)).rejects.toThrow()
    })

    /**
     * A signed socket is still not enough. The callSid has to be one this
     * service answered through a verified TwiML webhook — otherwise anyone
     * holding the auth token's signature for `/relay` could open a session
     * on a call that does not exist.
     */
    it('closes a relay naming a call it never answered', async () => {
      await start()
      const relay = await Relay.open(service.port)
      await relay.say({ type: 'setup', callSid: 'CA-never-answered' })
      await relay.until(() => relay.closed !== null)
      expect(relay.closed).toMatchObject({ code: 1008 })
    })

    /** §2.1: this service answers calls. It does not place them. */
    it('refuses to answer an outbound call', async () => {
      await start()
      const res = await post(service.port, '/twiml/voice', {
        CallSid: 'CA-out', From: OURS, To: THEIR, Direction: 'outbound-api',
      })
      expect(res.body).toContain('<Reject')
      expect(await db.select().from(schema.calls)).toHaveLength(0)
    })
  })

  describe('what a caller asks for', () => {
    /** The whole of §2.1's opt-out obligation, through the wire. */
    it('records a spoken opt-out as a suppression and ends the call', async () => {
      await start()
      const sid = 'CA-stop'
      await answer(sid)
      const relay = await Relay.open(service.port)
      await relay.say({ type: 'setup', callSid: sid })
      const reply = await relay.say({ type: 'prompt', voicePrompt: 'Take me off your list', last: true })

      expect(said(reply)).toMatch(/nobody from Agency contacts you again/i)
      expect(reply.some((f) => f['type'] === 'end')).toBe(true)

      const [sup] = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
      expect(sup).toMatchObject({ kind: 'phone', value: THEIR })

      await relay.hangUp()
      await new Promise((r) => setTimeout(r, 150))
      const [row] = await db.select().from(schema.calls).where(eq(schema.calls.providerCallSid, sid))
      expect(row!.outcome).toBe('opted_out')
    }, 30_000)

    /**
     * And the call after it. A suppressed number is greeted, told how to
     * reach a person, and not qualified — §2.1 is about what we do to them,
     * not about refusing to answer the phone.
     */
    it('does not qualify a caller who has already asked to be left alone', async () => {
      await start()
      await db.insert(schema.suppressions).values({
        orgId, kind: 'phone', value: THEIR, reason: 'asked to stop',
      })
      const twiml = await answer('CA-known-stop')
      expect(attr(twiml, 'welcomeGreeting')).not.toMatch(/\bfew quick questions\b/i)
    })

    it('records an SMS opt-out that the carrier already handled', async () => {
      await start()
      const res = await post(service.port, '/sms', { From: THEIR, To: OURS, Body: 'take me off your list' })
      expect(res.status).toBe(200)
      const [sup] = await db.select().from(schema.suppressions)
      expect(sup).toMatchObject({ kind: 'phone', value: THEIR })
    })

    it('leaves any other text for a human and answers nothing', async () => {
      await start()
      const res = await post(service.port, '/sms', { From: THEIR, To: OURS, Body: 'what do you charge?' })
      expect(res.body).not.toMatch(/<Message/)
      expect(await db.select().from(schema.suppressions)).toHaveLength(0)
    })
  })

  describe('/readyz', () => {
    it('reports itself unconfigured rather than healthy when Twilio is not set up', async () => {
      await start({ TWILIO_AUTH_TOKEN: '', TWILIO_ACCOUNT_SID: '' })
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: service.port, path: '/readyz' }, (r) => {
          let body = ''
          r.on('data', (c: Buffer) => { body += c.toString('utf8') })
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(res.status).toBe(503)
      expect(JSON.parse(res.body)).toMatchObject({ status: 'unconfigured', voice: 'disabled' })
    })
  })
})
