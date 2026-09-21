/**
 * The voice service (PROMPT.md §3, §8.5).
 *
 * A separate process because it is latency-critical and because it is the
 * only thing in the product holding a WebSocket. It does four things and
 * refuses everything else:
 *
 *   POST /twiml/voice   an inbound call — answer it with <ConversationRelay>
 *   WS   /relay         the conversation itself
 *   POST /twiml/action  the session ended — hand off to a person, or hang up
 *   POST /twiml/status  the call ended — close the record
 *   POST /sms           an inbound text — STOP is an opt-out, and nothing else
 *                       is answered by a machine
 *
 * ## Everything is refused by default
 *
 * Every webhook is verified against `X-Twilio-Signature` and FAILS CLOSED:
 * no auth token configured means every request is refused, the same choice
 * `/api/inbound/email` makes in the web app. These endpoints can write a
 * SUPPRESSION and a call record; without the signature, anyone who can
 * reach the port can make the system believe somebody said "stop".
 *
 * ## Outbound is not here
 *
 * There is no endpoint in this service that places a call. §2.1 makes cold
 * voice structurally impossible, and the way to keep it impossible is for
 * the dialling code not to exist. When outbound voice is built it goes
 * through `decideSend` with channel `voice` like every other message, and
 * `calls_outbound_names_its_touch` (0014) makes a row that skipped it
 * unstorable.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { WebSocketServer, type WebSocket } from 'ws'
import { aiDisclosure, normalisePhone, spokenOptOut, suppressedGreeting } from '@agency/core'
import {
  addSuppression, callByProviderSid, endCall, markAnswered, phoneIsSuppressed, schema, startCall,
  type AgencyDb,
} from '@agency/db'
import { anthropicProvider, ollamaProvider, openaiProvider } from '@agency/llm'
import type { LlmProvider } from '@agency/core'
import { loadEnv, voiceMode, type Env } from './env.js'
import { createLogger, type Logger } from './logger.js'
import { VoiceSession } from './session.js'
import {
  emptyTwiml, handoffTwiml, parseForm, rejectTwiml, relayTwiml, sayAndHangupTwiml, verifyTwilioSignature,
} from './twilio.js'

/** A call that has been answered and is waiting for its WebSocket. */
interface Pending {
  readonly callId: string
  readonly orgId: string
  readonly orgName: string
  readonly theirNumber: string
  readonly mayQualify: boolean
  readonly at: number
}

