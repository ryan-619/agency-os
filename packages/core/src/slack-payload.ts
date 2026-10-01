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
}

/**
 * §2.1's Phase 4 obligation, said to a person: an opt-out that failed to
 * store. The link is the suppressions page, where it is recorded by hand.
 *
 * With no touch there is no row in the app that holds the number, and the
 * number is lead data, so it is not in the message either: the person is
 * told where it is (the provider's inbound log), and the link is the
 * Compliance page, which counts the failure by the audit row the recorder
 * wrote — never a link built from the number.
 */
export function slackOptOutNotRecordedPayload(event: SlackOptOutNotRecordedEvent, origin: string | null): SlackPayload {
  const way = event.path === 'unsubscribe' ? 'the unsubscribe link' : event.path === 'reply' ? 'a reply' : 'an erasure request'
  const lines = [
    `OPT-OUT NOT RECORDED. Somebody asked to be left alone through ${way} and no suppression row could be written. A person has to record it now.`,
  ]
  if (event.touchId === null) {
    lines.push(
      `no message on file · contact ${event.contactId ?? 'unknown'}`,
      'Nothing in the app holds the number it came from: read it from the provider’s inbound log and record it on the Suppressions page. The Compliance page counts it.',
      slackLink(origin, '/compliance') ?? 'It is counted on the Compliance page in the app.',
    )
    return slackPayloadOf(lines)
  }
  lines.push(`touch ${event.touchId} · contact ${event.contactId ?? 'unknown'}`)
  const link = slackLink(origin, '/suppressions')
  lines.push(link ?? 'Record it on the Suppressions page in the app.')
  return slackPayloadOf(lines)
}
