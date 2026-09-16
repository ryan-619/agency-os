/**
 * The Twilio edge: request signatures, form bodies, TwiML.
 *
 * No Twilio SDK. The three things needed are small and each is worth
 * reading in full: the signature algorithm (twilio.com/docs/usage/security),
 * an `application/x-www-form-urlencoded` body, and a few lines of XML. A
 * dependency that does these also pulls in a REST client with every
 * endpoint Twilio has, into a process whose whole design is to do very
 * little.
 *
 * ## The signature is the boundary
 *
 * Every webhook here can write to the database — a call row, a transcript,
 * a SUPPRESSION. Without the signature, anyone who can reach the port can
 * make the system believe a caller said "stop", or that a call happened.
 * So `verifyTwilioSignature` fails CLOSED: no auth token configured means
 * every request is refused, the same choice `/api/inbound/email` makes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Twilio's signature: the full URL, then every POST parameter appended as
 * name+value in sorted order, HMAC-SHA1 with the auth token, base64.
 *
 * The URL must be the one TWILIO used — scheme, host, path and query — which
 * behind a proxy is not the one the socket saw. The service builds it from
 * `VOICE_PUBLIC_URL` plus the request path, never from the Host header.
 */
export function twilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('')
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

export function verifyTwilioSignature(
  authToken: string | undefined,
  url: string,
  params: Readonly<Record<string, string>>,
  header: string | undefined,
): boolean {
  if (!authToken || !header) return false
  const expected = Buffer.from(twilioSignature(authToken, url, params))
  const given = Buffer.from(header)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** `application/x-www-form-urlencoded`, the only body Twilio sends here. */
export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(body)) out[k] = v
  return out
}

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export interface RelayTwimlInput {
  /** wss://… — the relay endpoint, public. */
  readonly wsUrl: string
  /** Where Twilio posts when the session ends (`end` message or hang-up). */
  readonly actionUrl: string
  /** Spoken by Twilio before the socket is up. The disclosure lives here so nothing precedes it. */
  readonly welcomeGreeting: string
  readonly language?: string
  readonly ttsProvider?: string
  readonly voice?: string
  /** `<Parameter>` children, delivered in the setup message's customParameters. */
  readonly parameters?: Readonly<Record<string, string>>
}

/**
 * `<Connect action="…"><ConversationRelay url="wss://…" welcomeGreeting="…" …/></Connect>`
 *
 * The greeting is NOT interruptible: the disclosure is the one sentence
 * that must be heard in full (§2.1), and `welcomeGreetingInterruptible`
 * defaults to `any`.
 */
export function relayTwiml(input: RelayTwimlInput): string {
  const attrs: Record<string, string> = {
    url: input.wsUrl,
    welcomeGreeting: input.welcomeGreeting,
    welcomeGreetingInterruptible: 'none',
    interruptible: 'true',
    dtmfDetection: 'true',
    ...(input.language ? { language: input.language } : {}),
    ...(input.ttsProvider ? { ttsProvider: input.ttsProvider } : {}),
    ...(input.voice ? { voice: input.voice } : {}),
  }
  const attrText = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')
  const params = Object.entries(input.parameters ?? {})
    .map(([name, value]) => `<Parameter name="${esc(name)}" value="${esc(value)}"/>`)
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Connect action="${esc(input.actionUrl)}"><ConversationRelay ${attrText}>${params}</ConversationRelay></Connect>` +
    `</Response>`
  )
}

/** Say something and hang up. */
export function sayAndHangupTwiml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(text)}</Say><Hangup/></Response>`
}

/** Hang up without a word — a call that should not have been answered at all. */
export function rejectTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>`
}

/**
 * The handoff. TaskRouter when a workflow is configured (§8.5's "warm
 * handoff via TaskRouter"); otherwise a plain `<Dial>` to the on-call
 * number, which is the honest minimum for a five-person agency without a
 * contact-centre workspace.
 */
export function handoffTwiml(input: {
  readonly say: string
  readonly taskRouterWorkflowSid?: string | null
  readonly dialNumber?: string | null
  readonly callerId?: string | null
  readonly taskAttributes?: Readonly<Record<string, unknown>>
}): string {
  const say = `<Say>${esc(input.say)}</Say>`
  if (input.taskRouterWorkflowSid) {
    const attrs = input.taskAttributes ? `<Task>${esc(JSON.stringify(input.taskAttributes))}</Task>` : ''
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Enqueue workflowSid="${esc(input.taskRouterWorkflowSid)}">${attrs}</Enqueue></Response>`
  }
  if (input.dialNumber) {
    const callerId = input.callerId ? ` callerId="${esc(input.callerId)}"` : ''
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Dial${callerId} timeout="25">${esc(input.dialNumber)}</Dial>` +
      `<Say>Nobody was able to pick up. Someone will call you back. Goodbye.</Say><Hangup/></Response>`
  }
  return sayAndHangupTwiml(`${input.say} Nobody is available right now; someone will call you back. Goodbye.`)
}

/** The empty response Twilio wants for an inbound SMS it should not reply to. */
export function emptyTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`
}
