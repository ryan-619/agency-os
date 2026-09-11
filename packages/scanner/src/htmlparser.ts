/**
 * A port of the part of CPython's `html.parser.HTMLParser` that the reference
 * engine uses: `HTMLParser(convert_charrefs=True)`, driven by a single
 * `feed()` and never closed.
 *
 * Why a port and not a regex, after a regex shipped first: a regex that scans
 * for `<script …>` reads markup this parser never reaches. It finds tags
 * inside comments, inside marked sections, and inside the body of a `<script>`
 * element — and it ends a tag at the first `>`, including one inside a quoted
 * attribute value. Both mistakes change what the scanner reports. A
 * commented-out IE fallback became "jQuery 1.11.0 served in production"; an
 * `<a onclick="() => go()" href="/login">` lost its href and with it the login
 * surface that qualifies the lead. PROMPT.md §2.2 is that the app must never
 * state a finding it did not observe, and markup no browser executes was not
 * observed.
 *
 * So the state machine is reproduced rather than approximated. What follows
 * mirrors parser.py function for function, names included, because the only
 * way to check this file is to read it beside that one. Verified against
 * CPython 3.9 — the interpreter tools/python-golden.py runs the reference
 * engine on.
 *
 * Only what the reference subclass observes is surfaced: start tags, end tags
 * and text. Comments, declarations and processing instructions are consumed
 * and dropped, exactly as HTMLParser's no-op handlers drop them.
 */

import { PY_SPACE_CLASS as S } from './python-tables.js'
import { pyStrip } from './pystr.js'
import { unescape } from './unescape.js'

/**
 * `_markupbase.ParserBase.error`, which HTMLParser does not override, so it
 * raises. The reference engine wraps `feed()` in `except Exception: pass` —
 * a document that trips this keeps whatever was parsed up to that point and
 * silently loses the rest. Reproduced rather than corrected: the job of this
 * file is to agree with the other engine, not to out-parse it.
 */
export class HtmlParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HtmlParseError'
  }
}

/**
 * One attribute. `value` is null for a valueless attribute (`<script src>`),
 * which Python distinguishes from `''`; the reference subclass reads both as
 * falsy, but the distinction is kept here rather than flattened.
 */
export type Attr = readonly [name: string, value: string | null]

export interface HtmlHandlers {
  /**
   * Attributes arrive as a list, duplicates included, as Python builds them.
   * The reference does `dict(attrs)`, so the LAST duplicate wins — a caller
   * that wants to match it must build the map the same way round.
   */
  starttag?(tag: string, attrs: readonly Attr[]): void
  endtag?(tag: string): void
  data?(text: string): void
}

// --- the regexes, from parser.py and _markupbase.py ------------------------
// `\s` is spelled out with the generated class throughout: Python's `\s`
// includes U+001C..U+001F and U+0085 and excludes U+FEFF, and JavaScript's
// does the reverse. Each is used with `y` (Python's `pattern.match(s, pos)`)
// or `g` (Python's `pattern.search(s, pos)`), driven by `lastIndex`.

const starttagopen = /<[a-zA-Z]/y
const piclose = />/g
const commentclose = new RegExp(`--[${S}]*>`, 'g')
const tagfind_tolerant = new RegExp(`([a-zA-Z][^\\t\\n\\r\\f />\\0]*)(?:[${S}]|/(?!>))*`, 'y')
const attrfind_tolerant = new RegExp(
  `((?<=['"${S}/])[^${S}/>][^${S}/=>]*)` +
    `([${S}]*=+[${S}]*('[^']*'|"[^"]*"|(?!['"])[^>${S}]*))?` +
    `(?:[${S}]|/(?!>))*`,
  'y',
)
const locatestarttagend_tolerant = new RegExp(
  `<[a-zA-Z][^\\t\\n\\r\\f />\\0]*` + //            tag name
    `(?:[${S}/]*` + //                              whitespace before an attribute
    `(?:(?<=['"${S}/])[^${S}/>][^${S}/=>]*` + //    attribute name
    `(?:[${S}]*=+[${S}]*` + //                      value indicator
    `(?:'[^']*'|"[^"]*"|(?!['"])[^>${S}]*)` + //    quoted or bare value
    `[${S}]*` +
    `)?(?:[${S}]|/(?!>))*` +
    `)*` +
    `)?` +
    `[${S}]*`, //                                   trailing whitespace
  'y',
)
const endendtag = />/g
const endtagfind = new RegExp(`</[${S}]*([a-zA-Z][-.a-zA-Z0-9:_]*)[${S}]*>`, 'y')
const declname_match = new RegExp(`[a-zA-Z][-_.a-zA-Z0-9]*[${S}]*`, 'y')
const markedsectionclose = new RegExp(`\\][${S}]*\\][${S}]*>`, 'g')
const msmarkedsectionclose = new RegExp(`\\][${S}]*>`, 'g')
const interesting_normal = /[&<]/g
const space_or_semicolon = new RegExp(`[${S};]`)

