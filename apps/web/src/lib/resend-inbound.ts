import type { handleInboundEmail, InboundOutcome } from '@agency/db/queries'
import { log } from './logger'
import { verifySvix } from './svix'

/**
 * Replies through Resend — how a deployment with no worker learns that
 * somebody answered (PROMPT.md §8.4, "or the provider webhook").
 *
 * Resend receives mail for a domain and posts `email.received`, signed by
 * Svix. That event is METADATA ONLY — Resend's words: "Webhooks do not
 * include the email body, headers, or attachments, only their metadata" —
 * so the message itself is a second, authenticated call to
 * `GET /emails/receiving/{email_id}`. What comes back is mapped to the same
 * shape the IMAP listener and `/api/inbound/email` produce, and handed to
 * `handleInboundEmail`. This file is a READER: it maps a message and can
 * send nothing, and it has no matcher of its own — what a reply MEANS (the
 * pause, the deal, the opt-out, which contact it belongs to) is decided in
 * exactly one place, and it is not here.
 *
 * ## Every refusal, and why it is the status it is
 *
 * Resend retries any non-2xx on a schedule that runs for days, and a
 * delivery it gave up on is marked failed in its dashboard. So the status
 * code is a decision about whether to be asked again:
 *
 *  - **503** when either variable is unset, or the secret is not a `whsec_`
 *    secret — this deployment cannot read a delivery, and every one is
 *    refused rather than half-read (the generic route's rule). Retried,
 *    which is right: once somebody fixes the configuration the retries land.
 *  - **401** for a signature that does not verify. An unauthenticated
 *    version of this route would let anyone on the internet mark a contact
 *    as having replied, pause their sequence and suppress their address.
 *  - **502** when the message could not be FETCHED. This is the one place
 *    the answer differs from the generic route's "200 either way", on
 *    purpose: a 200 tells Resend the message was read, and a message this
 *    system never read might say "stop". Resend's API failing now is
 *    exactly the case a retry fixes, and a message that never becomes
 *    fetchable fails loudly in Resend's dashboard instead of silently here.
 *  - **500** when `handleInboundEmail` throws — a database fault. Retried;
 *    the Message-ID makes a retry record the reply once.
 *  - **200** for everything that WAS read: a match, a non-match ("this
 *    address is not a contact" is the answer to a delivery, not a failure
 *    of it), a message with no readable sender, and every event type but
 *    `email.received`.
 *
 * ## What the worker-less path cannot do
 *
 * Match by Message-ID, usually. That needs the `provider_id` of something
 * this system SENT, and on a deployment with no worker nothing sends; so a
 * reply is filed by its From address, and only when exactly one contact in
 * every org has it. Whether Resend's `headers` carries `In-Reply-To` and
 * `References` at all is undocumented — they are read when present. And no
 * DSN: a delivery-status report arrives as an attachment, which the
 * receiving API lists but does not inline, so a bounce reaching this route
 * is read as a reply, not recognised as a bounce (`dsn: null`).
 *
 * ## §2.3
 *
 * The API key goes in the `Authorization` header of one request to one
 * pinned origin, with redirects refused, and nowhere else: not a log line,
 * not a return value. Failures are reported by status and error NAME. The
 * message body is never logged; only ids, counts and `why`.
 *
 * No `server-only` marker and no environment: the route reads `env()` and
 * hands the two secrets in, so the test suite can drive this whole path
 * with the network and the database injected.
 */

/** Exactly what `handleInboundEmail` accepts — declared from it, so the two cannot drift. */
export type InboundMail = Parameters<typeof handleInboundEmail>[1]

/** An `email.received` event is a few hundred bytes of metadata; 64 KB is generous. */
export const RESEND_MAX_BODY = 64 * 1024

const RESEND_API = 'https://api.resend.com'
const FETCH_TIMEOUT_MS = 10_000
/** The generic route's bound on the text handed to `handleInboundEmail`. */
const MAX_TEXT = 20_000
/** HTML is converted before the text bound applies; this bounds the work of converting it. */
const MAX_HTML = 200_000
const MAX_SUBJECT = 998
const MAX_HEADERS = 100
const MAX_HEADER_VALUE = 2_000
const MAX_REFERENCES = 100
/** Resend's ids are UUIDs. Anything else never reaches a URL that carries the key. */
const EMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The class of a failure and nothing else — a message can quote the request. */
function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string' && err.name) {
    return err.name
  }
  return 'UnknownError'
}

export type ReceivedEmailFetch =
  | { readonly ok: true; readonly email: unknown }
  | { readonly ok: false; readonly status: number | null; readonly error: string }

/**
 * One received message, from Resend's receiving API.
 *
 * Never throws. A refusal is reduced to its status — Resend's error body is
 * not read, because an API's error body is where the request gets quoted
 * back. Redirects are refused rather than followed: the pinned origin is
 * the only place the key is meant to go.
 */
