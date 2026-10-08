/**
 * What an inbound mail says about ITSELF, read from its headers and its
 * delivery-status part — never from the words a person wrote.
 *
 * Two readers, both pure:
 *
 *  - **An automatic answer** (RFC 3834). An out-of-office is not a reply:
 *    nobody read the message, so nothing about the conversation changed, and
 *    pausing the contact and moving their deal to `replied` on the strength
 *    of one would stop a sequence for a person who has not answered yet. The
 *    mail says it is automatic in `Auto-Submitted` (any value but `no`), in
 *    `Precedence: bulk | junk | list | auto_reply`, or in the vendor headers
 *    autoresponders add (`X-Auto-Response-Suppress`, `X-Autoreply`,
 *    `X-Autorespond`).
 *  - **A bounce** (RFC 3464, RFC 3463). A `message/delivery-status` part
 *    whose `Action:` is `failed`, with the enhanced status code deciding
 *    permanent (`5.x.x`) from transient (`4.x.x`), and `Final-Recipient`
 *    naming the address that failed. The status is the EVIDENCE for the mark
 *    it produces (§2.2), and it is stored as the DSN gave it.
 *
 * ## What neither reader does
 *
 * It never looks at the body. "I am out of the office" in the text is a
 * guess about what the mail is; `Auto-Submitted: auto-replied` is the mail
 * saying so. The body regex in `classifyReply` stays exactly what it was — a
 * sorting hint that decides the inbox's reading order and nothing else — and
 * without headers every inbound path behaves as it did before this file.
 *
 * And neither reader decides an OPT-OUT. That is `looksLikeOptOut` in the
 * send path, over the person's own words, and it runs FIRST on every inbound
 * (packages/db/src/outreach.ts): an out-of-office whose first line says
 * "unsubscribe" is an opt-out that happens to be automatic, and it is
 * suppressed, not filed as an auto-reply.
 *
 * ## The one body reader here, and the one thing it may decide
 *
 * `mentionsRemovalOrDeparture` DOES read the body — the person's own words,
 * above any quote — and it is deliberately broad where `looksLikeOptOut` is
 * deliberately narrow, because the two guard opposite mistakes. The narrow
 * reader writes a SUPPRESSION, the strongest thing this system does, so its
 * bar is a clear statement. The broad one decides only whether an automatic
 * mail may skip the PAUSE: a header saying "automatic" is not permission to
 * keep writing to somebody whose out-of-office says "I have left — remove me
 * from your list". Found by review — before, every such mail skipped the
 * pause whenever the narrow reader missed it. A hit costs a pause, which is
 * what every inbound did before auto-replies were read at all; a miss would
 * cost a follow-up to somebody who asked to be taken off. It never writes a
 * suppression, and nothing else reads it.
 *
 * ## What a signal is NOT evidence of
 *
 * Anyone who can send mail to the agency's inbox can write these headers and
 * this part. A DSN naming a contact is therefore a claim, not a fact, until
 * the send path ties it to a message THIS SYSTEM SENT — which is done where
 * the database is (`handleInboundEmail`), by the Message-ID of the returned
 * message. This file only reads; it never decides who a bounce is about.
 */

/**
 * The header names the readers consult, lower-case. A caller that can only
 * pass a few headers (a webhook body, the IMAP parser) passes these; a caller
 * with the whole map may pass it all — the readers fold names themselves and
 * ignore everything else.
 */
export const MAIL_SIGNAL_HEADERS = [
  'auto-submitted',
  'precedence',
  'x-auto-response-suppress',
  'x-autoreply',
  'x-autorespond',
  'content-type',
  'x-failed-recipients',
] as const

/** Bounds on what an inbound path hands the readers (the webhook's body). */
export const MAIL_SIGNAL_LIMITS = {
  /** Characters kept of one header's value. */
  headerChars: 2_000,
  /** Characters kept of a delivery-status part. The fields are at its start. */
  dsnChars: 20_000,
} as const

export type MailSignal =
  | {
      readonly kind: 'auto_reply'
      /** Which header said so, lower-case — for a log line, never a decision. */
      readonly header: string
    }
  | {
      readonly kind: 'bounce'
      /**
       * True for a `5.x.x` status: the receiving server will not take mail
       * for this address, and retrying will not change that. `x.2.2`
       * (mailbox full) is the one exception RFC 3463 names — "should be used
       * as a persistent transient failure" — so a full mailbox is transient
       * whatever its class digit says: a full inbox is not a bad address.
       */
      readonly permanent: boolean
      /** The RFC 3463 code exactly as the DSN gave it, e.g. `5.1.1`. */
      readonly status: string
      /** `Final-Recipient`, else `X-Failed-Recipients`' first address; null when neither names one. */
      readonly recipient: string | null
      /** `Original-Recipient`, when the DSN carries it (an alias the server expanded). */
      readonly originalRecipient: string | null
      /** `Original-Message-ID` / `X-Original-Message-ID`, when the reporting MTA adds one. */
      readonly originalMessageId: string | null
    }

