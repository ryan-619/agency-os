/**
 * Reply detection over IMAP IDLE (PROMPT.md §8.4).
 *
 * "Reply detection via IMAP IDLE or the provider webhook — an inbound reply
 * flips the deal to `replied` and pauses the sequence for that contact
 * immediately."
 *
 * This is the IMAP half. It sits on the sending mailbox, waits for the server
 * to say something arrived, fetches it, and hands it to `handleInboundEmail` —
 * which is also what the webhook route calls. One function decides what an
 * inbound message means; this file only delivers it there.
 *
 * ## What it must never do
 *
 *  - **Guess.** `handleInboundEmail` matches by the Message-ID this system
 *    sent, then by an address that belongs to exactly one contact. Anything
 *    else is logged and left alone. A reply filed under the wrong company is
 *    a follow-up that reads as nobody having read what they wrote — the exact
 *    outcome §8.4's pause exists to prevent.
 *  - **Process a message twice.** Each UID is marked `\Seen` once it is
 *    handled and the fetch asks for unseen only, so a reconnect does not
 *    replay the inbox. It means this listener must own the mailbox: a person
 *    reading the same inbox in a mail client marks things seen too, and a
 *    reply they opened first is one this never sees. Documented in
 *    .env.example.
 *  - **Mark seen what was not recorded.** `recordInboundReply` is one
 *    transaction, so a database fault leaves NO row — and a "stop" marked
 *    seen after one was never retried and never recorded. A message is
 *    marked seen when it was handled or never can be (no source, no
 *    readable sender, a parse that throws); a failure to record it leaves
 *    it unseen for the next drain, which a timer brings round while the
 *    mailbox is idle. Bounded: after `INBOUND_MAX_ATTEMPTS` failures it is
 *    marked seen and logged `INBOUND MESSAGE ABANDONED` at error, for a
 *    person to handle by hand (`drainUnseen`).
 *  - **Die on one bad email.** Every message is handled in its own try; the
 *    connection is re-established on its own schedule; and nothing here can
 *    stop the worker's other work.
 *  - **Log a body.** §2.3. The log carries the outcome and the touch id.
 *  - **Lose an opt-out quietly.** A reply that said stop and whose
 *    suppression could not be written is audited and logged by
 *    `handleInboundEmail`; this file then raises the same Slack alarm the
 *    web routes raise (`notify.ts`), awaited, before anything else is done
 *    with the reply. And a stop whose recording THREW — nothing stored,
 *    left unseen to retry — takes the webhooks' loud path on its first
 *    failure: the contact paused, a `contact.opt_out_not_recorded` row and
 *    the awaited alarm, once per message however often it is retried
 *    (`stopNotRecorded`). Before review round 6 it was retried and then
 *    abandoned with log lines only.
 *
 * ## What the mail says about itself
 *
 * Beside the reply it carries, a message hands `handleInboundEmail` the few
 * headers that say whether it was automatic (`Auto-Submitted`,
 * `Precedence`, …) and, for a delivery report, the text of its
 * `message/delivery-status` part and the Message-ID of the copy it returns.
 * An out-of-office is then recorded without pausing anybody, and a bounce
 * marks an address — but only one tied to a message this system sent.
 */
import { ImapFlow } from 'imapflow'
import { simpleParser, type HeaderValue, type SimpleParserOptions } from 'mailparser'
import {
  appendAudit, handleInboundEmail, keepingRolledBackOptOut, pauseContact, pauseContactOverriding, rolledBackOptOutAlarm,
  rolledBackOptOutAudit, rolledBackOptOutPause, rolledBackSenderHolds, type AgencyDb, type InboundLog, type InboundOutcome,
  type RolledBackOptOut,
} from '@agency/db'
import { MAIL_SIGNAL_HEADERS, MAIL_SIGNAL_LIMITS, htmlToText, type LlmProvider } from '@agency/core'
import { refineReplyKind } from './classify.js'
import { suggestAnswer } from './suggest.js'
import type { Logger } from '../logger.js'
import { imapLoginFrom } from './mail-login.js'
import { optOutAlarmFromEnvironment, optOutNotRecordedEvent, type OptOutAlarm } from '../notify.js'

export interface InboxConfig {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user: string
  readonly password: string
  readonly mailbox: string
}

