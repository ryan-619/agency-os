import {
  smsTextAsksToStop,
  type InboundLog, type InboundSmsOutcome, type SmsDeliveryOutcome, type SmsDeliveryStatus,
} from '@agency/db/queries'
import { secretMatches } from '../../../../lib/secret-compare'
import type { NotificationEvent } from '../../../../lib/slack-message'
import { smsOptOutAlarms, smsReplyNotification, smsUnplacedOptOutNotification } from './notification'

/**
 * DoveSoft's two pushes, the pure half (0019): who may post, what a payload
 * says, and what each outcome is answered with.
 *
 * The routes beside this file (`dlr/route.ts`, `sms/route.ts`) cannot be
 * imported by a test — they reach `server-only` through `@/lib/db` — so
 * everything that decides anything is here, with the database, the audit
 * writer, the logger and Slack handed in, and the routes are the few lines
 * that read the request and the environment. This file imports types, the
 * recorder's own opt-out reader, the constant-time compare and the
 * notification builders, relatively, and nothing that reads the environment.
 *
 * ## The formats are not public
 *
 * DoveSoft documents its send API (via MoEngage's partner guide: a DLR
 * carries `messageid`, `errorstatus` — `DELIVRD` is delivered — and
 * `errorreason`), and nothing about how it PUSHES a delivery report or an
 * inbound text. So both routes accept a query string, a form body or a JSON
 * object, and read each field from a short list of the names gateways use.
 * A new name is one string in its list. What they never do is guess: a
 * payload missing the fields that matter is refused with a 400 so DoveSoft
 * retries, audited (when the deployment names its org) and logged at error —
 * with the field NAMES it did carry, so the list can be fixed in one line,
 * and never a value, a number or the words. An inbound text that cannot be
 * read might have been a STOP, and a STOP must never be answered 200 and
 * dropped.
 */

/** The most either route reads. A delivery report is a few hundred bytes; a long text, a few kilobytes. */
export const DOVESOFT_MAX_BODY_BYTES = 16_384

/** The longest text handed to the recorder: ten concatenated segments' worth, and more. */
const MAX_TEXT_CHARS = 5_000

// ---------------------------------------------------------------------------
// Who may post
// ---------------------------------------------------------------------------

export type DoveSoftAuth = { readonly ok: true } | { readonly ok: false; readonly status: 503 | 401; readonly error: string }

/**
 * Where a token may arrive. `query` is the `token` parameter as a form
 * decoder reads it — `+` is a space — and `queryRaw` the same value
 * percent-decoded with `+` left alone; see `tokenFrom`.
 */
export interface GivenToken {
  readonly query: string | null
  readonly queryRaw?: string | null
  readonly header: string | null
}

/**
 * The shared secret, from the `token` query parameter — DoveSoft may not send
 * custom headers — or the `x-dovesoft-token` header. Unset means every request
 * is refused (503): an open inbound-text route would let anyone pause a
 * contact or write a suppression. Every candidate is compared, each in
 * constant time, whichever matches. Never logged.
 */
export function authoriseDoveSoft(secret: string | undefined, given: GivenToken): DoveSoftAuth {
  if (!secret) return { ok: false, status: 503, error: 'DoveSoft webhooks are not configured' }
  const matched = [given.header, given.query, given.queryRaw ?? null].map((candidate) => secretMatches(secret, candidate))
  if (matched.some(Boolean)) return { ok: true }
  return { ok: false, status: 401, error: 'unauthorized' }
}

/**
 * The places a token may arrive, read off a request. Never logged.
 *
 * The query value is read twice, because `URLSearchParams` is a FORM
 * decoder and reads `+` as a space. About half of all `openssl rand -base64
 * 32` secrets contain a `+`, and one pasted raw into `?token=` — which is
 * what the registration instructions asked for — never matched: every push,
 * every STOP, was a 401. `queryRaw` is the value percent-decoded with
 * `decodeURIComponent`, which leaves `+` alone, so a raw secret and a
 * percent-encoded one both match.
 */
export function tokenFrom(request: Request): GivenToken {
  const url = new URL(request.url)
  return {
    query: url.searchParams.get('token'),
    queryRaw: rawQueryValue(url.search, 'token'),
    header: request.headers.get('x-dovesoft-token'),
  }
}

