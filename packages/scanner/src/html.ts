/**
 * The three questions the scanner asks of a page's markup: what the title
 * says, what scripts it loads, and whether it offers a way to log in.
 *
 * This is a port of the `HTMLParser` subclass in the reference engine's
 * `signals.py`, sitting on the port of HTMLParser itself in htmlparser.ts.
 * It is deliberately small and deliberately literal — the answers feed a score
 * that has to match the other engine's, so "sensible" is not the goal and
 * "identical" is.
 *
 * `scriptTags` and `resourceRefs` are a PARALLEL read for the informational
 * signals (additive.ts), gathered in the same walk. They are not part of the
 * port, and `title`, `scripts` and `hasLogin` are built exactly as before —
 * html-parity.test.ts compares those three field by field and nothing else.
 */

import { parseHtml, type Attr } from './htmlparser.js'
import { pyLen, pyStrip } from './pystr.js'
import { unescape } from './unescape.js'

export { unescape as decodeEntities }

export interface HtmlFacts {
  /** Concatenated, per-chunk-stripped title text, as Python builds it. */
  readonly title: string
  readonly scripts: readonly string[]
  readonly hasLogin: boolean
  /** Every `<script src>`, with what the informational signals need to judge it. */
  readonly scriptTags: readonly ScriptTag[]
  /** Every other element that makes the browser fetch something by URL. */
  readonly resourceRefs: readonly ResourceRef[]
}

export interface ScriptTag {
  readonly src: string
  /** The `integrity` attribute; null when absent or valueless. */
  readonly integrity: string | null
  readonly crossorigin: string | null
  /**
   * Inside a `<noscript>`. HTMLParser (3.9) does not treat noscript as raw
   * text, so a script there is parsed like any other — but a browser with
   * scripting on never runs it, so it loads nothing and proves nothing.
   */
  readonly inNoscript: boolean
}

export interface ResourceRef {
  readonly tag: 'link' | 'iframe' | 'img' | 'audio' | 'video' | 'source'
  readonly url: string
  /** `<link rel>`, lower-cased; null for every other tag. */
  readonly rel: string | null
  readonly inNoscript: boolean
}

/** The elements, besides `<script>`, whose `src` the browser fetches. */
const SRC_TAGS = new Set(['iframe', 'img', 'audio', 'video', 'source'])

/** An href containing any of these reads as a way into a product. */
const LOGIN_HREF_HINTS = ['/login', '/signin', '/sign-in', '/app', '/dashboard'] as const

/** `dict(attrs)` — a later duplicate overwrites an earlier one. */
function asDict(attrs: readonly Attr[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const [name, value] of attrs) out.set(name, value)
  return out
}

export function extractHtmlFacts(html: string): HtmlFacts {
  let title = ''
  let titleLength = 0
  let inTitle = false
  const scripts: string[] = []
  let hasLogin = false
  const scriptTags: ScriptTag[] = []
  const resourceRefs: ResourceRef[] = []
  // A depth, not a flag: noscript can nest in tag soup, and a stray
  // `</noscript>` must not drive it below zero.
  let noscriptDepth = 0

  try {
    parseHtml(html, {
      starttag(tag, attrs) {
        const a = asDict(attrs)
        if (tag === 'title') {
          // The flag is set by EVERY <title>, wherever it appears. An inline
          // SVG icon carries its own, so a page's "title" is really the
          // concatenation of all of them — which is what the reference engine
          // records, and therefore what this has to reproduce.
          inTitle = true
        } else if (tag === 'script') {
          const src = a.get('src')
          if (src) {
            scripts.push(src)
            scriptTags.push({
              src,
              integrity: a.get('integrity') || null,
              crossorigin: a.get('crossorigin') ?? null,
              inNoscript: noscriptDepth > 0,
            })
          }
        } else if (tag === 'input') {
          // Compared to "password" exactly, on the decoded value.
          if (a.get('type') === 'password') hasLogin = true
        } else if (tag === 'a') {
          const href = (a.get('href') ?? '').toLowerCase()
          if (LOGIN_HREF_HINTS.some((hint) => href.includes(hint))) hasLogin = true
        } else if (tag === 'noscript') {
          noscriptDepth += 1
        } else if (tag === 'link') {
          const href = a.get('href')
          if (href) {
            resourceRefs.push({
              tag, url: href, rel: (a.get('rel') ?? '').toLowerCase(), inNoscript: noscriptDepth > 0,
            })
          }
        } else if (SRC_TAGS.has(tag)) {
          const src = a.get('src')
          if (src) {
            resourceRefs.push({
              tag: tag as ResourceRef['tag'], url: src, rel: null, inNoscript: noscriptDepth > 0,
            })
          }
        }
      },
      endtag(tag) {
        if (tag === 'title') inTitle = false
        else if (tag === 'noscript' && noscriptDepth > 0) noscriptDepth -= 1
      },
      data(text) {
        // The length check happens BEFORE the append, so the result can
        // overshoot 200 by one chunk. The caller then truncates to 160.
        if (inTitle && titleLength < 200) {
          const chunk = pyStrip(text)
          title += chunk
          titleLength += pyLen(chunk)
        }
      },
    })
  } catch {
    // `except Exception: pass` at the reference's call site. Malformed markup
    // that makes HTMLParser raise leaves the partial result standing, and the
    // rest of the document unread — by both engines, identically.
  }

  return { title, scripts, hasLogin, scriptTags, resourceRefs }
}
