/**
 * An HTML-only reply as text, KEEPING ITS LINES — the one converter every
 * inbound path uses (§2.1: "stop" must mean the same thing whichever way it
 * arrived).
 *
 * The lines are the point. The opt-out reader (`looksLikeOptOut`) reads the
 * person's own words — the first line, above anything quoted — and a quote
 * is recognised by a line that starts `>` or reads `On … wrote:`
 * (`ownWords`). Flattened to a single line, `Stop<blockquote>…` becomes
 * `Stop On Mon, … wrote: …`: not a line that IS an opt-out, so the reply
 * pauses the contact but never suppresses them. Here a block element ends a
 * line and a `<blockquote>` opens one with `>`, so the same reply reads
 * `Stop` above a quote.
 *
 * Two callers, one rule: the Resend inbound route (whose receiving API
 * hands over `html` with no plain part) and the worker's IMAP parser, for
 * an HTML part mailparser leaves unconverted — one that is not the root of
 * the message, as in Outlook's multipart/related. The worker used to strip
 * tags to one line, which was the open finding this module closed.
 *
 * Not an HTML parser, and it does not need to be one: the output is read
 * for a handful of words and stored as a reply's text. Script, style and
 * comments are dropped whole, so their contents are never read as words.
 * Pure: a string in, a string out.
 */

/** The work of converting is bounded: past this many characters the HTML is not read. */
export const HTML_TEXT_MAX_INPUT = 200_000

const ENTITIES: Readonly<Record<string, string>> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * Character references and the six named entities a mail client writes, in
 * ONE pass, so `&amp;lt;` becomes `&lt;` and not `<`. A reference that names
 * no character — `&#0;`, a lone surrogate, an unknown name — is left as it
 * was rather than guessed at.
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (whole, e: string) => {
    if (e.startsWith('#')) {
      const hex = e[1] === 'x' || e[1] === 'X'
      const cp = Number.parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10)
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })
}

/** HTML as text, a block element per line and a `<blockquote>` opened with `> `. See the header. */
export function htmlToText(html: string): string {
  const flat = html
    .slice(0, HTML_TEXT_MAX_INPUT)
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|li|ul|ol|tr|table|h[1-6]|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return decodeHtmlEntities(flat)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