/**
 * The first `name=` value of a query string, percent-decoded without reading
 * `+` as a space; null when it is absent or its escapes do not decode.
 */
export function rawQueryValue(search: string, name: string): string | null {
  for (const part of search.replace(/^\?/, '').split('&')) {
    const eq = part.indexOf('=')
    if ((eq < 0 ? part : part.slice(0, eq)) !== name) continue
    try {
      return decodeURIComponent(eq < 0 ? '' : part.slice(eq + 1))
    } catch {
      return null
    }
  }
  return null
}

/** The routes whose refusals are logged, once each. */
export type DoveSoftRoute = 'dlr' | 'sms'

const REFUSALS_LOGGED = new Set<DoveSoftRoute>()

/**
 * One error line the first time a route refuses a token in this process —
 * the route's name and nothing else, never what was sent. A 401 used to be
 * silent, so a secret DoveSoft held wrongly (a `+` read as a space) refused
 * every push, STOPs included, with nothing in any log to say so. Once per
 * process per route, because anybody on the internet can send a wrong token
 * and a line per request would bury the one that matters.
 */
export function logRefusalOnce(
  route: DoveSoftRoute,
  auth: DoveSoftAuth,
  log: WebhookLog,
  logged: Set<DoveSoftRoute> = REFUSALS_LOGGED,
): void {
  if (auth.ok || auth.status !== 401 || logged.has(route)) return
  logged.add(route)
  log.error(
    'DoveSoft webhook refused a request whose token did not match DOVESOFT_WEBHOOK_SECRET — if DoveSoft sent it, ' +
      'every push to this route is being refused: check the secret it was registered with (in a URL it must be ' +
      'percent-encoded). Logged once per process.',
    { route },
  )
}

// ---------------------------------------------------------------------------
// What a payload says
// ---------------------------------------------------------------------------

/** A payload's fields, keyed lower-case. The `token` is never among them. */
export type Fields = ReadonlyMap<string, string>

/**
 * A payload's fields, or why there are none: a body that was neither a form
 * nor a JSON object, or one larger than these routes read.
 */
export type FieldsRead =
  | { readonly ok: true; readonly fields: Fields }
  | { readonly ok: false; readonly why: 'unreadable_body' | 'too_large' }

/**
 * The query string and the body, as one map: the body's value wins where
 * both carry a name. A JSON body must be one object of plain values; a form
 * body is `application/x-www-form-urlencoded`. A body that is neither — bad
 * JSON, a JSON array, multipart — is unreadable, and so is the whole
 * request: half a payload is not read as if it were all of it.
 */
export function readFields(input: {
  readonly query: URLSearchParams
  readonly contentType: string | null
  readonly body: string
}): FieldsRead {
  const out = new Map<string, string>()
  const put = (key: string, value: string): void => {
    const k = key.trim().toLowerCase()
    if (!k || k === 'token') return
    out.set(k, value)
  }
  for (const [k, v] of input.query) put(k, v)

  const body = input.body.trim()
  if (!body) return { ok: true, fields: out }
  const type = (input.contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const looksJson = type === 'application/json' || type.endsWith('+json') || (!type && body.startsWith('{'))
  if (looksJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { ok: false, why: 'unreadable_body' }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, why: 'unreadable_body' }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') put(k, v)
      else if (typeof v === 'number' || typeof v === 'boolean') put(k, String(v))
    }
    return { ok: true, fields: out }
  }
  if (type === 'application/x-www-form-urlencoded' || ((!type || type === 'text/plain') && body.includes('='))) {
    for (const [k, v] of new URLSearchParams(body)) put(k, v)
    return { ok: true, fields: out }
  }
  return { ok: false, why: 'unreadable_body' }
}

export interface RequestRead {
  readonly read: FieldsRead
  readonly shape: RequestShape
}

/**
 * A request's fields, bounded: a declared or actual body over
 * `DOVESOFT_MAX_BODY_BYTES` is not parsed, and is answered 413 by the
 * handler — loudly, like any push that cannot be read. A GET's fields are
 * its query string.
 */