export interface DsnFields {
  /** Lower-case: `failed`, `delayed`, `delivered`, `relayed`, `expanded`. */
  readonly action: string | null
  /** An RFC 3463 code (`class.subject.detail`), or null when absent or malformed. */
  readonly status: string | null
  readonly finalRecipient: string | null
  readonly originalRecipient: string | null
  readonly originalMessageId: string | null
}

const STATUS = /^([245])\.(\d{1,3})\.(\d{1,3})(?![\d.])/

/**
 * The fields of a `message/delivery-status` part (RFC 3464 §2).
 *
 * The part is one group of per-message fields and then one group per
 * recipient, separated by blank lines, each field `Name: value` with
 * continuation lines folded. Every message this system sends has ONE
 * recipient, so the recipient block read is the first whose `Action:` is
 * `failed` — or, failing that, the first with any action — and its fields
 * are returned. Anything unreadable is null rather than guessed.
 */
export function parseDsn(text: string): DsnFields {
  const empty: DsnFields = {
    action: null, status: null, finalRecipient: null, originalRecipient: null, originalMessageId: null,
  }
  if (!text) return empty

  // Unfold (a line starting with whitespace continues the one above), then
  // split into groups on blank lines.
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const groups: Map<string, string>[] = []
  let current = new Map<string, string>()
  let lastName: string | null = null
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.size > 0) groups.push(current)
      current = new Map()
      lastName = null
      continue
    }
    if (/^[ \t]/.test(line) && lastName !== null) {
      current.set(lastName, `${current.get(lastName) ?? ''} ${line.trim()}`)
      continue
    }
    const m = /^([A-Za-z0-9-]+)[ \t]*:(.*)$/.exec(line)
    if (!m) {
      lastName = null
      continue
    }
    const name = m[1]!.toLowerCase()
    // The first occurrence wins, like every other header reader here.
    if (!current.has(name)) current.set(name, m[2]!.trim())
    lastName = name
  }
  if (current.size > 0) groups.push(current)

  const blocks = groups.filter((g) => g.has('action'))
  const block = blocks.find((g) => token(g.get('action')) === 'failed') ?? blocks[0]
  const messageId = groups
    .map((g) => g.get('original-message-id') ?? g.get('x-original-message-id'))
    .find((v) => v !== undefined)

  if (!block) return { ...empty, originalMessageId: messageIdOf(messageId) }
  const status = STATUS.exec(block.get('status') ?? '')
  return {
    action: token(block.get('action')) || null,
    status: status ? `${status[1]}.${status[2]}.${status[3]}` : null,
    finalRecipient: addressOf(block.get('final-recipient')),
    originalRecipient: addressOf(block.get('original-recipient')),
    originalMessageId: messageIdOf(messageId),
  }
}

/**
 * What this mail says about itself, or null when it says nothing.
 *
 * A bounce is read first: a DSN is also an automatic message, and most MTAs
 * mark it `Auto-Submitted: auto-replied`, but what it MEANS is that an
 * address failed. A delivery report that is not a failure (`delayed`,
 * `delivered`) is not a bounce; its headers are then read like any mail's.
 */
export function readMailSignals(mail: {
  readonly headers?: Readonly<Record<string, string>> | null
  readonly dsn?: string | null
}): MailSignal | null {
  const headers = foldHeaders(mail.headers)

  if (mail.dsn) {
    const dsn = parseDsn(mail.dsn)
    if (dsn.action === 'failed' && dsn.status !== null) {
      const [cls, subject, detail] = dsn.status.split('.')
      const mailboxFull = subject === '2' && detail === '2'
      // Only 4 and 5 are failures. `2.x.x` with `Action: failed` contradicts
      // itself, and a contradiction is not evidence of anything.
      if (cls === '5' || cls === '4') {
        return {
          kind: 'bounce',
          permanent: cls === '5' && !mailboxFull,
          status: dsn.status,
          recipient: dsn.finalRecipient ?? firstAddress(headers.get('x-failed-recipients')),
          originalRecipient: dsn.originalRecipient,
          originalMessageId: dsn.originalMessageId,
        }
      }
    }
  }

  // RFC 3834 §5: `no` means a person originated it, and that is the one
  // header value that settles the question the other way — trusted over any
  // Precedence a list server added, because the safe reading of a reply is
  // that somebody wrote it (it pauses; an auto-reply does not).
  const submitted = headers.get('auto-submitted')
  if (submitted !== undefined) {
    const value = token(submitted)
    if (value === 'no') return null
    if (value) return { kind: 'auto_reply', header: 'auto-submitted' }
  }
  const precedence = token(headers.get('precedence'))
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list' || precedence === 'auto_reply') {
    return { kind: 'auto_reply', header: 'precedence' }
  }
  for (const name of ['x-auto-response-suppress', 'x-autoreply', 'x-autorespond'] as const) {
    const value = token(headers.get(name))
    if (value && value !== 'no') return { kind: 'auto_reply', header: name }
  }
  return null
}

