import { MAIL_SIGNAL_LIMITS, htmlToText } from '@agency/core'
import type { handleInboundEmail, InboundOutcome } from '@agency/db/queries'
import { isScannableHost } from '@agency/scanner'
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
 *  - **502** when the message could not be FETCHED — or, for a delivery
 *    report, one of the report parts it was read for. This is the one place
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
 * `References` at all is undocumented — they are read when present.
 *
 * ## A bounce, read from its attachments
 *
 * A delivery report (RFC 3464) is a `multipart/report` whose parts the
 * receiving API lists as `attachments` — id, `content_type`, size — without
 * their contents. Each part's contents are a second call:
 * `GET /emails/receiving/{email_id}/attachments/{id}` answers a signed,
 * expiring `download_url` on Resend's CDN, fetched WITHOUT the key. So,
 * exactly as the IMAP parser does, and only when the message's ROOT is
 * `multipart/report` and it lists a `message/delivery-status` part: that
 * part is fetched as the DSN, and the returned copy (`message/rfc822` or
 * `text/rfc822-headers`) for the Message-ID that ties the report to a
 * message this system sent. Each read is bounded, the whole report shares
 * one deadline, and the result goes to the same `readMailSignals` /
 * `handleBounce` the IMAP path reaches. A report nested inside a forwarded
 * message is not read as one: the root is not a report (the IMAP rule —
 * recording a reply nobody wrote is recoverable, losing an opt-out is not).
 *
 * ## §2.3
 *
 * The API key goes in the `Authorization` header of requests to one pinned
 * origin, with redirects refused, and nowhere else: not a log line, not a
 * return value, and not the CDN request for a report part — a
 * `download_url` is a bearer link of its own, so it is never logged either.
 * Failures are reported by status and error NAME. The message body is never
 * logged; only ids, counts and `why`.
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

/**
 * An HTML-only reply as text, keeping its lines — re-exported from
 * packages/core, where the worker's IMAP parser reads it too, so a "Stop"
 * above a quote is the same opt-out whichever way it arrived.
 */
export { htmlToText }

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
  // Over the bound: every parent, then the NEWEST of the chain.
  const kept = new Set(parents.slice(0, MAX_REFERENCES))
  const room = MAX_REFERENCES - kept.size
  if (room > 0) for (const id of chain.slice(-room)) kept.add(id)
  return [...kept].slice(0, MAX_REFERENCES)
}

/**
 * A received message as `handleInboundEmail` takes it, or null when it has
 * no sender to match — nothing can be filed without one.
 *
 * Pure. `text` is the plain part when there is one and the HTML converted
 * to text otherwise: a reply that is only HTML must still be readable for
 * the opt-out check. `dsn` is always null HERE: a report's parts are
 * attachments whose contents take further requests, which
 * `receiveResendWebhook` makes (`deliveryReportParts`, `fetchDeliveryReport`).
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

/** The delivery-status parts (RFC 3464; RFC 6533's internationalised twin) — the IMAP parser's set. */
const DSN_TYPES = new Set(['message/delivery-status', 'message/global-delivery-status'])
/** Where a report carries the message it returns — whole, or its headers only. */
const RETURNED_TYPES = new Set(['message/rfc822', 'text/rfc822-headers', 'message/global', 'message/global-headers'])
/**
 * Bytes read of one report part. A delivery-status part's fields are at its
 * start, and a returned copy is read for its headers only — this system's
 * own messages carry a dozen.
 */
const REPORT_PART_MAX_BYTES = 64 * 1024
/** Returned copies read per report; a report returns one message. */
const MAX_RETURNED_PARTS = 2

/** The attachments of a received message that make it a delivery report, by id. */
export interface DeliveryReportParts {
  readonly status: string
  readonly returned: readonly string[]
}

/**
 * Which of a received message's attachments are a delivery report's parts,
 * or null for a mail that is not one. Pure.
 *
 * A report only when the ROOT says so — `Content-Type: multipart/report` in
 * the message's own headers — AND it lists a delivery-status part. A read
 * receipt is a multipart/report too, with no such part; a person forwarding
 * a bounce has a multipart/mixed root. Neither is read as a bounce.
 */