export async function readDoveSoftRequest(request: Request): Promise<RequestRead> {
  const contentType = request.headers.get('content-type')
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > DOVESOFT_MAX_BODY_BYTES) {
    return { read: { ok: false, why: 'too_large' }, shape: { bytes: declared, contentType } }
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text()
  const bytes = new TextEncoder().encode(body).length
  if (bytes > DOVESOFT_MAX_BODY_BYTES) return { read: { ok: false, why: 'too_large' }, shape: { bytes, contentType } }
  return {
    read: readFields({ query: new URL(request.url).searchParams, contentType, body }),
    shape: { bytes, contentType },
  }
}

/** The first of `names` the payload carries — present, even if blank — or null. */
function first(fields: Fields, names: readonly string[]): string | null {
  for (const name of names) {
    const v = fields.get(name)
    if (v !== undefined) return v
  }
  return null
}

/** The names a payload carried, for the log line that says it could not be read. Names only, bounded. */
export function fieldNames(fields: Fields): string[] {
  return [...fields.keys()].filter((k) => /^[a-z0-9_.-]{1,40}$/.test(k)).slice(0, 25)
}

// --- Delivery reports ------------------------------------------------------

/** The message id DoveSoft returned when it accepted the SMS. */
export const DLR_ID_FIELDS = ['messageid', 'msgid'] as const
/** The operator's word for what happened. MoEngage's guide names `errorstatus`. */
export const DLR_STATUS_FIELDS = ['errorstatus', 'status'] as const
/** The operator's reason, for a failure. */
export const DLR_REASON_FIELDS = ['errorreason'] as const

/**
 * The words that mean delivered: SMPP's receipt state `DELIVRD` (MoEngage's
 * guide: "DELIVRD = delivered") and its spelled-out form — SMPP's own
 * message-state name, `DELIVERED`, which a gateway may report in place of
 * the abbreviation, as FAILED_WORDS already took spelled-out failures. A
 * report saying "Delivered" was stored as pending.
 */
export const DELIVERED_WORDS: ReadonlySet<string> = new Set(['delivrd', 'delivered'])
/**
 * The final words that mean it was not, and will not be, delivered: SMPP's
 * own message states (UNDELIV, EXPIRED, DELETED, REJECTD) and their spelled
 * out forms. Anything else — ENROUTE, ACCEPTD, UNKNOWN, a word nobody listed —
 * is `pending`, which claims nothing and lets a later final word land.
 */
export const FAILED_WORDS: ReadonlySet<string> = new Set([
  'undeliv', 'undelivered', 'undeliverable', 'expired', 'deleted', 'rejectd', 'rejected', 'failed', 'failure',
])

export type DlrRead =
  | {
      readonly ok: true
      readonly providerMessageId: string
      readonly status: SmsDeliveryStatus
      readonly reason: string | null
    }
  | { readonly ok: false; readonly missing: readonly ('messageid' | 'status')[] }

/**
 * A delivery report, or which of its two required fields was not there.
 *
 * No time is read from it. DoveSoft's push format is not public, and a time
 * with no zone ("2026-10-01 10:00:00", SMPP's `done date`) would be a guess
 * of five and a half hours either way — so `delivered_at` is when the report
 * reached this deployment, and the company page says "Delivery reported"
 * beside it (`lib/delivery-view.ts`), never "delivered at".
 */
export function readDlr(fields: Fields): DlrRead {
  const id = (first(fields, DLR_ID_FIELDS) ?? '').trim()
  const word = (first(fields, DLR_STATUS_FIELDS) ?? '').trim()
  const missing: ('messageid' | 'status')[] = []
  if (!id) missing.push('messageid')
  if (!word) missing.push('status')
  if (missing.length > 0) return { ok: false, missing }
  const w = word.toLowerCase()
  const status: SmsDeliveryStatus = DELIVERED_WORDS.has(w) ? 'delivered' : FAILED_WORDS.has(w) ? 'failed' : 'pending'
  const reason = (first(fields, DLR_REASON_FIELDS) ?? '').trim()
  return {
    ok: true,
    providerMessageId: id,
    status,
    // A failure with no reason of its own still says what the operator said.
    reason: status === 'failed' ? reason || word : null,
  }
}

// --- Inbound texts ---------------------------------------------------------

