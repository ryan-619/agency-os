/**
 * An HTML-only email as text, KEEPING ITS LINES — one converter for both
 * inbound paths: the Resend reader (`mapReceivedEmail`, apps/web) and the
 * worker's IMAP listener (`parseInbound`, apps/agent).
 *
 * The lines are the point. The opt-out reader (`looksLikeOptOut`, in the send
 * path) reads the person's own words — the first line, above anything quoted
 * — and a quote is recognised by a line that starts `>` or reads
 * `On … wrote:`. Flattening HTML to a single line turns `Stop<blockquote>…`
 * into `Stop On Mon, … wrote: …`: not a line that IS an opt-out, so the reply
 * pauses the contact but never suppresses them, and the person who asked to
 * be left alone is one "resume" away from being written to again (§2.1).
 * The worker's fallback did exactly that until it used this, which is why the
 * converter lives here rather than in either app.
 *
 * Where the worker reaches it: only when mailparser leaves `text` empty —
 * HTML inside a multipart with no text/plain part (`multipart/related` with
 * an inline logo, `multipart/mixed` with an attachment, an `alternative`
 * holding only HTML). A single-part `text/html` message never gets here;
 * mailparser converts that one itself, and keeps its lines too.
 *
 * Pure. No I/O, and nothing here decides anything — it produces text for the
 * reader in packages/db to read.
 */

/** HTML is converted before any caller's text bound applies; this bounds the work of converting it. */
const MAX_HTML = 200_000

const ENTITIES: Readonly<Record<string, string>> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  // One pass, so `&amp;lt;` becomes `&lt;` and not `<`.
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (whole, e: string) => {
    if (e.startsWith('#')) {
      const hex = e[1] === 'x' || e[1] === 'X'
      const cp = Number.parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10)
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })
}

/**
 * HTML as text, with its lines kept: a block element or `<br>` ends a line
 * and a `<blockquote>` opens one with `>`, so Gmail's one-word reply above
 * the quoted original reads `Stop` above a quote.
 *
 * Not an HTML parser, and it does not need to be one: the output is read
 * for a handful of words and stored as a reply's text. Script, style and
 * comments are dropped whole, so their contents are never read as words.
 * Entities are decoded once, after the tags are gone, so `&lt;b&gt;` in
 * somebody's text stays text rather than being stripped as a tag.
 */
export function htmlToText(html: string): string {
  const flat = html
    .slice(0, MAX_HTML)
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|li|ul|ol|tr|table|h[1-6]|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(flat)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