async function main(): Promise<void> {
  const env = loadEnv()
  const log = createLogger(env.LOG_LEVEL)
  const mode = voiceMode(env)

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 10_000,
  })
  // Same reasoning as the web app's pool: an idle connection closed by a
  // managed database emits 'error' on the pool, and an emit with no
  // listener throws out of a socket callback.
  pool.on('error', (err) => log.warn('idle database connection closed', { error: err.name }))
  const db = drizzle(pool, { schema }) as unknown as AgencyDb

  /**
   * The single-shot model for call summaries (§5.5), or null.
   *
   * Null is a complete configuration: every call still gets the
   * deterministic extractive summary. Built once at boot because a model
   * endpoint is not something that changes per call — unlike the agent
   * worker's connectors, which are read fresh every turn because §6
   * promises that.
   */
  const llm: LlmProvider | null = (() => {
    if (env.LLM_PROVIDER === 'ollama') {
      return ollamaProvider({
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.LLM_MODEL ?? 'llama3',
        local: env.OLLAMA_IS_LOCAL,
      })
    }
    if (env.LLM_PROVIDER === 'openai' && env.OPENAI_API_KEY) {
      return openaiProvider({ apiKey: env.OPENAI_API_KEY, model: env.LLM_MODEL ?? 'gpt-4o-mini' })
    }
    if (env.LLM_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
      return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_MODEL ?? 'claude-haiku-4-5-20251001' })
    }
    if (env.LLM_PROVIDER) {
      log.warn('a summary model is named but its credential is missing — using the deterministic summary', {
        provider: env.LLM_PROVIDER,
      })
    }
    return null
  })()

  /**
   * A call answered by a signed TwiML request, waiting for Twilio to open
   * the relay socket. This is what lets the WebSocket trust its `setup`:
   * a callSid that never came through a verified webhook is not one of
   * ours, whatever the socket claims.
   */
  const pending = new Map<string, Pending>()
  const PENDING_TTL_MS = 5 * 60_000
  const sweepPending = (): void => {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [sid, p] of pending) if (p.at < cutoff) pending.delete(sid)
  }

  /**
   * Which org answers the phone. One org is seeded (§12), so this is
   * optional — but with more than one it refuses to guess rather than
   * filing a stranger's call under whichever row came back first.
   */
  const resolveOrg = async (): Promise<{ id: string; name: string } | null> => {
    if (env.VOICE_ORG_ID) {
      const rows = await db
        .select({ id: schema.orgs.id, name: schema.orgs.name })
        .from(schema.orgs)
        .limit(50)
      return rows.find((o) => o.id === env.VOICE_ORG_ID) ?? null
    }
    const rows = await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs).limit(2)
    if (rows.length === 1) return rows[0]!
    if (rows.length > 1) log.error('more than one org and no VOICE_ORG_ID — refusing to guess whose call this is')
    return null
  }

  // --- HTTP ----------------------------------------------------------------
  const body = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let raw = ''
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        // A webhook body is a few hundred bytes. Anything larger is not one.
        if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
        raw += c.toString('utf8')
      })
      req.on('end', () => resolve(raw))
      req.on('error', reject)
    })

  const send = (res: ServerResponse, status: number, type: string, payload: string): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(payload)
  }
  const xml = (res: ServerResponse, twiml: string, status = 200): void =>
    send(res, status, 'text/xml; charset=utf-8', twiml)

  /**
   * Verify the request came from Twilio.
   *
   * The URL must be the one TWILIO signed, which behind a proxy is not the
   * one the socket saw — so it is rebuilt from VOICE_PUBLIC_URL and never
   * from the Host header, which the caller controls.
   */
  const verified = (req: IncomingMessage, target: string, params: Record<string, string>): boolean => {
    if (!env.VOICE_PUBLIC_URL) {
      log.error('refusing a webhook: VOICE_PUBLIC_URL is not set, so the signature cannot be checked')
      return false
    }
    // The WHOLE target, query string included. Twilio signs the URL it
    // requested; stripping the query before verifying refused every
    // webhook configured with one — which is a normal configuration, and
    // the failure looked like a bad auth token. Found by review.
    const url = new URL(target, env.VOICE_PUBLIC_URL).toString()
    const header = req.headers['x-twilio-signature']
    return verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params, Array.isArray(header) ? header[0] : header)
  }

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/'

      if (req.method === 'GET' && (path === '/livez' || path === '/readyz')) {
        if (path === '/livez') return send(res, 200, 'application/json', JSON.stringify({ status: 'ok', service: 'voice' }))
        try {
          await pool.query('SELECT 1')
        } catch (err) {
          return send(res, 503, 'application/json', JSON.stringify({
            status: 'degraded', service: 'voice', database: 'unreachable',
            error: err instanceof Error ? err.name : 'UnknownError',
          }))
        }
        return send(res, mode === 'disabled' ? 503 : 200, 'application/json', JSON.stringify({
          status: mode === 'disabled' ? 'unconfigured' : 'ok', service: 'voice', voice: mode, live: pending.size,
        }))
      }

      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed')

      let form: Record<string, string>
      try {
        form = parseForm(await body(req))
      } catch {
        return send(res, 413, 'text/plain', 'too large')
      }
      if (!verified(req, req.url ?? path, form)) {
        log.warn('refused an unsigned or badly signed webhook', { path })
        return send(res, 403, 'text/plain', 'forbidden')
      }

      // ---- an inbound call --------------------------------------------
      if (path === '/twiml/voice') {
        const org = await resolveOrg()
        if (!org || !env.VOICE_PUBLIC_URL) {
          log.error('cannot answer: no org resolved or no public URL')
          return xml(res, sayAndHangupTwiml('Sorry, this line is not configured. Goodbye.'))
        }
        const from = form['From'] ?? ''
        const to = form['To'] ?? ''
        const sid = form['CallSid'] ?? ''
        if (!sid) return xml(res, rejectTwiml())
        if (form['Direction'] && !form['Direction'].startsWith('inbound')) {
          // This service answers calls; it does not place them (§2.1).
          log.warn('refusing a non-inbound call', { direction: form['Direction'] })
          return xml(res, rejectTwiml())
        }

        const suppressed = await phoneIsSuppressed(db, org.id, from)
        const call = await startCall(db, {
          orgId: org.id, direction: 'in', fromNumber: from, toNumber: to, providerCallSid: sid,
        })
        // Answered — distinct from disclosed, which happens when the relay
        // session starts. Keeping them separate is what makes
        // `callsThatDidNotDisclose()` able to report anything at all.
        await markAnswered(db, call.id)
        pending.set(sid, {
          callId: call.id, orgId: org.id, orgName: org.name,
          theirNumber: from, mayQualify: !suppressed, at: Date.now(),
        })
        sweepPending()
        log.info('answering an inbound call', { callId: call.id, suppressed, known: call.contactId !== null })

        const wsUrl = new URL('/relay', env.VOICE_PUBLIC_URL).toString().replace(/^http/, 'ws')
        return xml(res, relayTwiml({
          wsUrl,
          actionUrl: new URL('/twiml/action', env.VOICE_PUBLIC_URL).toString(),
          // THE disclosure. Spoken by the carrier before our socket says a
          // word, and not interruptible — see session.ts.
          welcomeGreeting: suppressed ? suppressedGreeting(org.name) : aiDisclosure(org.name),
          language: env.VOICE_LANGUAGE,
          ttsProvider: env.VOICE_TTS_PROVIDER,
          voice: env.VOICE_TTS_VOICE,
          parameters: { callId: call.id },
        }))
      }

      // ---- the relay session ended -------------------------------------
      if (path === '/twiml/action') {
        let handoff: { reason?: string; detail?: string } = {}
        try {
          handoff = JSON.parse(form['HandoffData'] ?? '{}') as typeof handoff
        } catch { /* a session that ended without data is just over */ }

        if (handoff.reason === 'live-agent-handoff') {
          const org = await resolveOrg()
          log.info('handing off to a person', { detail: handoff.detail })
          return xml(res, handoffTwiml({
            say: 'Connecting you now.',
            taskRouterWorkflowSid: env.TASKROUTER_WORKFLOW_SID ?? null,
            dialNumber: env.VOICE_HANDOFF_NUMBER ?? null,
            callerId: env.TWILIO_FROM_NUMBER ?? null,
            taskAttributes: { reason: handoff.detail ?? 'handoff', org: org?.name ?? null },
          }))
        }
        return xml(res, sayAndHangupTwiml('Thanks for calling. Goodbye.'))
      }

      // ---- the call ended ----------------------------------------------
      if (path === '/twiml/status') {
        const sid = form['CallSid'] ?? ''
        const status = form['CallStatus'] ?? 'completed'
        const call = sid ? await callByProviderSid(db, 'twilio', sid) : null
        if (call && !call.endedAt) {
          const mapped =
            status === 'completed' ? 'completed'
              : status === 'no-answer' ? 'no_answer'
                : status === 'busy' ? 'busy'
                  : status === 'canceled' ? 'cancelled' : 'failed'
          await endCall(db, {
            orgId: call.orgId, callId: call.id, status: mapped,
            durationS: form['CallDuration'] ? Number(form['CallDuration']) : null,
            recordingUrl: form['RecordingUrl'] ?? null,
          })
          log.info('call record closed by the status callback', { callId: call.id, status: mapped })
        }
        pending.delete(sid)
        return send(res, 204, 'text/plain', '')
      }

      // ---- an inbound text ---------------------------------------------
      if (path === '/sms') {
        const org = await resolveOrg()
        const from = form['From'] ?? ''
        const text = (form['Body'] ?? '').trim()
        if (!org) return xml(res, emptyTwiml())
        // Carriers already honour STOP, but the carrier does not tell the
        // CRM. Recording it here is what stops the next campaign.
        // ONE opt-out detector for the whole product. This used to be its
        // own narrower regex, which caught exactly the keywords the carrier
        // already handles and dropped "take me off your list" — recorded
        // nowhere, so the next campaign mailed them. Found by review.
        if (spokenOptOut(text)) {
          const e164 = normalisePhone(from)
          log.info('inbound opt-out by SMS', { readable: e164 !== null })
          let added: { ok: boolean; message?: string }
          try {
            added = await addSuppression(db, {
              orgId: org.id, kind: 'phone', value: from, reason: 'asked to stop by SMS',
            })
          } catch (err) {
            added = { ok: false, message: err instanceof Error ? err.name : 'UnknownError' }
          }
          if (!added.ok) log.error('STOP NOT RECORDED — follow up by hand', { reason: added.message })
          return xml(res, emptyTwiml())
        }
        // Everything else waits for a person. An AI that answers texts it was
        // not asked to answer is cold outreach with extra steps.
        log.info('inbound SMS left for a human')
        return xml(res, emptyTwiml())
      }

      return send(res, 404, 'text/plain', 'not found')
    })().catch((err: unknown) => {
      log.error('webhook failed', { error: err instanceof Error ? err.name : 'UnknownError' })
      if (!res.headersSent) send(res, 500, 'text/plain', 'error')
    })
  })

  // --- the relay WebSocket -------------------------------------------------
  // 1 MiB is already far more than any relay message; the default allows
  // 100 MiB per frame from an unauthenticated peer.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  const sockets = new Set<WebSocket>()

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/relay') { socket.destroy(); return }
    // Twilio signs the upgrade request too. Verifying it here means an
    // unauthenticated peer cannot even open the socket, rather than being
    // stopped one message later by the pending-map check.
    if (!verified(req, req.url ?? '/relay', {})) {
      log.warn('refused an unsigned relay upgrade')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    let session: VoiceSession | null = null
    let closed = false
    sockets.add(ws)
    /**
     * Turns are handled ONE AT A TIME.
     *
     * `ws.on('message')` fires whenever bytes arrive, and each handler was
     * an independent fire-and-forget promise — so a second utterance could
     * be processed while the first was still awaiting the database, and the
     * script carried on talking after an opt-out had already ended the
     * call. Chaining them also gives `done()` something to wait for, so a
     * hang-up no longer closes the record a turn early. Found by review.
     */
    let turn: Promise<void> = Promise.resolve()
    const serialise = (work: () => Promise<void>): void => {
      turn = turn.then(work).catch((err: unknown) => {
        log.error('relay turn failed', { error: err instanceof Error ? err.name : 'UnknownError' })
      })
    }
    // §8.5's ceiling, which was declared, documented, wired through compose
    // and enforced nowhere. A stuck session otherwise holds a socket and a
    // database connection for as long as the process lives.
    const ceiling = setTimeout(() => {
      log.warn('call hit VOICE_MAX_CALL_SECONDS — ending it', { seconds: env.VOICE_MAX_CALL_SECONDS })
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'text', token: 'I have to end the call here. Someone will follow up. Goodbye.', last: true }))
        ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify({ reason: 'done', detail: 'max call duration' }) }))
      }
      ws.close(1000, 'max duration')
    }, env.VOICE_MAX_CALL_SECONDS * 1000)

    const speak = (text: string, last: boolean): void => {
      if (!text || ws.readyState !== ws.OPEN) return
      ws.send(JSON.stringify({ type: 'text', token: text, last }))
    }
    const act = async (action: { say: string; end: boolean; handoff?: { reason: string; detail: string } }): Promise<void> => {
      speak(action.say, true)
      if (action.end && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'end',
          handoffData: JSON.stringify(action.handoff ?? { reason: 'done', detail: '' }),
        }))
      }
    }

    ws.on('message', (raw) => {
      serialise(async () => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>
        } catch {
          log.warn('relay sent something that was not JSON')
          return
        }
        const type = String(msg['type'] ?? '')

        if (type === 'setup') {
          const sid = String(msg['callSid'] ?? '')
          const p = pending.get(sid)
          if (!p) {
            // A socket naming a call we never answered through a SIGNED
            // webhook is not ours, whatever it says.
            log.warn('relay setup for an unknown call — closing', { known: false })
            ws.close(1008, 'unknown call')
            return
          }
          pending.delete(sid)
          session = new VoiceSession({
            db, log, orgId: p.orgId, orgName: p.orgName, callId: p.callId,
            theirNumber: p.theirNumber, mayQualify: p.mayQualify,
            canHandOff: Boolean(env.TASKROUTER_WORKFLOW_SID || env.VOICE_HANDOFF_NUMBER),
            llm,
            allowRemoteForLeadData: env.LLM_ALLOW_REMOTE_LEAD_DATA,
          })
          await act(await session.onSetup())
          return
        }

        if (!session) return
        if (type === 'prompt') {
          // `last` false means the caller is mid-sentence; wait for the rest.
          if (msg['last'] === false) return
          await act(await session.onPrompt(String(msg['voicePrompt'] ?? '')))
          return
        }
        if (type === 'dtmf') { await act(await session.onDtmf(String(msg['digit'] ?? ''))); return }
        if (type === 'interrupt') return
        if (type === 'error') {
          const description = String(msg['description'] ?? '')
          log.warn('relay reported an error', { description: description.slice(0, 200) })
          // Not merely logged: a TTS failure before the caller has spoken
          // means the DISCLOSURE went unheard, and the record must not go
          // on claiming otherwise.
          await act(await session.onRelayError(description))
          return
        }
      })
    })

    const done = async (): Promise<void> => {
      if (closed) return
      closed = true
      clearTimeout(ceiling)
      sockets.delete(ws)
      // Wait for the turn in flight before closing the record, or a caller
      // who hangs up mid-sentence has their last utterance — which may be
      // the opt-out — land after the record was already closed.
      await turn.catch(() => {})
      // The status callback also closes the record. `endCall` only writes
      // an outcome when `ended_at IS NULL`, so whichever arrives first wins
      // and the other cannot downgrade it.
      await session?.finish('completed')
    }
    ws.on('close', () => void done())
    ws.on('error', () => void done())
  })

  await new Promise<void>((resolve) => server.listen(env.VOICE_PORT, env.VOICE_BIND, resolve))
  log.info('voice service listening', {
    port: env.VOICE_PORT, bind: env.VOICE_BIND, mode,
    summaries: llm ? `${llm.name} (${llm.local ? 'local' : 'REMOTE'})` : 'deterministic',
    public: env.VOICE_PUBLIC_URL ? 'set' : 'UNSET — every webhook will be refused',
  })

  const stop = (signal: string): void => {
    log.info('shutting down', { signal, liveCalls: sockets.size })
    // Close live sockets explicitly. `server.close()` waits for existing
    // connections, and a WebSocket never ends on its own — so a single call
    // in progress meant the process never exited and was eventually killed,
    // leaving its row `in_progress` with no outcome.
    for (const ws of sockets) ws.close(1001, 'server shutting down')
    wss.close()
    server.close(() => void pool.end().finally(() => process.exit(0)))
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

main().catch((err: unknown) => {
  // Never the message: a driver or config error can carry a credential (§2.3).
  console.error(JSON.stringify({
    level: 'error', msg: 'voice service failed to start', service: 'voice',
    error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'UnknownError',
  }))
  process.exit(1)
})