/**
 * The headers and DSN an inbound path hands the readers, bounded.
 *
 * Takes whatever a webhook body carried and keeps only what the readers
 * read: the names in `MAIL_SIGNAL_HEADERS` whose values are strings, each cut
 * to `MAIL_SIGNAL_LIMITS.headerChars`, and the DSN cut to `dsnChars`. It
 * never REFUSES: a provider that forwards its whole header map (sixty names
 * is ordinary, and one of them is a long `References`) must not have the
 * delivery rejected over it, because the delivery might be the reply that
 * says stop — and a refused webhook is an opt-out nobody recorded.
 */
export function mailSignalInput(raw: { readonly headers?: unknown; readonly dsn?: unknown }): {
  readonly headers: Readonly<Record<string, string>> | undefined
  readonly dsn: string | null
} {
  let headers: Record<string, string> | undefined
  const h = raw.headers
  if (h !== null && typeof h === 'object' && !Array.isArray(h)) {
    const wanted = new Set<string>(MAIL_SIGNAL_HEADERS)
    for (const [key, value] of Object.entries(h as Record<string, unknown>)) {
      const name = key.trim().toLowerCase()
      if (!wanted.has(name) || typeof value !== 'string') continue
      headers ??= {}
      if (!(name in headers)) headers[name] = value.slice(0, MAIL_SIGNAL_LIMITS.headerChars)
    }
  }
  const dsn = typeof raw.dsn === 'string' && raw.dsn.trim() ? raw.dsn.slice(0, MAIL_SIGNAL_LIMITS.dsnChars) : null
  return { headers, dsn }
}

/**
 * The person's own words: everything above the first quoted reply.
 *
 * A reply quotes the message it answers, and the message it answers is
 * OURS — footer, unsubscribe line and all. Reading the quote as theirs would
 * put our own "unsubscribe" in their mouth. The markers are a `>`-quoted
 * line, an "On … wrote:" attribution and Outlook's "-----Original Message"
 * rule; the first one ends what they wrote.
 */
export function ownWords(body: string | null | undefined): string {
  if (!body) return ''
  return body.split(/\r?\n(?:>|On .+ wrote:|-{2,}\s*Original Message)/)[0] ?? body
}

const REMOVAL_OR_DEPARTURE = new RegExp(
  [
    String.raw`\bremove\s+(?:me|my\s+(?:address|e-?mail|name|details))\b`,
    String.raw`\btake\s+me\s+off\b`,
    String.raw`\bunsubscrib\w*`,
    String.raw`\bopt(?:\s+me)?[\s-]?out\b`,
    String.raw`\b(?:do\s+not|don['’]?t)\s+(?:contact|e-?mail)\b`,
    String.raw`\bstop\s+(?:e-?mailing|contacting)\b`,
    String.raw`\bno\s+longer\s+(?:with|at|working)\b`,
    String.raw`(?:\bhas|\bhave|['’]ve)\s+left\b`,
    String.raw`\bleft\s+the\s+(?:company|organi[sz]ation|business)\b`,
  ].join('|'),
  'i',
)

/**
 * Removal, or departure, in so many words — BROAD on purpose (see this
 * file's header): "remove me", "take me off", "unsubscribe", "opt out", "do
 * not / don't contact / email", "stop emailing / contacting", "no longer
 * with / at / working", "has / have left", "left the company /
 * organisation / business". Case-insensitive, over `ownWords` only.
 *
 * It decides two things: whether a mail whose headers say it is automatic
 * may skip the pause — a hit makes it an ordinary reply: pause, cancel,
 * advance — and, since 2026-10-08, that `laterAsk` reads no day to call
 * back from a reply that asks to be removed or says they have left. It never
 * decides an opt-out and never writes a suppression; that is
 * `looksLikeOptOut`, and only that.
 */
export function mentionsRemovalOrDeparture(body: string | null | undefined): boolean {
  const own = ownWords(body)
  if (!own.trim()) return false
  return REMOVAL_OR_DEPARTURE.test(own)
}

// ---------------------------------------------------------------------------

/** Header names are case-insensitive (RFC 5322 §1.2.2); the first spelling wins. */
function foldHeaders(headers: Readonly<Record<string, string>> | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!headers) return out
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue
    const name = key.trim().toLowerCase()
    if (!out.has(name)) out.set(name, value)
  }
  return out
}

/** The first word of a header value, lower-case: parameters and comments dropped. */
function token(value: string | undefined): string {
  return (value ?? '').trim().split(/[\s;(,]/)[0]!.toLowerCase()
}

/** `rfc822; priya@rentman.io` → `priya@rentman.io`. The address type is dropped. */
function addressOf(value: string | undefined): string | null {
  if (!value) return null
  const semi = value.indexOf(';')
  const address = (semi >= 0 ? value.slice(semi + 1) : value).trim().replace(/^<|>$/g, '').trim()
  return address || null
}

function firstAddress(value: string | undefined): string | null {
  if (!value) return null
  const first = value.split(',')[0]?.trim().replace(/^<|>$/g, '').trim()
  return first || null
}

function messageIdOf(value: string | undefined): string | null {
  const m = /<[^<>\s]+>/.exec(value ?? '')
  return m ? m[0] : null
}