const CDATA_CONTENT_ELEMENTS: readonly string[] = ['script', 'style']
const MARKED_SECTION_CDATA = new Set(['temp', 'cdata', 'ignore', 'include', 'rcdata'])
const MARKED_SECTION_MS = new Set(['if', 'else', 'endif'])

/** `pattern.match(s, pos)`, for a sticky pattern. */
function matchAt(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(s)
}

/** `pattern.search(s, pos)`, for a global pattern. */
function searchFrom(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(s)
}

class Parser {
  private readonly raw: string
  private readonly n: number
  private readonly h: HtmlHandlers
  /** The element whose content is being read as CDATA, or null. */
  private cdataElem: string | null = null
  /** `self.interesting` — in CDATA mode it looks only for the closing tag. */
  private interesting: RegExp = interesting_normal

  constructor(raw: string, handlers: HtmlHandlers) {
    this.raw = raw
    this.n = raw.length
    this.h = handlers
  }

  private setCdataMode(elem: string): void {
    this.cdataElem = elem.toLowerCase()
    this.interesting = new RegExp(`</[${S}]*${this.cdataElem}[${S}]*>`, 'gi')
  }

  private clearCdataMode(): void {
    this.interesting = interesting_normal
    this.cdataElem = null
  }

  private data(text: string): void {
    this.h.data?.(text)
  }

  /**
   * `goahead(0)`. The reference calls `feed()` and never `close()`, so every
   * "wait for more input" branch is a branch that silently drops the rest of
   * the document. That is the behaviour being matched, not a bug being ported
   * by accident.
   */
  run(): void {
    const raw = this.raw
    const n = this.n
    let i = 0

    while (i < n) {
      let j: number
      if (this.cdataElem === null) {
        j = raw.indexOf('<', i)
        if (j < 0) {
          // No more tags. Python will not hand over trailing text that might
          // end in a half-delivered charref; with no close() to follow, that
          // text is simply never seen.
          const from = Math.max(i, n - 34)
          const last = raw.lastIndexOf('&')
          const amppos = last >= from ? last : -1
          if (amppos >= 0 && !space_or_semicolon.test(raw.slice(amppos))) break
          j = n
        }
      } else {
        const m = searchFrom(this.interesting, raw, i)
        if (m === null) break // in CDATA with no closing tag: the rest is lost
        j = m.index
      }

      if (i < j) {
        this.data(this.cdataElem === null ? unescape(raw.slice(i, j)) : raw.slice(i, j))
      }
      i = j
      if (i === n) break

      // Every path out of the block above leaves `i` on a '<': outside CDATA
      // because that is what was searched for, inside CDATA because
      // `interesting` is the closing tag. goahead()'s '&' branches are
      // therefore unreachable under convert_charrefs=True, and are not ported.
      let k: number
      if (matchAt(starttagopen, raw, i) !== null) k = this.parseStarttag(i)
      else if (raw.startsWith('</', i)) k = this.parseEndtag(i)
      else if (raw.startsWith('<!--', i)) k = this.parseComment(i)
      else if (raw.startsWith('<?', i)) k = this.parsePi(i)
      else if (raw.startsWith('<!', i)) k = this.parseHtmlDeclaration(i)
      else if (i + 1 < n) {
        this.data('<')
        k = i + 1
      } else break

      if (k < 0) break // `if not end: break` — the rest of the document is lost
      i = k
    }
  }

  /** `parse_html_declaration`. */
  private parseHtmlDeclaration(i: number): number {
    const raw = this.raw
    if (raw.startsWith('<!--', i)) return this.parseComment(i)
    if (raw.startsWith('<![', i)) return this.parseMarkedSection(i)
    if (raw.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const gtpos = raw.indexOf('>', i + 9)
      return gtpos === -1 ? -1 : gtpos + 1
    }
    return this.parseBogusComment(i)
  }

  /** `parse_bogus_comment`. The content goes to a no-op handler. */
  private parseBogusComment(i: number): number {
    const pos = this.raw.indexOf('>', i + 2)
    return pos === -1 ? -1 : pos + 1
  }

  /** `parse_pi`. */
  private parsePi(i: number): number {
    const m = searchFrom(piclose, this.raw, i + 2)
    return m === null ? -1 : m.index + m[0].length
  }

  /** `_markupbase.parse_comment`. The close is `--\s*>`, not `-->`. */
  private parseComment(i: number): number {
    const m = searchFrom(commentclose, this.raw, i + 4)
    return m === null ? -1 : m.index + m[0].length
  }

  /** `_markupbase._scan_name`. */
  private scanName(i: number): readonly [string | null, number] {
    const raw = this.raw
    if (i === this.n) return [null, -1]
    const m = matchAt(declname_match, raw, i)
    if (m === null) {
      throw new HtmlParseError(`expected name token at ${JSON.stringify(raw.slice(i, i + 20))}`)
    }
    const s = m[0]
    if (i + s.length === this.n) return [null, -1] // end of buffer
    return [pyStrip(s).toLowerCase(), i + s.length]
  }

