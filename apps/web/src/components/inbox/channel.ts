/**
 * How /inbox words a reply's channel (0019): a text, a WhatsApp, a LinkedIn
 * message — and, for the two channels where an answer must be a registered
 * template, where the answer is written instead.
 *
 * Pure strings and one predicate, so `apps/web/test/inbox-channel.test.ts`
 * pins them. The rule itself is `replyQueueDraft`'s, which refuses a free-text
 * answer on either channel (`template_required`); this only stops the page
 * offering one.
 */

/** The label beside a reply that did not come by email. Null for email, which needs none. */
export function channelLabel(channel: string): string | null {
  switch (channel) {
    case 'email':
      return null
    case 'sms':
      return 'SMS'
    case 'whatsapp':
      return 'WhatsApp'
    case 'linkedin':
      return 'LinkedIn'
    case 'voice':
      return 'voice'
    default:
      return channel
  }
}

/** An answer on these is a registered template, never free text: no Answer box is offered. */
export function answersByTemplate(channel: string): boolean {
  return channel === 'sms' || channel === 'whatsapp'
}

/** How a reply was tied to a person when it answered nothing this system sent. */
export function matchedByWords(channel: string): string {
  return answersByTemplate(channel)
    ? 'matched by number — not to a message this system sent'
    : 'matched by address — not to a message this system sent'
}

/** Said where the Answer button would be, on a channel whose answers are templates. */
export function answerElsewhere(channel: string): string {
  return channel === 'sms'
    ? 'An SMS answer must be a registered template — draft it with Draft SMS on their row in Contacts.'
    : 'A WhatsApp answer must be a registered template, and sending WhatsApp is not available yet.'
}

/** Where Draft SMS is for this person: the contacts ledger, filtered to them. */
export function contactsLinkFor(name: string): string {
  return `/contacts?q=${encodeURIComponent(name.slice(0, 200))}`
}
