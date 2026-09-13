/**
 * The agent worker's HTTP surface.
 *
 * Bound to loopback and fronted by the web app, which is where authentication
 * happens (PROMPT.md §3: the web app is the BFF). Nothing here is reachable
 * from the internet, and the shared token below is defence in depth rather
 * than the trust anchor — it proves the caller is the web app, not who the
 * human is. The principal is re-derived from the database on every turn, so
 * the worst a forged body can do is address a conversation that already
 * exists and already belongs to the user it names.
 *
 *   POST /internal/turns                     start a turn; the response IS the stream
 *   POST /internal/turns/:turnId/interrupt   stop one
 *   GET  /livez  /readyz                     health (see health.ts)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { ChatEvent } from '@agency/core'
import type { Logger } from '../logger.js'
import { startSse } from './sse.js'

export interface TurnHandle {
  readonly turnId: string
  events(): AsyncGenerator<ChatEvent, void>
  interrupt(): void
}

export type { ChatEvent }

export interface StartTurnRequest {
  readonly chatSessionId: string
  readonly userId: string
  readonly text: string
}

export interface AgentHttpDeps {
  readonly port: number
  readonly token: string
  readonly log: Logger
  /** Starts a turn, or explains why it cannot. */
  readonly startTurn: (req: StartTurnRequest) => Promise<
    { ok: true; turn: TurnHandle } | { ok: false; status: number; message: string }
  >
  readonly interrupt: (turnId: string) => boolean
  /** Answers /livez and /readyz. */
  readonly health: (url: string) => Promise<{ status: number; body: unknown } | null>
}

/**
 * The request body cap, in BYTES — and `parseStartTurn` caps the message at
 * 32,000 CHARACTERS. Those are different units, and the gap is where the bug
 * was: 32,000 characters of Devanagari, Japanese or emoji is up to 128 KB of
 * UTF-8, so a message the length rule accepts was refused by the byte rule
 * first, as `body_too_large` — a 413 about a request size for a message the
 * person was told they could send.
 *
 * Four bytes per character plus room for the JSON envelope, so the CHARACTER
 * limit is always the one that speaks. The byte cap stays as the defence
 * against an unbounded body, which is its actual job.
 */
const MAX_BODY_BYTES = 160 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Constant-time, and length-safe: timingSafeEqual throws on a length mismatch. */
function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function parseStartTurn(body: unknown): StartTurnRequest | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  const chatSessionId = o['chatSessionId']
  const userId = o['userId']
  const text = o['text']
  if (typeof chatSessionId !== 'string' || !chatSessionId) return null
  if (typeof userId !== 'string' || !userId) return null
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > 32_000) return null
  return { chatSessionId, userId, text }
}

export function createAgentHttpServer(deps: AgentHttpDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((err: unknown) => {
      deps.log.error('request handler failed', {
        error: err instanceof Error ? err.name : 'UnknownError',
      })
      if (!res.headersSent) json(res, 500, { error: 'internal' })
      else res.end()
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: AgentHttpDeps): Promise<void> {
  const url = (req.url ?? '/').split('?')[0] ?? '/'

  // Health is unauthenticated: an orchestrator has to reach it, and it says
  // nothing an anonymous caller could use.
  const health = await deps.health(url)
  if (health) return json(res, health.status, health.body)

  const auth = req.headers.authorization
  const given = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
  if (!tokenMatches(deps.token, given)) {
    // No detail. A caller that got the token wrong learns only that.
    return json(res, 401, { error: 'unauthorized' })
  }

  if (req.method === 'POST' && url === '/internal/turns') {
    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      return json(res, 413, { error: 'body_too_large' })
    }
    const parsed = parseStartTurn(body)
    if (!parsed) return json(res, 400, { error: 'invalid_request' })

    const started = await deps.startTurn(parsed)
    if (!started.ok) return json(res, started.status, { error: started.message })

    // From here the response IS the stream. Nothing may write a JSON body.
    const sse = startSse(res)
    try {
      for await (const event of started.turn.events()) {
        sse.send(event)
      }
    } finally {
      sse.close()
    }
    return
  }

  const interruptMatch = /^\/internal\/turns\/([^/]+)\/interrupt$/.exec(url)
  if (req.method === 'POST' && interruptMatch) {
    const turnId = interruptMatch[1] ?? ''
    const found = deps.interrupt(turnId)
    // 202 either way: a turn that already finished is not an error, it is the
    // outcome the caller wanted.
    return json(res, 202, { interrupted: found })
  }

  json(res, 404, { error: 'not_found' })
}
