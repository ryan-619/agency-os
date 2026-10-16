/**
 * The Slack message TWO processes post, built in one place so they post the
 * same bytes (§5.5's spirit: Slack gets ids and a link, never lead data).
 *
 * The web app's `slackMessage` (apps/web/src/lib/slack-message.ts) builds
 * every notification it sends. One of them has a second sender: an opt-out
 * that could not be recorded. The web routes raise it for a one-click
 * unsubscribe, an erasure and a reply through a webhook; the worker raises
 * it for a reply it read over IMAP (apps/agent/src/notify.ts). A person in
 * the channel must not be able to tell which process noticed, and the
 * content rule must not depend on which one wrote the message — so the
 * builder lives here and both call it.
 *
 * The content rule: the event, the row ids, and a deep link back into the
 * app — where the session, the role and the audit log are — and NEVER a
 * body, a name, an address, a phone number or a company row's name (a
 * free-mail lead's company is `<address>.inbound`, the person's address
 * with its punctuation swapped). The event type below has no field that
 * could hold one, which is how the rule is kept: the builder cannot leak
 * what it was not given.
 *
 * The origin is an argument — the web's `AUTH_URL`, the worker's
 * `WEB_PUBLIC_URL`, never a request's Host header — and it may be null: a
 * worker with no `WEB_PUBLIC_URL` does not know where the app is, and posts
 * the alarm without a link rather than invent one.
 *
 * Pure: no environment, no network.
 */

export interface SlackPayload {
  readonly text: string
  readonly blocks?: readonly unknown[]
}

/** Slack refuses a `text` past this; a long message is cut, not dropped. */
export const SLACK_PAYLOAD_MAX_TEXT = 4000

/** Lines as one message, cut at Slack's limit with an ellipsis. */
export function slackPayloadOf(lines: readonly string[]): SlackPayload {
  const text = lines.join('\n')
  return { text: text.length > SLACK_PAYLOAD_MAX_TEXT ? `${text.slice(0, SLACK_PAYLOAD_MAX_TEXT - 1)}…` : text }
}

/** A deep link into the app, or null when there is no origin to build one on. */
export function slackLink(origin: string | null, path: string): string | null {
  if (origin === null) return null
  return `${origin.replace(/\/+$/, '')}${path}`
}

/** Somebody asked to be left alone and no suppression row could be written. */
export interface SlackOptOutNotRecordedEvent {
  readonly kind: 'opt_out_not_recorded'
  readonly orgId: string
  /**
   * The touch the request arrived on: the clicked message, or the inbound
   * reply. Null when there is none — a STOP texted from a number no single
   * contact holds is filed under nobody, so no message row records it, and
   * the alarm must still go.
   */
  readonly touchId: string | null
  readonly contactId: string | null
  /** Which way the person asked: the unsubscribe link, an erasure, or a reply that said stop. */
  readonly path: 'unsubscribe' | 'erasure' | 'reply'
  /**
   * False when the reply came from another address than the contact the
   * message went to — a colleague in the thread replying all (review round
   * 7). Their address is the one to record, and the contact's is not, so
   * the message says so; absent, nothing is said about the sender. A
   * boolean, never the address (the rule above).
   */
  readonly fromIsContact?: false
}

/**
 * §2.1's Phase 4 obligation, said to a person: an opt-out that failed to
 * store. The link is the suppressions page, where it is recorded by hand.
 *
 * With no touch and no contact, whose number it was is not known to the
 * writer, and the number is lead data, so it is not in the message either:
 * the person is told where it is (the provider's inbound log), and the link
 * is the Compliance page, which counts the failure by the audit row the
 * recorder wrote — never a link built from the number. It says only what
 * is known (review round 7): a recording that threw may have recorded part
 * of it, or an earlier delivery all of it, so the person is told to CHECK
 * the suppression list first, not that the number is missing from it.
 */
export function slackOptOutNotRecordedPayload(event: SlackOptOutNotRecordedEvent, origin: string | null): SlackPayload {
  const way = event.path === 'unsubscribe' ? 'the unsubscribe link' : event.path === 'reply' ? 'a reply' : 'an erasure request'
  const lines = [
    `OPT-OUT NOT RECORDED. Somebody asked to be left alone through ${way} and no suppression row could be written. A person has to record it now.`,
  ]
  if (event.fromIsContact === false) {
    // A colleague's stop, filed under the contact our message went to. The
    // contact's address is the wrong one to record, and the reply may not
    // be stored yet (its recording threw), so the address to record is in
    // the mail itself; a retry that records it may have suppressed it since.
    lines.push(`${event.touchId === null ? 'no message on file' : `touch ${event.touchId}`} · sent by somebody other than the contact`)
    lines.push(
      'The reply came from another address than the contact that message went to, so record THAT address, never the contact’s: read it from the mail itself, check the Suppressions page for it, and record it there if it is missing.',
    )
    lines.push(slackLink(origin, '/suppressions') ?? 'Record it on the Suppressions page in the app.')
    return slackPayloadOf(lines)
  }
  if (event.touchId === null && event.contactId !== null) {
    // A reply matched to a contact by its sender's address alone (no
    // message of ours named): the contact's record holds the address, so the
    // person records it from there — "nothing in the app holds it" is false.
    lines.push(`no message on file · contact ${event.contactId}`)
    lines.push(slackLink(origin, '/suppressions') ?? 'Record it on the Suppressions page in the app.')
    return slackPayloadOf(lines)
  }
  if (event.touchId === null) {
    lines.push(
      'no message or contact named',
      'Whose number it was is not known here, and it may not be on the suppression list: check the Suppressions page for the number in the provider’s inbound log, and record it there if it is missing. Anybody holding the number may already be paused. The Compliance page counts it.',
      slackLink(origin, '/compliance') ?? 'It is counted on the Compliance page in the app.',
    )
    return slackPayloadOf(lines)
  }
  lines.push(`touch ${event.touchId} · contact ${event.contactId ?? 'unknown'}`)
  const link = slackLink(origin, '/suppressions')
  lines.push(link ?? 'Record it on the Suppressions page in the app.')
  return slackPayloadOf(lines)
}
