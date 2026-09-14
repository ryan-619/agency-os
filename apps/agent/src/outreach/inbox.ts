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
 *  - **Process a message twice.** Each UID is marked `\Seen` after handling
 *    and the fetch asks for unseen only, so a reconnect does not replay the
 *    inbox. It means this listener must own the mailbox: a person reading
 *    the same inbox in a mail client marks things seen too, and a reply they
 *    opened first is one this never sees. Documented in .env.example.
 *  - **Die on one bad email.** Every message is handled in its own try; the
 *    connection is re-established on its own schedule; and nothing here can
 *    stop the worker's other work.
 *  - **Log a body.** §2.3. The log carries the outcome and the touch id.
 */
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { handleInboundEmail, type AgencyDb } from '@agency/db'
import type { Logger } from '../logger.js'

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
  /** For tests. Defaults to the wall clock. */
  readonly now?: () => Date
}

/** Back-off between reconnects. Starts short, doubles, stops growing at five minutes. */
const RECONNECT_MIN_MS = 5_000
const RECONNECT_MAX_MS = 5 * 60_000

/**
 * The parsed shape `handleInboundEmail` wants, from a raw RFC 5322 message.
 *
 * Exported so the parsing can be tested without a mailbox: an email is a
 * surprisingly hostile input, and the interesting failures — a From with a
 * display name and no angle brackets, a References header folded across
 * lines, HTML with no text part — are all in this function.
 */
export async function parseInbound(raw: Buffer | string): Promise<{
  from: string
  subject: string | null
  text: string | null
  messageId: string | null
  references: string[]
} | null> {
  const parsed = await simpleParser(raw)
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

  return {
    from,
    subject: parsed.subject ?? null,
    // The text part, or the HTML stripped to text if that is all there is. A
    // reply that is only HTML must still be readable for the opt-out check.
    text: parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null),
    messageId: parsed.messageId ?? null,
    references: [...new Set(refs)],
  }
}

/**
 * Listen for replies until stopped.
 *
 * Returns a stop function. The loop inside reconnects forever with back-off;
 * `stop` breaks it and closes the connection cleanly.
 */
export function startInbox(deps: InboxDeps): () => Promise<void> {
  let stopped = false
  let client: ImapFlow | null = null
  let backoff = RECONNECT_MIN_MS

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await session()
        backoff = RECONNECT_MIN_MS
      } catch (err) {
        if (stopped) break
        deps.log.warn('inbox connection dropped; reconnecting', {
          error: err instanceof Error ? err.name : 'UnknownError',
          inMs: backoff,
        })
        await new Promise<void>((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
      }
    }
  }

  const session = async (): Promise<void> => {
    const c = new ImapFlow({
      host: deps.config.host,
      port: deps.config.port,
      secure: deps.config.secure,
      auth: { user: deps.config.user, pass: deps.config.password },
      // imapflow logs at debug level by default, and its log lines include
      // message envelopes. Off, for §2.3.
      logger: false,
      emitLogs: false,
    })
    client = c
    await c.connect()
    const lock = await c.getMailboxLock(deps.config.mailbox)
    try {
      deps.log.info('inbox connected', { mailbox: deps.config.mailbox })

      // Anything unseen at connect time is handled first: replies that
      // arrived while the worker was down are the ones most in need of a
      // pause.
      await drain(c)

      // Then wait. `idle()` resolves when the server reports a change or the
      // idle window ends; either way, drain and idle again. imapflow emits
      // 'exists' for new mail, which is what wakes the idle.
      while (!stopped) {
        await c.idle()
        if (stopped) break
        await drain(c)
      }
    } finally {
      lock.release()
      await c.logout().catch(() => {})
      client = null
    }
  }

  const drain = async (c: ImapFlow): Promise<void> => {
    // UIDs of everything not yet seen. `search` returns them in mailbox
    // order; `false` means the mailbox is empty, which imapflow types as a
    // possible result.
    const uids = await c.search({ seen: false }, { uid: true })
    if (!uids || uids.length === 0) return

    for (const uid of uids) {
      if (stopped) return
      try {
        const msg = await c.fetchOne(String(uid), { source: true }, { uid: true })
        if (!msg || !msg.source) continue
        const mail = await parseInbound(msg.source)
        if (!mail) {
          deps.log.info('inbound mail had no readable sender; skipped', { uid })
        } else {
          const outcome = await handleInboundEmail(deps.db, { ...mail, ...(deps.now ? { now: deps.now() } : {}) })
          if (outcome.matched === 'none') {
            deps.log.info('inbound mail did not match a contact', { uid, why: outcome.why })
          } else {
            deps.log.info('inbound reply recorded', {
              uid,
              matched: outcome.matched,
              touchId: outcome.touchId,
              paused: outcome.paused,
              suppressed: outcome.suppressed,
            })
          }
        }
      } catch (err) {
        deps.log.error('could not handle an inbound message', {
          uid,
          error: err instanceof Error ? err.name : 'UnknownError',
        })
      } finally {
        // Seen whatever happened. A message that failed to parse will fail
        // again; leaving it unseen would make every drain retry it forever.
        await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {})
      }
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