/** The number the text came from. */
export const MO_FROM_FIELDS = ['mobile', 'from', 'sender', 'msisdn'] as const
/** The words. */
export const MO_TEXT_FIELDS = ['message', 'text', 'sms', 'content'] as const
/** The agency's own number it was sent to — accepted, never used to match. */
export const MO_TO_FIELDS = ['to', 'longcode', 'vmn', 'shortcode'] as const
/** DoveSoft's id for the text, which makes a retried push a duplicate. */
export const MO_ID_FIELDS = ['messageid', 'msgid', 'id'] as const
/** When it arrived (read only when it names its zone, or is an epoch). */
export const MO_TIME_FIELDS = ['receivedat', 'time'] as const

/**
 * The sender as the recorder reads it, which is E.164 only (`normalisePhone`
 * guesses no country). A number written with `+` or `00` is passed as it is.
 * One bare form is read, because it is unambiguous: `91` and a ten-digit
 * Indian mobile number starting 6–9 — twelve digits no Indian national
 * number has — which is how Indian gateways write a sender. Anything else is
 * passed as it came, and the recorder calls it unreadable: loudly for a STOP,
 * never by assigning it a country.
 */
export function readSender(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/[\s-]/g, '')
  return /^91[6-9]\d{9}$/.test(digits) ? `+${digits}` : trimmed
}

/**
 * When the text arrived, or null — and then the recorder uses the time it
 * was received here. Only forms that cannot be misread are taken: an ISO
 * instant carrying `Z` or an offset, or a Unix epoch in seconds or
 * milliseconds. "2026-10-01 10:00:00" names no zone; reading it as UTC would
 * move an Indian text five and a half hours. Never in the future.
 */
export function readReceivedAt(raw: string | null, now: Date): Date | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  let at: Date | null = null
  if (/^\d{10}$/.test(v)) at = new Date(Number(v) * 1000)
  else if (/^\d{13}$/.test(v)) at = new Date(Number(v))
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v)) at = new Date(v)
  if (!at || Number.isNaN(at.getTime())) return null
  return at.getTime() > now.getTime() + 5 * 60_000 ? null : at
}

export type MoRead =
  | {
      readonly ok: true
      readonly from: string
      readonly text: string
      readonly to: string | null
      readonly providerMessageId: string | null
      readonly receivedAt: Date | null
    }
  | { readonly ok: false; readonly missing: readonly ('from' | 'text')[] }

/**
 * An inbound text, or which of its two required fields was not there. A
 * present but empty text is read — an empty SMS can happen, and it is not a
 * STOP — but an absent one is not: the words might be under a name this
 * list does not know yet.
 */
export function readMo(fields: Fields, now: Date): MoRead {
  const from = (first(fields, MO_FROM_FIELDS) ?? '').trim()
  const text = first(fields, MO_TEXT_FIELDS)
  const missing: ('from' | 'text')[] = []
  if (!from) missing.push('from')
  if (text === null) missing.push('text')
  if (missing.length > 0 || text === null) return { ok: false, missing }
  return {
    ok: true,
    from: readSender(from),
    text: withoutNul(text).slice(0, MAX_TEXT_CHARS),
    to: first(fields, MO_TO_FIELDS)?.trim() || null,
    providerMessageId: withoutNul(first(fields, MO_ID_FIELDS) ?? '').trim() || null,
    receivedAt: readReceivedAt(first(fields, MO_TIME_FIELDS), now),
  }
}

/**
 * U+0000 as U+FFFD. Some SMPP gateways decode GSM-7's `@` (0x00) as NUL,
 * Postgres refuses NUL in text, and so every retry of such a push failed and
 * a STOP sent that way was recorded nowhere. `recordInboundSms` does the
 * same, for a caller that is not this route.
 */
function withoutNul(s: string): string {
  return s.replace(/\u0000/g, '\uFFFD')
}

/**
 * The CLASS of a fault, for a log line: drizzle's own message quotes every
 * bound parameter — the number and the words — and Next `console.error`s an
 * escaping Error whole, past `redact()`. So a fault is caught where it is
 * thrown and only its name goes anywhere.
 */
function faultName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError'
}