export async function fetchReceivedEmail(
  apiKey: string,
  emailId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReceivedEmailFetch> {
  if (!EMAIL_ID.test(emailId)) return { ok: false, status: null, error: 'invalid_email_id' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${RESEND_API}/emails/receiving/${emailId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` }
    try {
      return { ok: true, email: (await res.json()) as unknown }
    } catch (err) {
      return { ok: false, status: res.status, error: errorName(err) }
    }
  } catch (err) {
    return { ok: false, status: null, error: errorName(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The address out of a From header: `Jane Doe <jane@acme.example>`,
 * `"Doe, Jane" <jane@acme.example>` or a bare `jane@acme.example`. Resend
 * returns the display-name form, and `handleInboundEmail` normalises an
 * ADDRESS — it would refuse the whole header as unreadable.
 */
function addressOf(from: unknown): string | null {
  if (typeof from !== 'string') return null
  const angle = /<([^<>]*)>\s*$/.exec(from)
  const address = (angle ? angle[1] : from)?.trim()
  return address ? address : null
}

const ENTITIES: Readonly<Record<string, string>> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  // One pass, so `&amp;lt;` becomes `&lt;` and not `<`.
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (whole, e: string) => {
    if (e.startsWith('#')) {
      const hex = e[1] === 'x' || e[1] === 'X'
      const cp = Number.parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10)
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })
}

/**
 * An HTML-only reply as text, KEEPING ITS LINES.
 *
 * The lines are the point. The opt-out reader (`looksLikeOptOut`) reads the
 * person's own words — the first line, above anything quoted — and a quote
 * is recognised by a line that starts `>` or reads `On … wrote:`. The
 * worker's fallback flattens HTML to a single line, which turns
 * `Stop<blockquote>…` into `Stop On Mon, … wrote: …`: not a line that IS an
 * opt-out, so the reply pauses the contact but never suppresses them. Here a
 * block element ends a line and a `<blockquote>` opens one with `>`, so
 * the same reply reads `Stop` above a quote.
 *
 * Not an HTML parser, and it does not need to be one: the output is read
 * for a handful of words and stored as a reply's text. Script, style and
 * comments are dropped whole, so their contents are never read as words.
 */
export function htmlToText(html: string): string {
  const flat = html
    .slice(0, MAX_HTML)
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|li|ul|ol|tr|table|h[1-6]|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(flat)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Resend's header map with lower-cased names, first value wins.
 *
 * The receiving API documents `headers` as an object of name → value. A
 * value that arrives as an array (a repeated header) keeps its first string,
 * which is what `email.message.Message.get` and mailparser's `get` answer.
 * Bounded like the generic route's `headers`: names are RFC 5322 field-names
 * of printable ASCII, values are cut at 2 000 characters, and at most 100
 * names are kept. Built through a Map so a header named `__proto__` is a
 * header, not a prototype.
 */
function foldHeaders(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (out.size >= MAX_HEADERS) break
    const key = name.trim().toLowerCase()
    if (!/^[!-9;-~]{1,100}$/.test(key) || out.has(key)) continue
    const first = typeof value === 'string'
      ? value
      : Array.isArray(value) ? value.find((v): v is string => typeof v === 'string') : undefined
    if (first !== undefined) out.set(key, first)
  }
  return out
}

/**
 * Every Message-ID in In-Reply-To, then References — the order the worker's
 * `parseInbound` uses, the direct parent first. Read from the header values
 * BEFORE they are cut to 2 000 characters: References grows by one id per
 * message in a thread, and the newest ids are at its END, so a cut would
 * drop exactly the ones most likely to name what this system sent.
 */
function referencesFrom(headers: Map<string, string>): string[] {
  const split = (v: string | undefined): string[] => (v ?? '').split(/\s+/).filter(Boolean)
  const parents = split(headers.get('in-reply-to'))
  const chain = split(headers.get('references'))
  const ids = [...new Set([...parents, ...chain])]
  if (ids.length <= MAX_REFERENCES) return ids
  const kept = new Set(parents.slice(0, MAX_REFERENCES))
  for (const id of chain.slice(-(MAX_REFERENCES - kept.size))) kept.add(id)
  return [...kept].slice(0, MAX_REFERENCES)
}

/**
 * A received message as `handleInboundEmail` takes it, or null when it has
 * no sender to match — nothing can be filed without one.
 *
 * Pure. `text` is the plain part when there is one and the HTML converted
 * to text otherwise: a reply that is only HTML must still be readable for
 * the opt-out check.
 */
export function mapReceivedEmail(json: unknown): InboundMail | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const o = json as Record<string, unknown>
  const from = addressOf(o['from'])
  if (!from) return null

  const plain = typeof o['text'] === 'string' && o['text'].trim() ? o['text'] : null
  const html = typeof o['html'] === 'string' && o['html'].trim() ? htmlToText(o['html']) : null
  const text = plain ?? (html || null)

  const folded = foldHeaders(o['headers'])
  const messageId = typeof o['message_id'] === 'string' && o['message_id'].trim()
    ? o['message_id'].trim()
    : folded.get('message-id')?.trim() || null

  return {
    from,
    subject: typeof o['subject'] === 'string' ? o['subject'].slice(0, MAX_SUBJECT) : null,
    text: text ? text.slice(0, MAX_TEXT) : null,
    messageId,
    references: referencesFrom(folded),
    headers: Object.fromEntries([...folded].map(([k, v]) => [k, v.slice(0, MAX_HEADER_VALUE)])),
    dsn: null,
  }
}

export interface ResendWebhookDeps {
  /** `env().RESEND_WEBHOOK_SECRET`. */
  readonly secret: string | null | undefined
  /** `env().RESEND_API_KEY`. */
  readonly apiKey: string | null | undefined
  readonly now: Date
  /** `handleInboundEmail` bound to the database — the one matcher. */
  readonly handle: (mail: InboundMail) => Promise<InboundOutcome>
  readonly fetchImpl?: typeof fetch
}

export interface ResendWebhookAnswer {
  readonly status: number
  readonly body: Readonly<Record<string, unknown>>
  /** What `handleInboundEmail` answered, when it ran — the route announces a fresh match from it. */
  readonly outcome: InboundOutcome | null
}

const answer = (status: number, body: Record<string, unknown>, outcome: InboundOutcome | null = null): ResendWebhookAnswer =>
  ({ status, body, outcome })

/**
 * Everything `POST /api/inbound/resend` does except reading the environment
 * and scheduling the Slack message — the route is those two things around
 * this. See the header of this file for why each status is the one it is.
 */
export async function receiveResendWebhook(request: Request, deps: ResendWebhookDeps): Promise<ResendWebhookAnswer> {
  const { secret, apiKey } = deps
  if (!secret || !apiKey) return answer(503, { error: 'inbound webhook is not configured' })

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > RESEND_MAX_BODY) return answer(413, { error: 'That request is too large.' })
  // The raw text, first: the signature is over these exact bytes, and a
  // body parsed and re-serialised would never verify.
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > RESEND_MAX_BODY) return answer(413, { error: 'That request is too large.' })

  const verdict = verifySvix({
    secret,
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
    body: raw,
    now: deps.now,
  })
  if (!verdict.ok) {
    if (verdict.why === 'bad_secret') {
      log.error('RESEND_WEBHOOK_SECRET is not a whsec_ signing secret; refusing every Resend delivery')
      return answer(503, { error: 'inbound webhook is not configured' })
    }
    log.warn('resend webhook signature refused', { why: verdict.why })
    return answer(401, { error: 'unauthorized' })
  }

  let event: unknown
  try {
    event = JSON.parse(raw)
  } catch {
    return answer(400, { error: 'invalid_json' })
  }
  const e = (event ?? {}) as Record<string, unknown>
  if (e['type'] !== 'email.received') return answer(200, { ignored: true })

  const data = (e['data'] ?? {}) as Record<string, unknown>
  const emailId = typeof data['email_id'] === 'string' ? data['email_id'] : null
  if (!emailId || !EMAIL_ID.test(emailId)) return answer(400, { error: 'email_id is required' })
  const delivery = request.headers.get('svix-id')

  const fetched = await fetchReceivedEmail(apiKey, emailId, deps.fetchImpl ?? fetch)
  if (!fetched.ok) {
    log.error('received email could not be fetched from Resend; answering 502 so it is retried', {
      emailId, delivery, status: fetched.status, error: fetched.error,
      // The likeliest misconfiguration, named: a key made for SENDING (the
      // magic-link key usually is one) cannot read the receiving API, and
      // every delivery fails the same way until the key is replaced.
      ...(fetched.status === 401 || fetched.status === 403
        ? { hint: 'RESEND_API_KEY may be a sending-only key; reading received email needs a full-access one' }
        : {}),
    })
    return answer(502, { error: 'the message could not be fetched', retry: true })
  }

  const mail = mapReceivedEmail(fetched.email)
  if (!mail) {
    // Read, and unplaceable: a retry would fetch the same message with the
    // same missing sender.
    log.warn('received email had no readable sender; not filed', { emailId, delivery })
    return answer(200, { matched: 'none', why: 'the message had no readable sender' })
  }

  let outcome: InboundOutcome
  try {
    outcome = await deps.handle(mail)
  } catch (err) {
    log.error('received email could not be recorded; answering 500 so it is retried', {
      emailId, delivery, error: errorName(err),
    })
    return answer(500, { error: 'the message could not be recorded', retry: true })
  }

  if (outcome.matched === 'none') {
    log.info('received email did not match a contact', { emailId, why: outcome.why })
    return answer(200, { matched: 'none', why: outcome.why }, outcome)
  }
  log.info('inbound reply recorded', {
    emailId,
    matched: outcome.matched,
    touchId: outcome.touchId,
    paused: outcome.paused,
    suppressed: outcome.suppressed,
    duplicate: outcome.duplicate,
    references: mail.references?.length ?? 0,
  })
  return answer(200, { matched: outcome.matched, paused: outcome.paused, suppressed: outcome.suppressed }, outcome)
}