export interface InboxDeps {
  readonly db: AgencyDb
  readonly log: Logger
  readonly config: InboxConfig
  /**
   * §5.5's reply triage, or null. Null is a complete configuration: the
   * deterministic kind `recordInboundReply` already wrote stands.
   */
  readonly llm?: LlmProvider | null
  readonly allowRemoteForLeadData?: boolean
  /**
   * The web app's origin (`WEB_PUBLIC_URL`), for the booking link a suggested
   * answer may offer (0026). Null or absent offers none.
   */
  readonly webOrigin?: string | null
  /** For tests. Defaults to the wall clock. */
  readonly now?: () => Date
  /**
   * The Slack alarm for an opt-out that could not be recorded (`notify.ts`).
   * Null is no alarm. Left out, it is built from the worker's own
   * environment (`SLACK_WEBHOOK_URL`, `WEB_PUBLIC_URL`) when the inbox
   * starts — `startWorker` (`worker.ts`) names the inbox's settings one by
   * one and passes none, so the alarm is on wherever the variable is set.
   */
  readonly optOutAlarm?: OptOutAlarm | null
  /** For tests: the IMAP client. Defaults to an `ImapFlow` on `config`. */
  readonly connect?: (config: InboxConfig) => InboxClient
  /** For tests: the idle-time drains' timing. Defaults to `DRAIN_TIMING`. */
  readonly timing?: DrainTiming
  /**
   * Each session's outcome as a login state (`mail-login.ts`): `ok` when the
   * mailbox is open, `refused` or `unreachable` when a session failed. The
   * worker carries it on its heartbeat, so the dashboard can say the
   * mailbox refused the login rather than leave it to the log.
   */
  readonly onLogin?: (state: 'ok' | 'refused' | 'unreachable') => void
}

/**
 * Per UID, how far the loud path for a stop that could not be recorded has
 * got: present once the alarm was raised, `written` once the pause and the
 * audit row were both attempted without a fault. A retry of the same
 * message raises no second alarm, and tries again only what did not land.
 */
export type UnrecordedStops = Map<string, { readonly written: boolean }>

/**
 * What handling one message needs: the inbox's settings without the mailbox.
 * Here a missing `optOutAlarm` means none — `startInbox` is what resolves it
 * from the environment, once, and hands it in.
 */
export type InboundMessageDeps = Omit<InboxDeps, 'config' | 'connect' | 'timing'> & {
  /**
   * The inbox's memory of stops already said out loud (`UnrecordedStops`),
   * beside its failure count. Left out — a caller handling one message with
   * no inbox around it — every failure takes the loud path.
   */
  readonly unrecordedStops?: UnrecordedStops
}

/**
 * The part of an IMAP client the inbox uses. `ImapFlow` is one; a test
 * hands in a fake, because the session cannot otherwise be driven without a
 * mailbox.
 */
