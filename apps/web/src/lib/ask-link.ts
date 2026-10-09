/**
 * "Ask the assistant about this" (2026-10-09): a link from a record to
 * chat with the question already typed.
 *
 * The record pages know what they show; chat knows the tools. The link is
 * the hand-off: `/chat?ask=<words>` opens the person's newest thread with
 * the words in the composer and nothing sent — the person reads them,
 * changes them, and presses Send, or does not. The words name the record
 * by its domain or title, so the assistant can look it up with its own
 * tools; they carry no address, number or reply text. Bounded, because a
 * query string is an input like any other.
 *
 * No `server-only` and no `@/` import: `test/ask-link.test.ts` imports it.
 */

export const ASK_MAX_CHARS = 1000

/** The words a query carried, as the composer may start from them — trimmed, bounded, or nothing. */
export function askDraftFrom(param: string | string[] | undefined): string {
  const raw = Array.isArray(param) ? param[0] : param
  if (typeof raw !== 'string') return ''
  const words = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return [...words].slice(0, ASK_MAX_CHARS).join('')
}

/** The link that opens chat with these words typed. */
export function askLink(words: string): string {
  return `/chat?ask=${encodeURIComponent([...words.trim()].slice(0, ASK_MAX_CHARS).join(''))}`
}

export function askAboutCompany(domain: string, name: string | null): string {
  const who = name ? `${name} (${domain})` : domain
  return `About ${who}: read what we know — the latest scan, what they need, the deal and the conversation so far — and tell me the one thing most worth doing next, and why.`
}

export function askAboutReply(domain: string | null, name: string | null): string {
  const who = name && domain ? `${name} (${domain})` : (domain ?? name ?? 'this company')
  return `A reply from ${who} is waiting in the inbox. Read it with get_replies, look at the company, and suggest how to answer — without sending anything.`
}

export function askAboutDeal(domain: string, name: string | null): string {
  const who = name ? `${name} (${domain})` : domain
  return `The deal with ${who}: where it is, what has happened, and what would move it this week.`
}