export function deliveryReportParts(json: unknown): DeliveryReportParts | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const o = json as Record<string, unknown>
  const root = foldHeaders(o['headers']).get('content-type') ?? ''
  if (!/^\s*multipart\/report\s*(?:;|$)/i.test(root)) return null
  const attachments = Array.isArray(o['attachments']) ? (o['attachments'] as unknown[]) : []
  const parts = attachments.flatMap((a) => {
    if (!a || typeof a !== 'object') return []
    const r = a as Record<string, unknown>
    const id = typeof r['id'] === 'string' && EMAIL_ID.test(r['id']) ? r['id'] : null
    const type = typeof r['content_type'] === 'string' ? (r['content_type'].split(';')[0] ?? '').trim().toLowerCase() : ''
    return id ? [{ id, type }] : []
  })
  const status = parts.find((p) => DSN_TYPES.has(p.type))
  if (!status) return null
  return {
    status: status.id,
    returned: parts.filter((p) => RETURNED_TYPES.has(p.type)).slice(0, MAX_RETURNED_PARTS).map((p) => p.id),
  }
}

/**
 * The Message-ID, then References, in the header section of a returned copy
 * — what the IMAP parser reads off mailparser's `messageId` and
 * `references`. A header section ends at the first blank line, continuation
 * lines are unfolded, and the first occurrence of each header wins.
 */
export function returnedMessageIds(copy: string): string[] {
  const head = copy.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)[0] ?? ''
  const fields = new Map<string, string>()
  let last: string | null = null
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && last !== null) {
      fields.set(last, `${fields.get(last) ?? ''} ${line.trim()}`)
      continue
    }
    const m = /^([!-9;-~]+)[ \t]*:(.*)$/.exec(line)
    last = m?.[1] ? m[1].toLowerCase() : null
    if (m?.[1] && last !== null && !fields.has(last)) fields.set(last, (m[2] ?? '').trim())
  }
  const ids: string[] = []
  const messageId = fields.get('message-id')?.trim()
  if (messageId) ids.push(messageId)
  for (const id of (fields.get('references') ?? '').split(/\s+/)) if (id.trim()) ids.push(id.trim())
  return [...new Set(ids)]
}

export type DeliveryReportFetch =
  | { readonly ok: true; readonly dsn: string; readonly originalMessageIds: readonly string[] }
  | {
      readonly ok: false
      readonly part: 'delivery-status' | 'returned-copy'
      readonly status: number | null
      readonly error: string
    }

/**
 * A signed CDN link a part may be downloaded from: `https:` on a public DNS
 * name, no credentials or port in it. Not pinned to one Resend hostname —
 * the docs show `inbound-cdn.resend.com` for attachments and call the raw
 * message's link a CloudFront URL, and a pin that guessed wrong would turn
 * every bounce into a 502 Resend retries for days. What it must never be is
 * a link into the network this function runs in.
 */
function isDownloadUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && isScannableHost(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

/** At most `max` bytes of a body, the stream cancelled past them. */
async function readBounded(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < max) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, max)
}