export interface InboxClient {
  connect(): Promise<void>
  getMailboxLock(path: string): Promise<{ release(): void }>
  idle(): Promise<unknown>
  noop(): Promise<unknown>
  logout(): Promise<unknown>
  search(query: { seen: false }, options: { uid: true }): Promise<number[] | false>
  fetchOne(uid: string, query: { source: true }, options: { uid: true }): Promise<{ source?: Buffer } | false>
  messageFlagsAdd(uid: string, flags: string[], options: { uid: true }): Promise<unknown>
  on(event: 'exists', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  off(event: 'exists', listener: () => void): unknown
}

/** Back-off between reconnects. Starts short, doubles, stops growing at five minutes. */
const RECONNECT_MIN_MS = 5_000
const RECONNECT_MAX_MS = 5 * 60_000

/**
 * How many times one message may fail to be recorded before a drain gives up
 * on it, marks it seen, and says so at error. In memory, per UID: a restart
 * forgets the count, and the message is retried as if new — the safe
 * direction, since the inbound path is idempotent on the reply's Message-ID.
 */
export const INBOUND_MAX_ATTEMPTS = 5

export interface DrainTiming {
  /**
   * The wait before re-reading a mailbox whose last drain left a message
   * unseen, for its first failure; it doubles with each further one, so the
   * attempts span a quarter of an hour rather than five minutes — long
   * enough for a database to come back. Capped at `refreshMs`.
   */
  readonly retryMs: number
  /**
   * The longest IDLE runs with nothing to wake it before the mailbox is
   * re-read anyway. RFC 2177 asks a client to re-issue IDLE inside 29
   * minutes; this is well inside that, and catches anything an EXISTS that
   * never arrived would have announced.
   */
  readonly refreshMs: number
}

export const DRAIN_TIMING: DrainTiming = { retryMs: 60_000, refreshMs: 10 * 60_000 }

/**
 * A message `parseInbound` could not read. It will not read the next time
 * either, so a drain marks it seen; every other failure leaves it unseen to
 * be retried. `message` is the parser's error NAME — never its text, which
 * can quote the mail.
 */
export class UnreadableInboundMessage extends Error {
  override readonly name = 'UnreadableInboundMessage'
}

/**
 * mailparser INLINES a `message/delivery-status` part into `text` unless told
 * to keep it (mailparser 3.7.4, lib/mail-parser.js:159) — so without this a
 * DSN's fields are read as the body of a reply and the part never reaches
 * the bounce reader. `@types/mailparser` does not declare the option; it is
 * named here, typed, rather than cast away at the call.
 */
const PARSE_OPTIONS: SimpleParserOptions & { readonly keepDeliveryStatus: boolean } = { keepDeliveryStatus: true }

/** The delivery-status parts (RFC 3464; RFC 6533's internationalised twin). */
const DSN_TYPES = new Set(['message/delivery-status', 'message/global-delivery-status'])
/** Where a report carries the message it returns — whole, or its headers only. */
const RETURNED_TYPES = new Set(['message/rfc822', 'text/rfc822-headers', 'message/global', 'message/global-headers'])
/** Enough of a returned copy to reach its headers. Our own messages are small. */
const RETURNED_MAX_BYTES = 256 * 1024

/**
 * The parsed shape `handleInboundEmail` wants, from a raw RFC 5322 message.
 *
 * Exported so the parsing can be tested without a mailbox: an email is a
 * surprisingly hostile input, and the interesting failures — a From with a
 * display name and no angle brackets, a References header folded across
 * lines, HTML with no text part, a bounce whose report is a MIME part — are
 * all in this function.
 */
export async function parseInbound(raw: Buffer | string): Promise<{
  from: string
  subject: string | null
  text: string | null
  messageId: string | null
  references: string[]
  /** The first value of each header in `MAIL_SIGNAL_HEADERS` the mail carries, keyed lower-case. */
  headers: Record<string, string>
  /** The text of the delivery-status part, or null for a mail that is not a report. */
  dsn: string | null
  /** For a report: the Message-ID, then References, of the copy it returns. */
  originalMessageIds: string[]
} | null> {
  const parsed = await simpleParser(raw, PARSE_OPTIONS)
  const from = parsed.from?.value?.[0]?.address
  if (!from) return null

  // In-Reply-To first (the direct parent), then References (the chain). A
  // client that sets only one of them is common, and the parent is what the
  // provider_id lookup wants.
  const refs: string[] = []
  const push = (v: string | string[] | undefined): void => {
    for (const item of Array.isArray(v) ? v : v ? [v] : []) {
      for (const id of item.split(/\s+/)) if (id.trim()) refs.push(id.trim())
    }
  }
  push(parsed.inReplyTo)
  push(parsed.references)

  const headers: Record<string, string> = {}
  for (const name of MAIL_SIGNAL_HEADERS) {
    const value = headerText(parsed.headers.get(name))
    if (value !== null) headers[name] = value.slice(0, MAIL_SIGNAL_LIMITS.headerChars)
  }

  // A report is a MIME part, never the body — and only the part of a mail
  // that IS a report. mailparser walks into an inline message/rfc822, so a
  // delivery status nested in a forwarded message surfaces in `attachments`
  // exactly as a real one does; read from there, a prospect's "please
  // unsubscribe me" that forwards a bounce inline (mutt, `mime_forward=yes`)
  // became a bounce of our message, and the opt-out was never read. So the
  // ROOT must be multipart/report. RFC 6522 lets a report be nested, which is
  // precisely how a forwarded one arrives; this is a choice, not the RFC's
  // rule — the reports this system acts on come from the reporting MTA,
  // which writes the report as the whole message. A wrapped one reads as an
  // ordinary mail: recording a reply nobody wrote is recoverable, and losing
  // an opt-out is not. The returned copy is read only when there IS a
  // report: a person forwarding a message as an attachment is not telling us
  // which message bounced.
  const isReport = headerText(parsed.headers.get('content-type'))?.toLowerCase() === 'multipart/report'
  const report = isReport ? parsed.attachments.find((a) => DSN_TYPES.has(a.contentType.toLowerCase())) : undefined
  const dsn = report ? report.content.toString('utf8').slice(0, MAIL_SIGNAL_LIMITS.dsnChars) : null
  const originalMessageIds: string[] = []
  if (report) {
    for (const part of parsed.attachments.filter((a) => RETURNED_TYPES.has(a.contentType.toLowerCase()))) {
      try {
        const copy = await simpleParser(part.content.subarray(0, RETURNED_MAX_BYTES))
        if (copy.messageId) originalMessageIds.push(copy.messageId)
        for (const ref of Array.isArray(copy.references) ? copy.references : copy.references ? [copy.references] : []) {
          for (const id of ref.split(/\s+/)) if (id.trim()) originalMessageIds.push(id.trim())
        }
      } catch {
        // A copy that will not parse names nothing; the report is still read.
      }
    }
  }

  return {
    from,
    subject: parsed.subject ?? null,
    text: replyText(parsed.text, parsed.html),
    messageId: parsed.messageId ?? null,
    references: [...new Set(refs)],
    headers,
    dsn,
    originalMessageIds: [...new Set(originalMessageIds)],
  }
}

/**
 * The words of a reply: its plain text, or its HTML converted to text when
 * there is no plain text worth the name — the Resend mapping's rule.
 *
 * mailparser converts a ROOT `text/html` itself (html-to-text, which keeps
 * the lines and opens a quote with `>`), and that `text` is kept. An HTML
 * part BELOW the root — Outlook's multipart/related, the HTML beside its
 * signature image; a multipart/alternative with no plain part — it leaves
 * unconverted, and this used to strip its tags to ONE line, which turned
 * `Stop<blockquote>On Mon … wrote:` into a line that is not an opt-out: the
 * contact was paused and never suppressed. `htmlToText` from packages/core
 * keeps the lines, and it is the converter the Resend path uses, so a
 * "Stop" above a quote is read the same whichever way it arrived.
 */
function replyText(text: string | undefined, html: string | false | undefined): string | null {
  if (typeof text === 'string' && text.trim()) return text
  const converted = typeof html === 'string' && html.trim() ? htmlToText(html) : ''
  if (converted) return converted
  return typeof text === 'string' ? text : null
}

/** One header's first value as text. mailparser structures some of them. */
function headerText(value: HeaderValue | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value
  if (first === undefined || first === null) return null
  if (typeof first === 'string') return first.trim() || null
  if (first instanceof Date) return first.toISOString()
  // `{ value, params }` (content-type and friends) or an address object's `text`.
  if ('value' in first && typeof first.value === 'string') return first.value.trim() || null
  if ('text' in first && typeof first.text === 'string') return first.text.trim() || null
  return null
}

/**
 * Where `recordInboundReply` writes when nobody hands it a log: stderr, one
 * JSON line, in its own shape. The inbox hands it a log now — to keep the
 * rolled-back line — and forwards every line here, so where they are read
 * does not change.
 */
const recorderLines: InboundLog = {
  error: (message, fields) => {
    console.error(JSON.stringify({ level: 'error', message, ...fields, at: new Date().toISOString() }))
  },
}

/**
 * §2.1's Phase 4 obligation for a "stop" whose recording threw: the loud
 * path the two webhooks take for the same fault
 * (apps/web/src/app/api/inbound/email/fault.ts), in the same shapes
 * (packages/db's `inbound-fault.ts`), so /audit and the Slack channel
 * cannot tell which process noticed.
 *
 * `recordInboundReply` rolled the whole reply back, so the message stays
 * unseen and the drain retries it — and until a retry lands nothing holds
 * the contact: the sender reads them as clear, and their approved
 * follow-up goes on the next tick. A retry may fail the same way five
 * times and be abandoned. So on the FIRST failure: the contact paused over
 * any earlier reason (`pauseContactOverriding`, `opt-out not recorded:
 * reply <ISO> (record_failed)`, a pause no answer and no Resume lifts), a
 * `contact.opt_out_not_recorded` row — what /compliance and the digest
 * count, and what keeps /inbox from drafting to them — and the alarm,
 * awaited. Each write is tried on its own, because the database may be the
 * thing that failed; one that threw is tried again on the message's next
 * failure, and the alarm is raised once (`UnrecordedStops`). Never throws.
 *
 * A stop from somebody other than the contact it was filed under — a
 * colleague replying all to our message (review round 7) — holds that
 * contact only as any reply would (`pauseContact`, `replied <ISO>`), and
 * the row and the alarm say whose address to record: holding the contact
 * as an opt-out nobody recorded locked out somebody who never asked, for
 * good, even once the retry suppressed the colleague (inbound-fault.ts).
 * The colleague is held instead, when they are a contact here (review
 * round 8): each the recorder found at their address, named on its line by
 * id, is paused as the opt-out nobody recorded and audited as theirs
 * (`rolledBackSenderHolds`), under the same retry-on-next-failure rule.
 */
async function stopNotRecorded(
  placed: RolledBackOptOut,
  uid: number | string,
  err: unknown,
  deps: InboundMessageDeps,
): Promise<void> {
  const key = String(uid)
  const before = deps.unrecordedStops?.get(key)
  if (before?.written) return
  const now = deps.now ? deps.now() : new Date()
  const pause = rolledBackOptOutPause(placed, now)
  let paused = false
  let written = true
  try {
    paused = pause.overriding
      ? await pauseContactOverriding(deps.db, placed.orgId, placed.contactId, pause.reason, now)
      : await pauseContact(deps.db, placed.orgId, placed.contactId, pause.reason, now)
  } catch {
    written = false
  }
  let audited = true
  try {
    await appendAudit(deps.db, rolledBackOptOutAudit(placed))
  } catch {
    audited = false
    written = false
  }
  // The sender of a colleague's stop, when they are contacts here: held as
  // the one who asked, each write on its own.
  const holds = rolledBackSenderHolds(placed, now)
  let sendersHeld = 0
  let sendersAudited = 0
  for (const hold of holds) {
    try {
      if (await pauseContactOverriding(deps.db, placed.orgId, hold.contactId, hold.reason, now)) sendersHeld++
    } catch {
      written = false
    }
    try {
      await appendAudit(deps.db, hold.audit)
      sendersAudited++
    } catch {
      written = false
    }
  }
  const alarm = before ? 'already_raised' : deps.optOutAlarm ? 'raised' : 'off'
  // Ids and the fault's CLASS: its message quotes the address and the words.
  deps.log.error('OPT-OUT NOT RECORDED — a reply that asked to stop could not be recorded; it stays unseen and is retried, otherwise follow up by hand', {
    uid,
    error: err instanceof Error ? err.name : 'UnknownError',
    orgId: placed.orgId,
    contactId: placed.contactId,
    // False: a colleague's stop, filed under that contact.
    fromIsContact: placed.fromIsContact,
    paused,
    audited,
    // The contacts who ARE that colleague, held as the one who asked.
    ...(placed.fromIsContact ? {} : { senders: holds.length, sendersHeld, sendersAudited }),
    alarm,
  })
  deps.unrecordedStops?.set(key, { written })
  if (!before && deps.optOutAlarm) {
    await deps.optOutAlarm(rolledBackOptOutAlarm(placed)).catch((e: unknown) => {
      deps.log.warn('opt-out alarm failed', { error: e instanceof Error ? e.name : 'UnknownError' })
    })
  }
}

/**
 * One raw message, from parse to every consequence: the record (and with it
 * the pause, the suppression, the deal — `handleInboundEmail`), the log
 * line, the alarm for an opt-out that could not be recorded, and the
 * optional triage. Exported so the whole path can be driven without a
 * mailbox; the IMAP session below only fetches and marks seen.
 *
 * Answers null for a message with no readable sender. Throws
 * `UnreadableInboundMessage` when `parseInbound` throws, and whatever
 * `handleInboundEmail` throws — the caller's per-message try owns both, and
 * tells them apart: the first never reads, the second may record on a retry.
 * The alarm and the triage never throw out of here, and neither does the
 * loud path a stop takes when `handleInboundEmail` throws: it runs before
 * the fault is rethrown, so the drain still counts and retries it.
 */
export async function handleInboundMessage(
  source: Buffer | string,
  uid: number | string,
  deps: InboundMessageDeps,
): Promise<InboundOutcome | null> {
  let mail: Awaited<ReturnType<typeof parseInbound>>
  try {
    mail = await parseInbound(source)
  } catch (err) {
    throw new UnreadableInboundMessage(err instanceof Error ? err.name : 'UnknownError')
  }
  if (!mail) {
    deps.log.info('inbound mail had no readable sender; skipped', { uid })
    return null
  }
  // The recorder's lines go where they always went (`recorderLines`), and a
  // stop it rolled back is kept: that line is the one place a fault leaves
  // the org and the contact it was filing under.
  const recorder = keepingRolledBackOptOut(recorderLines)
  let outcome: InboundOutcome
  try {
    outcome = await handleInboundEmail(deps.db, { ...mail, log: recorder, ...(deps.now ? { now: deps.now() } : {}) })
  } catch (err) {
    const placed = recorder.rolledBack()
    if (placed) await stopNotRecorded(placed, uid, err, deps)
    throw err
  }
  if (outcome.matched === 'none' && outcome.bounce) {
    // A delivery report tied to a message this system sent. Ids and
    // the report's status code: the address is in the row, not here.
    deps.log.info('delivery report recorded', {
      uid,
      contactId: outcome.bounce.contactId,
      touchId: outcome.bounce.touchId,
      permanent: outcome.bounce.permanent,
      code: outcome.bounce.code,
      marked: outcome.bounce.marked,
    })
    return outcome
  }
  if (outcome.matched === 'none') {
    deps.log.info('inbound mail did not match a contact', { uid, why: outcome.why })
    return outcome
  }
  deps.log.info('inbound reply recorded', {
    uid,
    matched: outcome.matched,
    touchId: outcome.touchId,
    paused: outcome.paused,
    suppressed: outcome.suppressed,
    // True means a "stop" whose suppression could not be written; the alarm follows.
    optOutNotRecorded: outcome.optOutNotRecorded,
  })

  // §2.1's Phase 4 obligation, in real time: AWAITED, before the triage —
  // a model can take seconds, and this is the one message that must not
  // wait behind it. `handleInboundEmail` has already audited it and logged
  // OPT-OUT NOT RECORDED; this is the person being told.
  const alarm = optOutNotRecordedEvent(outcome)
  if (alarm && deps.optOutAlarm) {
    await deps.optOutAlarm(alarm).catch((err: unknown) => {
      deps.log.warn('opt-out alarm failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    })
  }

  // Triage, after the record exists and every §2.1 consequence has
  // already been applied. Failing here costs a sorting hint and
  // nothing else, so it never takes the tick down with it.
  if (deps.llm) {
    await refineReplyKind({
      db: deps.db,
      log: deps.log,
      llm: deps.llm,
      allowRemoteForLeadData: deps.allowRemoteForLeadData ?? false,
      touchId: outcome.touchId,
      body: mail.text ?? null,
      deterministic: outcome.suppressed ? 'opted_out' : (outcome.replyKind ?? 'other'),
    }).catch((err: unknown) => {
      deps.log.warn('reply triage failed; the deterministic kind stands', {
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    })
    // A suggested answer (0026), after the kind is settled — the gate in
    // front of it reads the kind. A reply that was recorded already has
    // its row or its skip; a failure here costs a suggestion and nothing else.
    if (!outcome.duplicate) {
      await suggestAnswer(
        {
          db: deps.db,
          log: deps.log,
          llm: deps.llm,
          allowRemoteForLeadData: deps.allowRemoteForLeadData ?? false,
          webOrigin: deps.webOrigin ?? null,
          ...(deps.now ? { now: deps.now } : {}),
        },
        { orgId: outcome.orgId, touchId: outcome.touchId },
      ).catch((err: unknown) => {
        deps.log.warn('suggesting an answer failed; the reply stands as recorded', {
          error: err instanceof Error ? err.name : 'UnknownError',
        })
      })
    }
  }
  return outcome
}

export interface DrainDeps {
  readonly log: Logger
  /** One message, start to finish: `handleInboundMessage` with the inbox's deps, in production. */
  readonly handle: (source: Buffer, uid: number) => Promise<unknown>
  /**
   * Failures so far, per UID. The inbox owns it, so it outlives a drain and
   * a reconnect; a drain deletes a UID's entry once the message is settled.
   */
  readonly attempts: Map<number, number>
  /**
   * The stops already said out loud (`UnrecordedStops`), which `handle`
   * reads; forgotten with the count once the message is settled.
   */
  readonly unrecordedStops?: UnrecordedStops
  readonly stopped?: () => boolean
}

/**
 * Read every unseen message once, and say how soon the mailbox should be
 * read again.
 *
 * A message is marked `\Seen` when it was handled, or when it never can be:
 * the server returned no source for it (expunged meanwhile), it has no
 * readable sender (`handleInboundMessage` answers null), or the parser threw
 * (`UnreadableInboundMessage`). Anything else that throws — a database
 * fault inside `recordInboundReply`, which rolls the whole reply back, or a
 * fetch that failed — leaves it UNSEEN, so the next drain tries again: that
 * is the difference between a "stop" recorded a minute late and one never
 * recorded at all. Before, every UID was marked seen in a `finally`.
 *
 * Bounded. Each failure is counted against its UID, and the
 * `INBOUND_MAX_ATTEMPTS`th marks it seen and logs `INBOUND MESSAGE
 * ABANDONED — handle it by hand` at error, with the UID and the error's
 * name — the mailbox still holds the message; the log holds nothing of it.
 * Only the FIRST failure of a drain is counted: a database that is down
 * fails every message behind that one too, and charging each would abandon
 * the whole inbox to one outage. The messages behind it are still tried, so
 * one that will never record does not hold up a "stop" that arrived after
 * it.
 *
 * Answers `retryInMs` when something was left unseen — `timing.retryMs`,
 * doubled for each failure already counted against the message that failed
 * first, capped at `timing.refreshMs` — and null when nothing was.
 */
export async function drainUnseen(
  c: Pick<InboxClient, 'search' | 'fetchOne' | 'messageFlagsAdd'>,
  deps: DrainDeps,
  timing: DrainTiming = DRAIN_TIMING,
): Promise<{ readonly retryInMs: number | null }> {
  // UIDs of everything not yet seen. `search` returns them in mailbox
  // order; `false` means the mailbox is empty, which imapflow types as a
  // possible result.
  const uids = await c.search({ seen: false }, { uid: true })
  if (!uids || uids.length === 0) return { retryInMs: null }

  let charged: number | null = null
  let leftUnseen = false
  // A message is settled — handled, unreadable or abandoned: what the inbox
  // remembers about it goes.
  const settle = (uid: number): void => {
    deps.attempts.delete(uid)
    deps.unrecordedStops?.delete(String(uid))
  }
  for (const uid of uids) {
    if (deps.stopped?.()) break
    let seen = true
    try {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true })
      if (msg && msg.source) await deps.handle(msg.source, uid)
      settle(uid)
    } catch (err) {
      if (err instanceof UnreadableInboundMessage) {
        // It will not parse next time either.
        deps.log.error('could not read an inbound message; marked seen', { uid, error: err.message })
        settle(uid)
      } else {
        const error = err instanceof Error ? err.name : 'UnknownError'
        const counts: boolean = charged === null
        const attempts: number = (deps.attempts.get(uid) ?? 0) + (counts ? 1 : 0)
        if (counts) charged = attempts
        if (attempts >= INBOUND_MAX_ATTEMPTS) {
          settle(uid)
          deps.log.error('INBOUND MESSAGE ABANDONED — handle it by hand', { uid, error })
        } else {
          if (counts) deps.attempts.set(uid, attempts)
          deps.log.error('could not record an inbound message; left unseen to retry', {
            uid,
            error,
            attempt: attempts,
            of: INBOUND_MAX_ATTEMPTS,
          })
          seen = false
          leftUnseen = true
        }
      }
    }
    if (seen) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {})
  }
  if (!leftUnseen) return { retryInMs: null }
  const doublings = Math.max((charged ?? 1) - 1, 0)
  return { retryInMs: Math.min(timing.retryMs * 2 ** doublings, timing.refreshMs) }
}

/**
 * Why a connection failed, in words that name no value: the error's code
 * (`ENOTFOUND`, `ECONNREFUSED`, imapflow's `NoConnection`), the server's
 * bracketed response code (`AUTHENTICATIONFAILED`), and a hint for the two
 * a person can fix. Never the message, which can quote the host, the user or
 * what the server said back. "Error" alone was every line a mistyped host or
 * a refused password ever produced, for as long as the worker ran.
 */
export function imapFailure(err: unknown): { reason?: string; hint?: string } {
  if (typeof err !== 'object' || err === null) return {}
  const e = err as { code?: unknown; serverResponseCode?: unknown; authenticationFailed?: unknown }
  const token = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(v) ? v : undefined
  const reason =
    e.authenticationFailed === true ? 'authentication_failed' : (token(e.serverResponseCode) ?? token(e.code))
  if (reason === undefined) return {}
  if (reason === 'authentication_failed' || reason === 'AUTHENTICATIONFAILED') {
    return {
      reason,
      hint: 'the mailbox refused IMAP_USER or IMAP_PASSWORD — Google needs the whole address and an app password',
    }
  }
  // macOS answers ENOTFOUND for every name while the machine is offline, and
  // EAI_AGAIN is a resolver that did not answer in time: neither proves the
  // host is wrong, and a laptop reconnecting after sleep must not be told it
  // is (review round 15).
  if (reason === 'ENOTFOUND') {
    return {
      reason,
      hint: 'IMAP_HOST did not resolve — check it is a server name, e.g. imap.gmail.com, and that this machine is online',
    }
  }
  if (reason === 'EAI_AGAIN') {
    return { reason, hint: 'a DNS lookup timed out — this machine may be offline; it is retried' }
  }
  // imapflow's own code for a socket that went quiet: what a laptop's
  // connection does across a sleep. Nothing to fix.
  if (reason === 'ETIMEOUT') {
    return { reason, hint: 'the connection went quiet — this machine may have slept or lost its network; it is retried' }
  }
  return { reason }
}

/**
 * Listen for replies until stopped.
 *
 * Returns a stop function. The loop inside reconnects forever with back-off;
 * `stop` breaks it and closes the connection cleanly.
 */
export function startInbox(deps: InboxDeps): () => Promise<void> {
  let stopped = false
  let client: InboxClient | null = null
  let backoff = RECONNECT_MIN_MS
  const timing = deps.timing ?? DRAIN_TIMING
  // Per UID, across drains and reconnects (`drainUnseen`): the failures, and
  // the stops among them already said out loud (`stopNotRecorded`).
  const attempts = new Map<number, number>()
  const unrecordedStops: UnrecordedStops = new Map()
  // Resolved once, at start: the boot log says whether the alarm is on.
  const handling: InboundMessageDeps = {
    ...deps,
    optOutAlarm: deps.optOutAlarm !== undefined ? deps.optOutAlarm : optOutAlarmFromEnvironment({ db: deps.db, log: deps.log }),
    unrecordedStops,
  }
  const connect =
    deps.connect ??
    ((config: InboxConfig): InboxClient =>
      new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.password },
        // imapflow logs at debug level by default, and its log lines include
        // message envelopes. Off, for §2.3.
        logger: false,
        emitLogs: false,
      }))

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await session()
        backoff = RECONNECT_MIN_MS
      } catch (err) {
        if (stopped) break
        const failure = imapFailure(err)
        deps.onLogin?.(imapLoginFrom(failure))
        deps.log.warn('inbox connection dropped; reconnecting', {
          error: err instanceof Error ? err.name : 'UnknownError',
          ...failure,
          inMs: backoff,
        })
        await new Promise<void>((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
      }
    }
  }

  const session = async (): Promise<void> => {
    const c = connect(deps.config)
    client = c
    // imapflow reports a connection it lost — a socket that went quiet while
    // the machine slept, a reset — as an 'error' EVENT, and closes itself on
    // the next tick. Node throws an 'error' event nobody listens for out of
    // the process, so a minute without a network stopped the worker
    // (ETIMEOUT), and with it the sender and chat. Heard, the close ends the
    // command in flight, the session ends, and the loop reconnects with
    // back-off — naming what dropped the connection, not the "Connection not
    // available" the close turns it into. Never taken off: an event from a
    // client this session has finished with must not stop the process either.
    let dropped: Error | null = null
    c.on('error', (err) => {
      dropped ??= err
    })
    try {
      await serve(c)
    } catch (err) {
      throw dropped ?? err
    }
  }

  const serve = async (c: InboxClient): Promise<void> => {
    // `idle()` resolves only when IDLE ends, and imapflow ends it only to
    // run another command — an EXISTS for new mail is an event, not an end.
    // So a wake is a NOOP, which breaks the IDLE, and `woken` remembers one
    // that fired while a drain was running, when there was no IDLE to break.
    let woken = false
    const wake = (): void => {
      woken = true
      void c.noop().catch(() => {})
    }
    c.on('exists', wake)
    await c.connect()
    const lock = await c.getMailboxLock(deps.config.mailbox)
    try {
      deps.log.info('inbox connected', { mailbox: deps.config.mailbox })
      deps.onLogin?.('ok')

      // Anything unseen at connect time is handled first: replies that
      // arrived while the worker was down are the ones most in need of a
      // pause. Then wait, and drain again on new mail, on the retry a
      // failed message asked for, or on the refresh — whichever is first.
      while (!stopped) {
        woken = false
        const { retryInMs } = await drainUnseen(c, {
          log: deps.log,
          handle: (source, uid) => handleInboundMessage(source, uid, handling),
          attempts,
          unrecordedStops,
          stopped: () => stopped,
        }, timing)
        if (stopped) break
        if (woken) continue
        const timer = setTimeout(wake, retryInMs ?? timing.refreshMs)
        try {
          await c.idle()
        } finally {
          clearTimeout(timer)
        }
      }
    } finally {
      c.off('exists', wake)
      lock.release()
      await c.logout().catch(() => {})
      client = null
    }
  }

  void loop()

  return async () => {
    stopped = true
    const c = client
    if (c) {
      // Breaks the idle, which ends the session, which ends the loop.
      await c.logout().catch(() => {})
    }
  }
}
