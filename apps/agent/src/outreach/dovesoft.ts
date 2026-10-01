/**
 * SMS through DoveSoft: the `MessageProvider` that puts a DLT-registered
 * text on the wire (0019).
 *
 * It decides nothing. `dispatchTouch` has already run every §2.1 rule —
 * opt-in consent for SMS, suppression by the E.164 number, the pause, the
 * template steps (`no_template`, `template_mismatch`), quiet hours and
 * TRAI's promotional band — and hands this the words, the number and the
 * registration the words were checked against. All this does is say them to
 * DoveSoft in the shape its API takes, and refuse, before any request, when
 * it could not say them correctly.
 *
 * ## What is verified, and the one assumption
 *
 * The request is DoveSoft's published one (the MoEngage partner guide,
 * https://www.moengage.com/docs/partner-guide/sms-providers/dove-soft-limited/dove-soft-limited):
 * `POST <base>/api/json/sendsms/` with the `key` header, `senderid`,
 * `unicode`, `entityid` and `tempid` in the query, and
 * `{ "listsms": [{ "sms", "mobiles", "senderid" }] }` as the body. The
 * response is documented only as carrying `messageid`; no example body is
 * published, so `messageIdFrom` reads a top-level `messageid` or the first
 * one inside an array or object, and refuses anything else loudly.
 *
 * The number format `mobiles` expects is NOT documented publicly. The form
 * here — the E.164 digits without the `+` (`919812345678`) — is the common
 * Indian gateway form, and it is the one assumption to confirm with
 * DoveSoft's account manager before a real send (`dovesoftMobile`).
 *
 * ## The key
 *
 * `DOVESOFT_API_KEY` lives in this closure and in one request header. It is
 * never a property of the provider object, never in an error's message or
 * name, never in a log line, and never in an audit row — `dispatchTouch`
 * stores a provider error's MESSAGE on the row and audits its NAME, so both
 * are written here to carry neither the key nor anything DoveSoft said back.
 * A response body is never quoted: it may echo the message, which is a named
 * person's words (§2.3).
 *
 * One attempt, ten seconds. A retry is a person's decision, because a
 * request that timed out may still have been accepted, and a second one
 * would be a second text to somebody who consented to messages, not to
 * duplicates.
 */
import { normalisePhone, type Channel } from '@agency/core'
import type { MessageProvider, MessageTemplateRegistration } from '@agency/db'

/** What the provider needs: both are required, or SMS is off (`doveSoftConfigFrom`). */
export interface DoveSoftConfig {
  readonly apiKey: string
  /** The DLT principal entity id (PE ID): digits. */
  readonly entityId: string
  /** `DOVESOFT_BASE_URL`. A trailing slash is ignored. */
  readonly baseUrl: string
  /** Injectable for tests. */
  readonly fetch?: typeof fetch
  /** One attempt, this long. Ten seconds unless a test says otherwise. */
  readonly timeoutMs?: number
}

export const DOVESOFT_TIMEOUT_MS = 10_000

/** A response bigger than this is not an answer to one text; it is not read. */
const MAX_RESPONSE_CHARS = 64 * 1024

/**
 * Why a send did not reach DoveSoft, or did and was not confirmed.
 *
 *  - `not_configured` — the key or the entity id is missing. Before any request.
 *  - `refused` — the message cannot be said correctly: no registration, a
 *    header that is not a DLT header, a number that is not E.164, no words.
 *    Before any request.
 *  - `unreachable` — no answer: DNS, a reset, or the ten seconds ran out.
 *  - `http` — DoveSoft answered, and not with 2xx.
 *  - `unreadable_response` — a 2xx that names no message id.
 */
export type DoveSoftFailure = 'not_configured' | 'refused' | 'unreachable' | 'http' | 'unreadable_response'

const ERROR_NAMES: Readonly<Record<DoveSoftFailure, string>> = {
  not_configured: 'DoveSoftNotConfiguredError',
  refused: 'DoveSoftRefusedError',
  unreachable: 'DoveSoftUnreachableError',
  http: 'DoveSoftHttpError',
  unreadable_response: 'DoveSoftResponseError',
}

/**
 * A DoveSoft failure: a name the sender logs and the audit row records, an
 * HTTP status where there was one, and a sentence for the row's `error`
 * column. Never the response body, never the key, never the number.
 */
export class DoveSoftError extends Error {
  readonly failure: DoveSoftFailure
  /** The HTTP status DoveSoft answered with; null when it answered nothing. */
  readonly status: number | null

