/**
 * The three questions the scanner asks of a page's markup: what the title
 * says, what scripts it loads, and whether it offers a way to log in.
 *
 * This is a port of the `HTMLParser` subclass in the reference engine's
 * `signals.py`, sitting on the port of HTMLParser itself in htmlparser.ts.
 * It is deliberately small and deliberately literal — the answers feed a score
 * that has to match the other engine's, so "sensible" is not the goal and
 * "identical" is.
 */

import { parseHtml, pyStrip, type Attr } from './htmlparser.js'
import { unescape } from './unescape.js'

export { unescape as decodeEntities }

export interface HtmlFacts {
  /** Concatenated, per-chunk-stripped title text, as Python builds it. */
  readonly title: string
  readonly scripts: readonly string[]
  readonly hasLogin: boolean
}

/** An href containing any of these reads as a way into a product. */
const LOGIN_HREF_HINTS = ['/login', '/signin', '/sign-in', '/app', '/dashboard'] as const

/** `dict(attrs)` — a later duplicate overwrites an earlier one. */
function asDict(attrs: readonly Attr[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const [name, value] of attrs) out.set(name, value)
  return out
}

/** `len(s)` — Python counts code points, JavaScript counts UTF-16 units. */
function codePointLength(s: string): number {
  let count = 0
  for (const _ of s) count += 1
  return count
}

export function extractHtmlFacts(html: string): HtmlFacts {
  let title = ''
  let titleLength = 0
  let inTitle = false
  const scripts: string[] = []
  let hasLogin = false

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
          if (src) scripts.push(src)
        } else if (tag === 'input') {
          // Compared to "password" exactly, on the decoded value.
          if (a.get('type') === 'password') hasLogin = true
        } else if (tag === 'a') {
          const href = (a.get('href') ?? '').toLowerCase()
          if (LOGIN_HREF_HINTS.some((hint) => href.includes(hint))) hasLogin = true
        }
      },
      endtag(tag) {
        if (tag === 'title') inTitle = false
      },
      data(text) {
        // The length check happens BEFORE the append, so the result can
        // overshoot 200 by one chunk. The caller then truncates to 160.
        if (inTitle && titleLength < 200) {
          const chunk = pyStrip(text)
          title += chunk
          titleLength += codePointLength(chunk)
        }
      },
    })
  } catch {
    // `except Exception: pass` at the reference's call site. Malformed markup
    // that makes HTMLParser raise leaves the partial result standing, and the
    // rest of the document unread — by both engines, identically.
  }

  return { title, scripts, hasLogin }
}
