/**
 * Where a contact's email and phone number came from (0029), as a person
 * reads it.
 *
 * The assistant stored addresses it had composed — a first name at a
 * company's domain, `info@` a site that answers no mail — and openers were
 * mailed to them and bounced. Nothing on any screen told an address a
 * teammate had typed from one a page showed, or from one nobody could vouch
 * for. So each email and phone carries its source (`contacts.email_source`,
 * `contacts.phone_source`), and every screen that shows the address shows
 * where it came from under it: /contacts, the company page's People, and the
 * recipient on /approvals — the moment somebody decides a message goes to
 * it. The words are core's (`addressSourceWords`), so the three screens and
 * the assistant's own tools cannot word one source two ways.
 *
 * And the one place a PERSON's address gets its source: the contacts routes
 * stamp `person` beside an address that was given (`personAddressSources`),
 * from the session, never from the request body — a source a browser could
 * name would be a claim anybody could make.
 *
 * Pure: no `server-only`, no `@/` import, no environment. A test imports it
 * directly, and vitest has neither.
 */
import { addressSourceWords } from '@agency/core'

export interface AddressSourceLine {
  /** The whole phrase, as core words it — "seen on 127atelier.in/pages/contact", "typed by a teammate". */
  readonly words: string
  /**
   * `warn` when nobody can vouch for the address: the assistant added it
   * before sources were kept, which is how the guessed addresses got in.
   */
  readonly tone: 'ok' | 'warn'
  /**
   * The page the address was seen on, to open in a new tab — only an
   * http(s) page on the public web, with no username, password or port in
   * its address (`pageHref`). Null for every other source.
   */
  readonly href: string | null
  /** With `href`: the words before the link ("seen on "). Otherwise empty. */
  readonly before: string
  /** With `href`: the link's own text (the page, as a person reads it). Otherwise the whole of `words`. */
  readonly linkText: string
}

const SEEN_ON = 'seen on '

/** The stored source as a page's address: http(s), parseable, no username or password in it. */
function pageUrl(source: string | null | undefined): URL | null {
  if (!source || !/^https?:\/\//i.test(source)) return null
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  return url
}

/** Names no page on the public web answers to — the Research card's list (0028), and `localhost` under any of them. */
const LOCAL_HOST = /(?:^|\.)(?:localhost|local|internal|lan|home|corp|test|invalid|example)$/i
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * The stored source as a link, or null: a page on the public web and nothing
 * else, as the Research card links only one (0028). The page reader refuses
 * every other kind of address, so a stored source should never be one; but a
 * link a teammate clicks goes from THEIR browser, on their network, so an IP
 * literal, a single-label name, a local name or an explicit port is shown as
 * words and never opened from here. (The URL parser has already turned
 * `127.1` and `0x7f.1` into a dotted quad.)
 */
function pageHref(source: string | null | undefined): string | null {
  const url = pageUrl(source)
  if (!url) return null
  const host = url.hostname
  if (url.port || host.startsWith('[') || IPV4_LITERAL.test(host) || !host.includes('.') || LOCAL_HOST.test(host)) {
    return null
  }
  return url.href
}

/**
 * The line shown under an address: what core says of its source, and the
 * page to open when the source is one. `contactSource` is the contact ROW's
 * `source` (`agent` for the assistant's), which is what tells an address
 * the assistant added before 0029 — the likeliest to be a guess — from one a
 * teammate typed before anybody recorded it.
 */
export function addressSourceLine(
  source: string | null | undefined,
  contactSource?: string | null,
): AddressSourceLine {
  const { words, tone } = addressSourceWords(source ?? null, contactSource ?? null)
  const href = pageHref(source)
  if (href && words.startsWith(SEEN_ON)) {
    return { words, tone, href, before: SEEN_ON, linkText: words.slice(SEEN_ON.length) }
  }
  // Only the words about a page are ever a link.
  return { words, tone, href: null, before: '', linkText: words }
}

/** The fields of a contact row the line is built from. */
export interface ContactAddressSources {
  readonly email: string | null
  readonly phone: string | null
  readonly emailSource?: string | null
  readonly phoneSource?: string | null
  /** The row's own `source` — `agent`, `manual`, `import`, `inbound`, `apollo`. */
  readonly source?: string | null
}

/** One line per address the contact HAS; null for an address they do not. */
export function contactAddressSources(c: ContactAddressSources): {
  readonly email: AddressSourceLine | null
  readonly phone: AddressSourceLine | null
} {
  return {
    email: c.email ? addressSourceLine(c.emailSource, c.source) : null,
    phone: c.phone ? addressSourceLine(c.phoneSource, c.source) : null,
  }
}

export interface RecipientAddressSource {
  /** Which address the channel would use, as the hint names it. */
  readonly label: 'Their email address' | 'Their number'
  readonly line: AddressSourceLine
}

/**
 * Where the address a draft would go to came from, by the draft's channel —
 * the address `recipientFor` would use. Email reads the email, SMS, voice
 * and WhatsApp the phone; LinkedIn records no source (a profile is not an
 * address anybody types or a page shows as one), so it has none, and nor
 * does a contact without the address.
 */
export function recipientAddressSource(channel: string, c: ContactAddressSources): RecipientAddressSource | null {
  const lines = contactAddressSources(c)
  switch (channel) {
    case 'email':
      return lines.email ? { label: 'Their email address', line: lines.email } : null
    case 'sms':
    case 'voice':
    case 'whatsapp':
      return lines.phone ? { label: 'Their number', line: lines.phone } : null
    default:
      return null
  }
}

/** `label: words`, for a place that takes text and no link — a tooltip, a toast. */
export function recipientSourceSentence(r: RecipientAddressSource): string {
  return `${r.label}: ${r.line.words}`
}

/**
 * The sources a teammate's own edit records: `person` beside each address
 * they gave, and none where they gave none — a source with no address is
 * refused by `createContact`. Whatever the request body said about sources
 * is not read: the route overrides it with this.
 */
export function personAddressSources(input: {
  readonly email?: string | null
  readonly phone?: string | null
}): { readonly emailSource: 'person' | null; readonly phoneSource: 'person' | null } {
  return {
    emailSource: input.email?.trim() ? 'person' : null,
    phoneSource: input.phone?.trim() ? 'person' : null,
  }
}

/**
 * What kind of source a stored one is, for an audit row: a kind word and
 * never the value, because a source can be a page's address and the log
 * outlives an erasure (§2.3). The four `contact.created` carries; an
 * import's or a form's source is recorded by its own writer, not here.
 */
export type AddressSourceKind = 'page' | 'chat' | 'connector' | 'person'

export function addressSourceKind(source: string | null | undefined): AddressSourceKind | null {
  if (!source) return null
  if (source === 'person') return 'person'
  if (source === 'chat') return 'chat'
  if (/^connector:[a-z0-9][a-z0-9-]*$/.test(source)) return 'connector'
  // A page, whether or not this app would link it.
  if (pageUrl(source)) return 'page'
  return null
}

/** How the /audit sentence words each kind — about a contact being added, so in the past. */
export const ADDRESS_SOURCE_KIND_WORDS: Readonly<Record<AddressSourceKind, string>> = Object.freeze({
  page: 'seen on a page',
  chat: 'typed in chat by the person the assistant was helping',
  connector: 'returned by a connector',
  person: 'typed in by hand',
})