  constructor(failure: DoveSoftFailure, message: string, status: number | null = null) {
    super(message)
    this.name = ERROR_NAMES[failure]
    this.failure = failure
    this.status = status
  }
}

/**
 * The number as DoveSoft's `mobiles` field takes it: the E.164 digits with
 * no `+` — `+919812345678` becomes `919812345678` — or null when the
 * recipient is not a number `normalisePhone` can read.
 *
 * Read through `normalisePhone` first, the same reading the suppression
 * check used, so the number texted is exactly the key that was found clear.
 * A bare national number (`9812345678`) has no country and is refused there,
 * never guessed into India.
 *
 * ASSUMPTION, to confirm with DoveSoft: their public documentation does not
 * say whether `mobiles` takes the country code, a `+`, or neither. This is
 * the common Indian gateway form (country code, no `+`). If DoveSoft wants
 * the ten-digit national number instead, this function is the one place to
 * change, and its test the one to update.
 */
export function dovesoftMobile(recipient: string): string | null {
  const e164 = normalisePhone(recipient)
  return e164 === null ? null : e164.slice(1)
}

/**
 * The GSM 03.38 BASIC character set (3GPP TS 23.038 §6.2.1; the mapping is
 * unicode.org's GSM0338.TXT), every one of the 128 positions except 0x1B,
 * the escape to the extension table, which is not a character.
 */
const GSM7_BASIC = new Set(
  [
    '@£$¥èéùìòÇ\nØø\rÅå',
    'Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ',
    ' !"#¤%&\'()*+,-./',
    '0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§',
    '¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ].join(''),
)

/**
 * `unicode=1` exactly when the text has a character outside the GSM-7 basic
 * set; `0` otherwise.
 *
 * The extension table (`^ { } \ [ ~ ] | €`) counts as OUTSIDE, on purpose.
 * GSM-7 can carry it only through an escape a gateway may or may not apply,
 * and a mangled character in a DLT-registered text is a text the operator
 * may scrub as not matching its template. UCS-2 renders every character;
 * the cost is a shorter segment, which is the safe direction. Read by code
 * point, so an emoji is one character outside the set, not two halves.
 */
export function needsUnicode(text: string): boolean {
  for (const ch of text) if (!GSM7_BASIC.has(ch)) return true
  return false
}

/**
 * DoveSoft's message id from a parsed response, or null.
 *
 * Only a top-level `messageid` is documented. Because no example body is
 * published, the first `messageid` inside an array or an object — breadth
 * first, three levels down at most — is accepted too, which covers a
 * per-number result list. The key is exact: DoveSoft says its parameters are
 * case-sensitive, and a `messageId` is not taken to mean the same thing.
 * A blank, an object or a boolean is not an id.
 */
export function messageIdFrom(payload: unknown): string | null {
  let level: unknown[] = [payload]
  for (let depth = 0; depth < 4 && level.length > 0; depth += 1) {
    const next: unknown[] = []
    for (const node of level) {
      if (Array.isArray(node)) {
        next.push(...node)
        continue
      }
      if (node === null || typeof node !== 'object') continue
      const record = node as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(record, 'messageid')) {
        const id = idText(record['messageid'])
        if (id !== null) return id
      }
      next.push(...Object.values(record))
    }
    level = next
  }
  return null
}

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id !== '' && id.length <= 128 && !/\s/.test(id) ? id : null
}

/**
 * The DLT header shape the operator matches: six upper-case letters or
 * digits — 0019's CHECK on `message_templates.sender_id`, restated here so
 * a registration that somehow is not one never leaves the building.
 */
const DLT_HEADER = /^[A-Z0-9]{6}$/
/** DLT template ids are long digit strings; anything with a space or a URL character is not one. */
const DLT_TEMPLATE_ID = /^[0-9A-Za-z_-]{1,64}$/

/**
 * The provider. SMS only: handed any other channel, `dispatchTouch` refuses
 * the row without touching it, and the sender never picks one up.
 */
