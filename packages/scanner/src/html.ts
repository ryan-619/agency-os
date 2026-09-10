/**
 * The small amount of HTML understanding the scanner needs, matching what
 * Python's `html.parser.HTMLParser` gives the original engine: the page title,
 * the `src` of every script tag, and whether the page offers a way to log in.
 *
 * Deliberately not a full parser. These three questions are answerable from
 * tag soup, and a dependency here would be a dependency in the one package
 * whose output has to match another language's byte for byte.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/** Mirrors HTMLParser(convert_charrefs=True). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Attributes of one tag, names lower-cased, values entity-decoded. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/g
  // Skip the tag name itself.
  const body = tag.replace(/^<\s*[a-zA-Z0-9]+/, '')
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const name = m[1]!.toLowerCase()
    let value = m[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[name] = decodeEntities(value)
  }
  return out
}

export interface HtmlFacts {
  /** Concatenated, per-chunk-stripped title text, as Python builds it. */
  readonly title: string
  readonly scripts: readonly string[]
  readonly hasLogin: boolean
}

/** Hrefs containing any of these read as a way into a product. */
const LOGIN_HREF_HINTS = ['/login', '/signin', '/sign-in', '/app', '/dashboard'] as const

export function extractHtmlFacts(html: string): HtmlFacts {
  // --- title ---------------------------------------------------------------
  // Python's HTMLParser sets its in-title flag on EVERY <title> start tag,
  // wherever it appears, and appends each stripped text chunk. Inline SVG
  // icons carry their own <title> elements, so a page's "title" is really the
  // concatenation of all of them — which is what the original engine records
  // and therefore what this has to reproduce. The 200-character check happens
  // BEFORE each append, so the result can overshoot by one chunk; the caller
  // then truncates to 160.
  let title = ''
  for (const m of html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)) {
    for (const chunk of m[1]!.split(/<[^>]*>/)) {
      if (title.length >= 200) break
      title += decodeEntities(chunk).trim()
    }
    if (title.length >= 200) break
  }

  // --- scripts and login surface -------------------------------------------
  const scripts: string[] = []
  let hasLogin = false

  for (const m of html.matchAll(/<\s*(script|input|a)\b([^>]*)>/gi)) {
    const tagName = m[1]!.toLowerCase()
    const attrs = attributes(m[0]!)

    if (tagName === 'script') {
      const src = attrs.src
      if (src) scripts.push(src)
    } else if (tagName === 'input') {
      // Python compares the raw attribute value to "password" exactly.
      if (attrs.type === 'password') hasLogin = true
    } else {
      const href = (attrs.href ?? '').toLowerCase()
      if (href && LOGIN_HREF_HINTS.some((hint) => href.includes(hint))) hasLogin = true
    }
  }

  return { title, scripts, hasLogin }
}