  /**
   * `_markupbase.parse_marked_section`. An unrecognised keyword raises, which
   * the reference engine's `except Exception: pass` turns into "stop here and
   * keep what you have".
   */
  private parseMarkedSection(i: number): number {
    const [sectName, j] = this.scanName(i + 3)
    if (j < 0) return j
    let m: RegExpExecArray | null
    if (sectName !== null && MARKED_SECTION_CDATA.has(sectName)) {
      m = searchFrom(markedsectionclose, this.raw, i + 3)
    } else if (sectName !== null && MARKED_SECTION_MS.has(sectName)) {
      m = searchFrom(msmarkedsectionclose, this.raw, i + 3)
    } else {
      throw new HtmlParseError(
        `unknown status keyword ${JSON.stringify(this.raw.slice(i + 3, j))} in marked section`,
      )
    }
    return m === null ? -1 : m.index + m[0].length
  }

  /** `parse_starttag`. */
  private parseStarttag(i: number): number {
    const raw = this.raw
    const endpos = this.checkForWholeStartTag(i)
    if (endpos < 0) return endpos
    const starttagText = raw.slice(i, endpos)

    const attrs: Attr[] = []
    const nameMatch = matchAt(tagfind_tolerant, raw, i + 1)
    if (nameMatch === null) throw new HtmlParseError('unexpected call to parse_starttag()')
    let k = i + 1 + nameMatch[0].length
    const tag = nameMatch[1]!.toLowerCase()

    while (k < endpos) {
      const m = matchAt(attrfind_tolerant, raw, k)
      if (m === null) break
      const attrname = m[1]!
      const rest = m[2]
      let attrvalue: string | null = m[3] ?? null
      if (!rest) {
        attrvalue = null
      } else if (
        attrvalue !== null &&
        ((attrvalue.startsWith("'") && attrvalue.endsWith("'")) ||
          (attrvalue.startsWith('"') && attrvalue.endsWith('"')))
      ) {
        attrvalue = attrvalue.slice(1, -1)
      }
      if (attrvalue) attrvalue = unescape(attrvalue)
      attrs.push([attrname.toLowerCase(), attrvalue])
      const next = k + m[0].length
      // The name group is not optional, so the match is never empty and this
      // cannot spin. Guarded anyway: a hang is a worse failure than a miss.
      if (next <= k) break
      k = next
    }

    const end = pyStrip(raw.slice(k, endpos))
    if (end !== '>' && end !== '/>') {
      // Not a tag after all, so the whole thing is text. This is what turns
      // `<a href=">` into data rather than into a link.
      this.data(starttagText)
      return endpos
    }
    if (end === '/>') {
      // handle_startendtag: an XHTML-style empty element opens and closes.
      this.h.starttag?.(tag, attrs)
      this.h.endtag?.(tag)
    } else {
      this.h.starttag?.(tag, attrs)
      if (CDATA_CONTENT_ELEMENTS.includes(tag)) this.setCdataMode(tag)
    }
    return endpos
  }

  /**
   * `check_for_whole_start_tag`. This is the quote-aware scan a plain
   * `<[^>]*>` lacks: a `>` inside a quoted attribute value does not end the
   * tag.
   */
  private checkForWholeStartTag(i: number): number {
    const raw = this.raw
    const m = matchAt(locatestarttagend_tolerant, raw, i)
    if (m === null) throw new HtmlParseError('we should not get here!')
    const j = i + m[0].length
    const next = raw.slice(j, j + 1)
    if (next === '>') return j + 1
    if (next === '/') {
      if (raw.startsWith('/>', j)) return j + 2
      return -1 // a lone '/' is a buffer boundary to Python
    }
    if (next === '') return -1 // end of input
    if (/[a-zA-Z=/]/.test(next)) return -1 // ended in or before an attribute value
    return j > i ? j : i + 1
  }

  /** `parse_endtag`. */
  private parseEndtag(i: number): number {
    const raw = this.raw
    const gt = searchFrom(endendtag, raw, i + 1)
    if (gt === null) return -1
    const gtpos = gt.index + gt[0].length

    const m = matchAt(endtagfind, raw, i)
    if (m === null) {
      if (this.cdataElem !== null) {
        // Inside <script>, `</p>` is just more script text.
        this.data(raw.slice(i, gtpos))
        return gtpos
      }
      const namematch = matchAt(tagfind_tolerant, raw, i + 2)
      if (namematch === null) {
        if (raw.slice(i, i + 3) === '</>') return i + 3
        return this.parseBogusComment(i)
      }
      const tagname = namematch[1]!.toLowerCase()
      const after = raw.indexOf('>', i + 2 + namematch[0].length)
      this.h.endtag?.(tagname)
      return after + 1
    }

    const elem = m[1]!.toLowerCase()
    if (this.cdataElem !== null && elem !== this.cdataElem) {
      this.data(raw.slice(i, gtpos))
      return gtpos
    }
    this.h.endtag?.(elem)
    this.clearCdataMode()
    return gtpos
  }
}

/**
 * `p = Parser(); p.feed(html)` — one shot, never closed, matching the
 * reference. Throws `HtmlParseError` where Python's `error()` raises; the
 * caller decides whether to keep the partial result, as the reference does.
 */
export function parseHtml(html: string, handlers: HtmlHandlers): void {
  new Parser(html, handlers).run()
}
