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

/**
 * HTML as text, a block element per line and a `<blockquote>` opened with `> `. See the header.
 *
 * Six passes, in this order, each over the previous one's output: script,
 * style, head and title elements dropped whole; comments dropped; a
 * `<blockquote>` opened with `> `; `<br>` as a line end; a block element's
 * tag as a line end; any other tag as a space. Each pass answers exactly
 * what the regex it replaced answered (`/<[^>]*>/g` for the last, and so
 * on — html-text.test.ts keeps those regexes as its reference), and each is
 * a forward scan that STOPS at the first closing marker that never comes.
 * The regexes did not stop: with no `>` after them, `<[^>]*>` retried from
 * every one of 200,000 `<` and read to the end each time — 50 s of one
 * thread for one email any stranger could send, on the worker's only event
 * loop or in the Resend webhook. Found by review.
 */
export function htmlToText(html: string): string {
  let flat = html.slice(0, HTML_TEXT_MAX_INPUT)
  flat = dropElements(flat)
  flat = dropComments(flat)
  flat = replaceTags(flat, /<blockquote\b/gi, '\n> ')
  // Bounded on its own: `\s*` reads one run of whitespace per `<br`, and the
  // runs after two different `<br` never overlap.
  flat = flat.replace(/<br\s*\/?>/gi, '\n')
  flat = replaceTags(flat, /<\/?(?:p|div|li|ul|ol|tr|table|h[1-6]|blockquote|pre|section|article|header|footer|hr)\b/gi, '\n')
  flat = replaceTags(flat, /</g, ' ')
  return decodeHtmlEntities(flat)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * `s.replace(OPENER[^>]*>, by)` — a tag that starts with what `opener`
 * matches and runs to the first `>` after it — in one forward pass.
 *
 * `opener` must be global (`g`). The first `>` at or after a position is
 * remembered until the scan passes it, and once there is none, no later
 * opener can close either: the scan stops and the rest is kept as it is,
 * which is what the regex left after failing at every one of them.
 */
function replaceTags(s: string, opener: RegExp, by: string): string {
  let out = ''
  let kept = 0
  let gt = -1
  opener.lastIndex = 0
  for (let m = opener.exec(s); m !== null; m = opener.exec(s)) {
    const from = m.index + m[0].length
    if (gt < from) gt = s.indexOf('>', from)
    if (gt === -1) break
    out += s.slice(kept, m.index) + by
    kept = gt + 1
    opener.lastIndex = kept
  }
  return out + s.slice(kept)
}

/**
 * `s.replace(/<!--[\s\S]*?-->/g, '')` in one forward pass. A comment with
 * no `-->` after it is kept, and so is everything after it: a later `<!--`
 * could only close on a `-->` that is not there.
 */
function dropComments(s: string): string {
  let out = ''
  let kept = 0
  for (let open = s.indexOf('<!--'); open !== -1; open = s.indexOf('<!--', kept)) {
    const close = s.indexOf('-->', open + 4)
    if (close === -1) break
    out += s.slice(kept, open)
    kept = close + 3
  }
  return out + s.slice(kept)
}

const DROPPED_ELEMENTS = ['script', 'style', 'head', 'title'] as const

/**
 * `s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')`
 * in one forward pass: an element whose opening tag closes and whose
 * closing tag follows is dropped whole, contents and all.
 *
 * The cost the regex paid for an element that is never closed — reading to
 * the end once per opening tag — is paid once per NAME here: a search for
 * `</script>` that found nothing from one position finds nothing from any
 * later one, so it is not run again. An unclosed element is kept for the
 * later passes, which turn its tags into spaces and keep its words, as
 * before.
 */
function dropElements(s: string): string {
  const opener = /<(script|style|head|title)\b/gi
  const closers = new Map<string, RegExp>(
    DROPPED_ELEMENTS.map((name) => [name, new RegExp(`<\\/${name}\\s*>`, 'gi')]),
  )
  const neverClosed = new Set<string>()
  let out = ''
  let kept = 0
  let gt = -1
  for (let m = opener.exec(s); m !== null; m = opener.exec(s)) {
    const from = m.index + m[0].length
    if (gt < from) gt = s.indexOf('>', from)
    // No `>` after this opener means none after any later one either.
    if (gt === -1) break
    const name = m[1]!.toLowerCase()
    const closer = closers.get(name)
    if (!closer || neverClosed.has(name)) continue
    closer.lastIndex = gt + 1
    const close = closer.exec(s)
    if (!close) {
      neverClosed.add(name)
      continue
    }
    out += s.slice(kept, m.index)
    kept = close.index + close[0].length
    opener.lastIndex = kept
  }
  return out + s.slice(kept)
}