// ---------------------------------------------------------------------------
// What each outcome is answered with
// ---------------------------------------------------------------------------

export interface WebhookLog {
  error(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

/** What a handler needs from the world: the route builds these from the database, `env()` and Slack. */
export interface DoveSoftDeps {
  /** `DOVESOFT_ORG_ID`, or null: where an unreadable push is audited, and the recorders' fallback org. */
  readonly orgId: string | null
  readonly audit: (entry: {
    readonly orgId: string
    readonly actor: 'system'
    readonly action: string
    /** A contact only for a STOP whose recording threw, when the recorder had said whose it was. */
    readonly subjectType: 'contact' | null
    readonly subjectId: string | null
    readonly detail: Record<string, unknown>
  }) => Promise<void>
  readonly log: WebhookLog
}

export interface WebhookAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** The request's own shape, for the log line: how big, what type, which names. Never a value. */
export interface RequestShape {
  readonly bytes: number
  readonly contentType: string | null
}

/**
 * The unreadable push's audit row, in the deployment's org — or nowhere, when
 * none is named, and the error line is then the only record. Never throws: the
 * 400 is the answer whether or not the row could be written.
 */
async function auditQuietly(
  deps: DoveSoftDeps,
  row: { readonly action: string; readonly detail: Record<string, unknown> },
): Promise<boolean> {
  if (!deps.orgId) return false
  try {
    await deps.audit({ orgId: deps.orgId, actor: 'system', subjectType: null, subjectId: null, ...row })
    return true
  } catch {
    return false
  }
}

const shapeOf = (shape: RequestShape): Record<string, unknown> => ({
  bytes: shape.bytes,
  contentType: (shape.contentType ?? '').split(';')[0]!.trim().slice(0, 60) || null,
})

/**
 * A delivery report. Read → recorded through `recordSmsDelivery` and answered
 * 200, matched or not: "no SMS this system sent has that id" is the answer
 * to a delivery, and a retry would never match either. Unreadable → 400 so
 * DoveSoft retries, `sms.dlr_unreadable` in the deployment's org, and an
 * error line with the field names and no payload. A fault while recording →
 * 500 so DoveSoft retries, and an error line naming the fault's class only.
 */
export async function handleDoveSoftDlr(
  read: FieldsRead,
  shape: RequestShape,
  deps: DoveSoftDeps & {
    readonly record: (args: {
      readonly providerMessageId: string
      readonly status: SmsDeliveryStatus
      readonly reason: string | null
      readonly orgId: string | null
    }) => Promise<SmsDeliveryOutcome>
  },
): Promise<WebhookAnswer> {
  const dlr = read.ok ? readDlr(read.fields) : null
  if (!dlr || !dlr.ok) {
    const detail = dlr ? { why: 'missing_fields', missing: [...dlr.missing] } : { why: read.ok ? 'unreadable_body' : read.why }
    const audited = await auditQuietly(deps, { action: 'sms.dlr_unreadable', detail })
    deps.log.error('DoveSoft delivery report could not be read', {
      ...detail,
      ...shapeOf(shape),
      fields: read.ok ? fieldNames(read.fields) : null,
      audited,
    })
    return { status: detail.why === 'too_large' ? 413 : 400, body: { error: 'unreadable delivery report', ...detail } }
  }
  let outcome: SmsDeliveryOutcome
  try {
    outcome = await deps.record({
      providerMessageId: dlr.providerMessageId,
      status: dlr.status,
      reason: dlr.reason,
      orgId: deps.orgId,
    })
  } catch (err) {
    deps.log.error('DoveSoft delivery report could not be recorded; it was refused so DoveSoft retries', {
      error: faultName(err),
      status: dlr.status,
    })
    return { status: 500, body: { error: 'delivery report not recorded' } }
  }
  if (!outcome.matched && !deps.orgId) {
    // The recorder had no org to audit it in; this line is the only record.
    deps.log.warn('DoveSoft delivery report matched no SMS, and DOVESOFT_ORG_ID is not set to file it under', {
      why: outcome.why,
      status: dlr.status,
    })
  }
  return {
    status: 200,
    body: outcome.matched
      ? { matched: true, changed: outcome.changed, deliveryStatus: outcome.deliveryStatus }
      : { matched: false, why: outcome.why },
  }
}

/**
 * A text a contact sent back. Read → `recordInboundSms`, the one recorder,
 * which decides what the words mean — a reply, a pause, a STOP and its
 * suppression — and the answer depends on what it did:
 *
 *  - filed under a contact: 200, because the inbound row is written first
 *    and a retry is a duplicate that records nothing more. If it asked to
 *    stop and the suppression could not be written, the `opt_out_not_recorded`
 *    alarm is AWAITED first (never `after()`, which a host without
 *    `waitUntil` drops) — one per org where it failed (`smsOptOutAlarms`,
 *    review round 6): the filed contact's own in place of the ordinary
 *    reply notice, and one for each OTHER org holding the number whose
 *    suppression failed, beside the notice, which stays when the filed
 *    contact's own was written;
 *  - a number that could not be read: 400, so DoveSoft retries and the
 *    error log repeats until somebody looks — the recorder has already
 *    audited it, and taken the loud path if it was a STOP;
 *  - a STOP from a number no single contact holds whose suppression could
 *    not be written: 500, because nothing was written for it and a retry
 *    re-attempts the suppression. The recorder's `contact.opt_out_not_recorded`
 *    row and the error line are the record, and /compliance counts it;
 *
 *  and for both of those, when the text was a STOP that nobody recorded,
 *  the `opt_out_not_recorded` alarm is AWAITED before the answer, with no
 *  touch (there is no message row), one in each org where it failed —
 *  naming a contact there who holds the number, or nobody in the org a
 *  number no contact holds is filed under (`DOVESOFT_ORG_ID`). With no org
 *  at all it cannot be filed, and the error line says `alarm:
 *  'not_raised_no_org'`. Each delivery that fails again raises it again, as
 *  it writes the audit row again;
 *  - anything else it filed under nobody: 200, the answer to a delivery.
 *
 * Unreadable (no sender or no words) → 400, `sms.inbound_unreadable` in the
 * deployment's org, and an error line that says it may have been a STOP.
 *
 * A fault while recording — a dropped connection, a timeout — → 500 so
 * DoveSoft retries, with nothing recorded (`recordInboundReply` is one
 * transaction). It is caught HERE: drizzle's error quotes every bound
 * parameter, the number and the words, and Next logs an escaping error
 * whole. The error line names the fault's class only. And when the words
 * asked to stop (`smsTextAsksToStop`, the recorder's own reader) the loud
 * path runs. Whose it was comes from the recorder itself (review round 6):
 * its rolled-back line names the org and the contact it was filing under
 * (`keepingRolledBackSmsOptOut`), so nothing is read again from a database
 * that just failed — and then the `contact.opt_out_not_recorded` row is
 * written under that contact in THEIR org (what /compliance, the digest
 * and /inbox read), they are paused saying so, best-effort, and the AWAITED
 * alarm names them. Only a fault before the recorder named anybody — the
 * duplicate check, the match, the hold — takes the subject-less path: the
 * row and the alarm under `DOVESOFT_ORG_ID`, with no contact, because
 * nothing says whose it was. It used to take that path always, so a known
 * contact's STOP was alarmed as "nothing in the app holds the number" and
 * audited in an org that was not theirs, or nowhere.
 */
export async function handleDoveSoftMo(
  read: FieldsRead,
  shape: RequestShape,
  now: Date,
  deps: DoveSoftDeps & {
    readonly record: (args: {
      readonly from: string
      readonly to: string | null
      readonly text: string
      readonly providerMessageId: string | null
      readonly receivedAt?: Date
      readonly orgId: string | null
      readonly log: InboundLog
    }) => Promise<InboundSmsOutcome>
    /** Awaited: the opt-out alarm. Bounded and never throws (`notify`). */
    readonly alarm: (event: NotificationEvent) => Promise<void>
    /** Scheduled after the answer: the ordinary reply notice. May throw where the host cannot schedule. */
    readonly later: (event: NotificationEvent) => void
    /**
     * Pause a contact OVER any earlier reason (`pauseContactOverriding`):
     * for a STOP whose recording threw, once the recorder has said whose it
     * was. Best-effort — the database just failed — and a throw is caught.
     */
    readonly pause: (args: { readonly orgId: string; readonly contactId: string; readonly reason: string; readonly now: Date }) => Promise<unknown>
  },
): Promise<WebhookAnswer> {
  const mo = read.ok ? readMo(read.fields, now) : null
  if (!mo || !mo.ok) {
    const detail = mo ? { why: 'missing_fields', missing: [...mo.missing] } : { why: read.ok ? 'unreadable_body' : read.why }
    const audited = await auditQuietly(deps, { action: 'sms.inbound_unreadable', detail })
    deps.log.error('DoveSoft inbound text could not be read — it may have been a STOP; nothing was recorded', {
      ...detail,
      ...shapeOf(shape),
      fields: read.ok ? fieldNames(read.fields) : null,
      audited,
    })
    return { status: detail.why === 'too_large' ? 413 : 400, body: { error: 'unreadable inbound text', ...detail } }
  }

  let outcome: InboundSmsOutcome
  const recorder = keepingRolledBackSmsOptOut({ error: (message, fields) => deps.log.error(message, { ...fields }) })
  try {
    outcome = await deps.record({
      from: mo.from,
      to: mo.to,
      text: mo.text,
      providerMessageId: mo.providerMessageId,
      ...(mo.receivedAt ? { receivedAt: mo.receivedAt } : {}),
      orgId: deps.orgId,
      log: recorder,
    })
  } catch (err) {
    return moNotRecorded(smsTextAsksToStop(mo.text), recorder.rolledBack(), faultName(err), shape, now, deps)
  }

  // One alarm per org where the STOP could not be suppressed, each AWAITED.
  const alarms = smsOptOutAlarms(outcome)
  if (outcome.matched === 'contact') {
    for (const alarm of alarms) await deps.alarm(alarm)
    const event = smsReplyNotification(outcome)
    if (event) {
      try {
        deps.later(event)
      } catch (err) {
        deps.log.warn('reply notification not scheduled', { error: err instanceof Error ? err.name : 'UnknownError' })
      }
    }
    return {
      status: 200,
      body: { matched: 'contact', duplicate: outcome.duplicate, paused: outcome.paused, suppressed: outcome.suppressed },
    }
  }

  // A STOP filed under nobody that could not be suppressed reaches a person
  // as the filed one does: AWAITED, before the answer, in each org where it
  // failed. With no org anywhere — no contact holds the number and the
  // deployment names none — there is nowhere to file the alarm, and the
  // error line says so.
  const alarmed = alarms.length > 0 ? 'raised' : outcome.optOutNotRecorded ? 'not_raised_no_org' : null
  if (outcome.why === 'unreadable_number') {
    deps.log.error('DoveSoft inbound text came from a number that could not be read as E.164; nothing was filed', {
      optOut: outcome.optOut,
      optOutNotRecorded: outcome.optOutNotRecorded,
      ...(alarmed ? { alarm: alarmed } : {}),
      ...shapeOf(shape),
    })
    for (const alarm of alarms) await deps.alarm(alarm)
    return { status: 400, body: { error: 'unreadable sender number', matched: 'none', why: outcome.why } }
  }
  if (outcome.optOutNotRecorded) {
    deps.log.error('OPT-OUT NOT RECORDED — a STOP from a number no single contact holds could not be suppressed', {
      why: outcome.why,
      orgConfigured: deps.orgId !== null,
      alarm: alarmed,
      ...(alarms.length > 1 ? { orgs: alarms.length } : {}),
    })
    for (const alarm of alarms) await deps.alarm(alarm)
    return { status: 500, body: { error: 'opt-out not recorded', matched: 'none', why: outcome.why } }
  }
  return { status: 200, body: { matched: 'none', why: outcome.why, optOut: outcome.optOut, suppressed: outcome.suppressed } }
}

/** What the recorder said about a STOP whose recording it rolled back: ids only. */
export interface RolledBackSmsOptOut {
  readonly orgId: string
  readonly contactId: string
}

/**
 * The line `recordInboundReply` writes when it rolls back a reply that
 * asked to stop. Matched by its own opening words, because the recorder
 * says `OPT-OUT NOT RECORDED` for other reasons too — a suppression that
 * failed in ANOTHER org names that org's contact, and is no evidence of
 * whose text this was.
 */
export const ROLLED_BACK_OPT_OUT_LINE = 'OPT-OUT NOT RECORDED — the reply was rolled back'

/**
 * The recorder's log, forwarded line for line to `forward` — and the last
 * rolled-back line that names an org and a contact, kept: the one line that
 * says whose a STOP was when recording it threw (review round 6). The
 * email route keeps the same line its own way (`../email/fault.ts`); this
 * one is local so the two routes do not share a module two groups edit.
 */
export function keepingRolledBackSmsOptOut(
  forward: InboundLog,
): InboundLog & { readonly rolledBack: () => RolledBackSmsOptOut | null } {
  let kept: RolledBackSmsOptOut | null = null
  return {
    error(message, fields) {
      forward.error(message, fields)
      const orgId = fields?.['orgId']
      const contactId = fields?.['contactId']
      if (message.startsWith(ROLLED_BACK_OPT_OUT_LINE) && typeof orgId === 'string' && typeof contactId === 'string') {
        kept = { orgId, contactId }
      }
    },
    rolledBack: () => kept,
  }
}

/**
 * An inbound text whose recording threw. 500 either way, so DoveSoft
 * retries; a STOP also takes the loud path, because nothing was written for
 * it and a retry may fail the same way — under the contact the recorder
 * was filing it under when it said so (`placed`), and otherwise under
 * nobody, in `DOVESOFT_ORG_ID`.
 */
async function moNotRecorded(
  optOut: boolean,
  placed: RolledBackSmsOptOut | null,
  error: string,
  shape: RequestShape,
  now: Date,
  deps: DoveSoftDeps & {
    readonly alarm: (event: NotificationEvent) => Promise<void>
    readonly pause: (args: { readonly orgId: string; readonly contactId: string; readonly reason: string; readonly now: Date }) => Promise<unknown>
  },
): Promise<WebhookAnswer> {
  if (!optOut) {
    deps.log.error('DoveSoft inbound text could not be recorded; it was refused so DoveSoft retries', { error, ...shapeOf(shape) })
    return { status: 500, body: { error: 'inbound text not recorded' } }
  }
  if (placed) {
    // Their org, their row: what /compliance, the digest and /inbox read.
    let audited = true
    try {
      await deps.audit({
        orgId: placed.orgId,
        actor: 'system',
        action: 'contact.opt_out_not_recorded',
        subjectType: 'contact',
        subjectId: placed.contactId,
        detail: { channel: 'sms', why: 'record_failed' },
      })
    } catch {
      audited = false
    }
    // Paused OVER any earlier reason, as the recorder's own loud path does:
    // left live, their approved text would go on the next tick to the
    // number that just said STOP. Best-effort — the database just failed.
    let paused = true
    try {
      await deps.pause({
        orgId: placed.orgId,
        contactId: placed.contactId,
        reason: `opt-out not recorded: reply ${now.toISOString()} (record_failed)`,
        now,
      })
    } catch {
      paused = false
    }
    deps.log.error('OPT-OUT NOT RECORDED — a text that asked to stop could not be recorded; follow up by hand', {
      error,
      orgId: placed.orgId,
      contactId: placed.contactId,
      audited,
      paused,
      alarm: 'raised',
    })
    // No message row: the reply was rolled back. The contact's record holds
    // the number, so the alarm links /suppressions.
    await deps.alarm({ kind: 'opt_out_not_recorded', orgId: placed.orgId, touchId: null, contactId: placed.contactId, path: 'reply' })
    return { status: 500, body: { error: 'opt-out not recorded' } }
  }
  const audited = await auditQuietly(deps, {
    action: 'contact.opt_out_not_recorded',
    detail: { channel: 'sms', why: 'record_failed' },
  })
  const alarm = smsUnplacedOptOutNotification(deps.orgId)
  deps.log.error('OPT-OUT NOT RECORDED — a text that asked to stop could not be recorded; follow up by hand', {
    error,
    orgConfigured: deps.orgId !== null,
    audited,
    alarm: alarm ? 'raised' : 'not_raised_no_org',
  })
  if (alarm) await deps.alarm(alarm)
  return { status: 500, body: { error: 'opt-out not recorded' } }
}