export function createDoveSoftProvider(config: DoveSoftConfig): MessageProvider {
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? DOVESOFT_TIMEOUT_MS
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/api/json/sendsms/`
  const channels: readonly Channel[] = ['sms']

  return {
    name: 'dovesoft',
    channels,
    async send(message) {
      // Everything a correct request needs, before there is any request.
      if (!config.apiKey || !config.entityId) {
        throw new DoveSoftError(
          'not_configured',
          'SMS is not configured on the worker: DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID are both needed. Nothing was sent.',
        )
      }
      const template = registrationOrRefuse(message.template)
      const mobile = dovesoftMobile(message.to)
      if (mobile === null) {
        throw new DoveSoftError('refused', 'The recipient is not an E.164 number. Nothing was sent.')
      }
      if (!message.body || message.body.trim() === '') {
        throw new DoveSoftError('refused', 'The message has no words. Nothing was sent.')
      }

      const url = new URL(endpoint)
      url.searchParams.set('senderid', template.senderId)
      url.searchParams.set('unicode', needsUnicode(message.body) ? '1' : '0')
      url.searchParams.set('entityid', config.entityId)
      url.searchParams.set('tempid', template.externalId)

      let res: Response
      let text: string
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { key: config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ listsms: [{ sms: message.body, mobiles: mobile, senderid: template.senderId }] }),
          signal: AbortSignal.timeout(timeoutMs),
          // A redirect would carry the `key` header to wherever it points —
          // fetch strips only Authorization across origins — so one is a
          // failure, not a hop.
          redirect: 'error',
        })
        text = await res.text()
      } catch (err) {
        // No cause attached: a fetch error's own message is not ours to
        // vouch for, and the row's `error` column is read by people.
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        throw new DoveSoftError(
          'unreachable',
          timedOut
            ? `DoveSoft did not answer within ${Math.round(timeoutMs / 1000)} seconds. The text may or may not have been accepted — check the DoveSoft console before it is sent again.`
            : 'DoveSoft could not be reached. The text may or may not have been accepted — check the DoveSoft console before it is sent again.',
        )
      }

      if (!res.ok) {
        throw new DoveSoftError(
          'http',
          `DoveSoft answered HTTP ${res.status}; the text was not confirmed as accepted. Check the DoveSoft console before it is sent again.`,
          res.status,
        )
      }

      let parsed: unknown = undefined
      if (text.length <= MAX_RESPONSE_CHARS) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
      }
      const providerId = messageIdFrom(parsed)
      if (providerId === null) {
        throw new DoveSoftError(
          'unreadable_response',
          `DoveSoft answered HTTP ${res.status} without a message id this worker can read; the text was not confirmed as accepted. Check the DoveSoft console before it is sent again.`,
          res.status,
        )
      }
      return { providerId }
    },
  }
}

/**
 * The registration, or a refusal. `dispatchTouch` reads it from the row and
 * refuses `no_template` without one, so a miss here is a direct caller that
 * skipped the send path — and a DLT text with no `tempid` is one the
 * operator scrubs, after it has been paid for.
 */
function registrationOrRefuse(template: MessageTemplateRegistration | undefined): MessageTemplateRegistration {
  if (!template) {
    throw new DoveSoftError('refused', 'The text names no registered DLT template. Nothing was sent.')
  }
  if (!DLT_HEADER.test(template.senderId)) {
    throw new DoveSoftError('refused', 'The template’s sender id is not a six-character DLT header. Nothing was sent.')
  }
  if (!DLT_TEMPLATE_ID.test(template.externalId)) {
    throw new DoveSoftError('refused', 'The template’s DLT id is not one DoveSoft can be told. Nothing was sent.')
  }
  return template
}

/**
 * The provider's configuration from the environment, or why there is none.
 *
 * Both the key and the entity id, or nothing: a key with no entity id would
 * send texts the operator scrubs for a missing PE ID, and an entity id with
 * no key sends nothing at all. `missing` names VARIABLES, never a value
 * (§2.3), for the boot log.
 */
export function doveSoftConfigFrom(env: {
  readonly DOVESOFT_API_KEY?: string | undefined
  readonly DOVESOFT_ENTITY_ID?: string | undefined
  readonly DOVESOFT_BASE_URL: string
}): { readonly on: true; readonly config: DoveSoftConfig } | { readonly on: false; readonly missing: readonly string[] } {
  const apiKey = env.DOVESOFT_API_KEY
  const entityId = env.DOVESOFT_ENTITY_ID
  if (!apiKey || !entityId) {
    return {
      on: false,
      missing: [...(apiKey ? [] : ['DOVESOFT_API_KEY']), ...(entityId ? [] : ['DOVESOFT_ENTITY_ID'])],
    }
  }
  return { on: true, config: { apiKey, entityId, baseUrl: env.DOVESOFT_BASE_URL } }
}