/** One part: its signed link from the receiving API (with the key), then its bytes from the CDN (without). */
async function fetchReportPart(
  apiKey: string,
  emailId: string,
  attachmentId: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly status: number | null; readonly error: string }> {
  try {
    const meta = await fetchImpl(`${RESEND_API}/emails/receiving/${emailId}/attachments/${attachmentId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
    if (!meta.ok) return { ok: false, status: meta.status, error: `http_${meta.status}` }
    let json: unknown
    try {
      json = await meta.json()
    } catch (err) {
      return { ok: false, status: meta.status, error: errorName(err) }
    }
    const url = json && typeof json === 'object' ? (json as Record<string, unknown>)['download_url'] : undefined
    if (url === undefined || url === null) return { ok: false, status: meta.status, error: 'no_download_url' }
    if (!isDownloadUrl(url)) return { ok: false, status: meta.status, error: 'download_url_refused' }
    // No Authorization header: the link is signed, and the key belongs to api.resend.com alone.
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal })
    if (!res.ok) return { ok: false, status: res.status, error: `download_http_${res.status}` }
    return { ok: true, bytes: await readBounded(res, REPORT_PART_MAX_BYTES) }
  } catch (err) {
    return { ok: false, status: null, error: errorName(err) }
  }
}

/**
 * The delivery-status text and the returned copy's ids, for a message
 * `deliveryReportParts` called a report. Never throws. Every part is read
 * under ONE deadline, so a report costs the route at most what fetching
 * the message did; a part that cannot be read fails the whole report, and
 * the route answers 502 so Resend asks again — a bounce read without the
 * copy that ties it to our message would change nothing, and say so as if
 * it had been read.
 */
export async function fetchDeliveryReport(
  apiKey: string,
  emailId: string,
  parts: DeliveryReportParts,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryReportFetch> {
  if (!EMAIL_ID.test(emailId)) return { ok: false, part: 'delivery-status', status: null, error: 'invalid_email_id' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const status = await fetchReportPart(apiKey, emailId, parts.status, fetchImpl, controller.signal)
    if (!status.ok) return { ok: false, part: 'delivery-status', status: status.status, error: status.error }
    const ids: string[] = []
    for (const id of parts.returned) {
      const copy = await fetchReportPart(apiKey, emailId, id, fetchImpl, controller.signal)
      if (!copy.ok) return { ok: false, part: 'returned-copy', status: copy.status, error: copy.error }
      ids.push(...returnedMessageIds(copy.bytes.toString('utf8')))
    }
    return {
      ok: true,
      dsn: status.bytes.toString('utf8').slice(0, MAIL_SIGNAL_LIMITS.dsnChars),
      originalMessageIds: [...new Set(ids)],
    }
  } finally {
    clearTimeout(timer)
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

  const mapped = mapReceivedEmail(fetched.email)
  if (!mapped) {
    // Read, and unplaceable: a retry would fetch the same message with the
    // same missing sender.
    log.warn('received email had no readable sender; not filed', { emailId, delivery })
    return answer(200, { matched: 'none', why: 'the message had no readable sender' })
  }

  // A delivery report: its parts, read the way the IMAP parser reads them.
  // A part that could not be read is a message that was not read — 502.
  let mail: InboundMail = mapped
  const parts = deliveryReportParts(fetched.email)
  if (parts) {
    const report = await fetchDeliveryReport(apiKey, emailId, parts, deps.fetchImpl ?? fetch)
    if (!report.ok) {
      log.error('a delivery report part could not be fetched from Resend; answering 502 so it is retried', {
        emailId, delivery, part: report.part, status: report.status, error: report.error,
      })
      return answer(502, { error: 'the message could not be fetched', retry: true })
    }
    mail = { ...mapped, dsn: report.dsn, originalMessageIds: report.originalMessageIds }
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

  if (outcome.matched === 'none' && outcome.bounce) {
    // A delivery report tied to a message this system sent. Ids and the
    // report's status code: the address is in the row, not here.
    log.info('delivery report recorded', {
      emailId,
      contactId: outcome.bounce.contactId,
      touchId: outcome.bounce.touchId,
      permanent: outcome.bounce.permanent,
      code: outcome.bounce.code,
      marked: outcome.bounce.marked,
    })
    return answer(200, { matched: 'none', why: outcome.why }, outcome)
  }
  if (outcome.matched === 'none') {
    log.info('received email did not match a contact', { emailId, why: outcome.why, report: parts !== null })
    return answer(200, { matched: 'none', why: outcome.why }, outcome)
  }
  log.info('inbound reply recorded', {
    emailId,
    matched: outcome.matched,
    touchId: outcome.touchId,
    paused: outcome.paused,
    suppressed: outcome.suppressed,
    duplicate: outcome.duplicate,
    // True means a "stop" whose suppression could not be written: the route
    // raises the opt_out_not_recorded alarm from `outcome`.
    optOutNotRecorded: outcome.optOutNotRecorded,
    references: mail.references?.length ?? 0,
  })
  return answer(200, { matched: outcome.matched, paused: outcome.paused, suppressed: outcome.suppressed }, outcome)
}
