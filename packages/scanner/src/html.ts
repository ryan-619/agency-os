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
 * So is `page` (2026-10-08): what the website-presence signals (presence.ts)
 * read — meta tags, link KINDS (never a number or an address), forms, inline
 * script markers, the real title, footer years — and whether the walk reached
 * the end of the page, because an absence read off half a page is no reading.
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
  /** The website-presence read (presence.ts). Not part of the port. */
  readonly page: PageFacts
}

/**
 * What a visitor's view of the homepage is made of, for the website-presence
 * signals. Contact links are COUNTED and never kept: a `tel:` or `mailto:`
 * value is a person's number or address, and findings are shown and exported.
 */
export interface PageFacts {
  /** The walk reached `</body>` or `</html>`: an absence read from it is a reading. */
  readonly complete: boolean
  /** The first `<title>` outside an inline SVG, whitespace collapsed; null when none. */
  readonly realTitle: string | null
  readonly viewport: string | null
  readonly description: string | null
  readonly generator: string | null
  /** The Open Graph properties present (`og:title`, `og:image`, …), lower-cased. */
  readonly openGraph: readonly string[]
  /** JSON-LD blocks, and schema.org microdata scopes. */
  readonly structuredBlocks: number
  /** The `@type`s named in JSON-LD and microdata, at most ten. */
  readonly structuredTypes: readonly string[]
  readonly telLinks: number
  readonly mailtoLinks: number
  readonly whatsappLinks: number
  readonly forms: number
  /** Social platforms the page links to: instagram, facebook, linkedin, youtube, x. */
  readonly socialLinks: readonly string[]
  /** Every absolute `<a href>` host, lower-cased and de-duplicated, at most 200. */
  readonly linkHosts: readonly string[]
  /** Paths the page links to on its own site, lower-cased, at most 200. */
  readonly ownPaths: readonly string[]
  /** Inline-script markers: tag snippets that build their `src` in JavaScript. */
  readonly inlineMarkers: readonly string[]
  /** Four-digit years after a ©, "(c)" or "copyright" in the page text, at most twenty. */
  readonly copyrightYears: readonly number[]
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

/** Where a link to each social platform points. */
const SOCIAL_HOSTS: readonly (readonly [platform: string, hosts: readonly string[]])[] = [
  ['instagram', ['instagram.com', 'instagr.am']],
  ['facebook', ['facebook.com', 'fb.com', 'fb.me']],
  ['linkedin', ['linkedin.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['x', ['twitter.com', 'x.com']],
]

const WHATSAPP_HOSTS = ['wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'chat.whatsapp.com'] as const

/**
 * Snippets that load a tag from inline JavaScript rather than a `src`, so the
 * script list alone would miss them. Matched on the raw script text.
 */
const INLINE_MARKERS: readonly (readonly [marker: string, pattern: RegExp])[] = [
  ['google-tag-manager', /googletagmanager\.com\/gtm\.js/],
  ['google-analytics', /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(?:analytics|ga)\.js|\bgtag\(\s*['"]config['"]/],
  ['meta-pixel', /connect\.facebook\.net\/[^'"\s]*\/fbevents\.js|\bfbq\(\s*['"]init['"]/],
  ['microsoft-clarity', /clarity\.ms\/tag/],
  ['hotjar', /static\.hotjar\.com|\bhj\(\s*['"]/],
  ['linkedin-insight', /snap\.licdn\.com\/li\.lms-analytics/],
]

const COPYRIGHT_YEAR = /(?:©|\(c\)|copyright)\s*(?:\d{4}\s*(?:[-–—]|to)\s*)?(\d{4})/gi
const LIST_MAX = 200

function hostOf(href: string): string | null {
  try {
    const u = new URL(href)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/^www\./, '') : null
  } catch {
    return null
  }
}

function hostIs(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

/** `@type` values from one JSON-LD block, nested `@graph` included; never throws. */
function jsonLdTypes(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const found: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || found.length >= 10) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
    } else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const t = o['@type']
      for (const name of Array.isArray(t) ? t : [t]) if (typeof name === 'string' && name.length <= 60) found.push(name)
      if (Array.isArray(o['@graph'])) walk(o['@graph'], depth + 1)
    }
  }
  walk(parsed, 0)
  return found
}

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

  // The website-presence read. Its own state, so the port's is untouched.
  let complete = false
  let svgDepth = 0
  let inRealTitle = false
  let realTitle: string | null = null
  let realTitleText = ''
  let viewport: string | null = null
  let description: string | null = null
  let generator: string | null = null
  const openGraph = new Set<string>()
  let structuredBlocks = 0
  const structuredTypes: string[] = []
  let telLinks = 0
  let mailtoLinks = 0
  let whatsappLinks = 0
  let forms = 0
  const socialLinks = new Set<string>()
  const linkHosts = new Set<string>()
  const ownPaths = new Set<string>()
  const inlineMarkers = new Set<string>()
  const copyrightYears: number[] = []
  /** What the next raw script text is: JSON-LD, another inline script, or neither. */
  let scriptBody: 'jsonld' | 'inline' | null = null
  let inStyle = false

  try {
    parseHtml(html, {
      starttag(tag, attrs) {
        const a = asDict(attrs)
        page(tag, a)
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
        pageEnd(tag)
      },
      data(text) {
        pageText(text)
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

  return {
    title, scripts, hasLogin, scriptTags, resourceRefs,
    page: {
      complete,
      // A <title> never closed is still a title: what it held so far.
      realTitle: realTitle ?? (inRealTitle ? realTitleText.replace(/\s+/g, ' ').trim().slice(0, 200) : null),
      viewport,
      description,
      generator,
      openGraph: [...openGraph].sort(),
      structuredBlocks,
      structuredTypes: [...new Set(structuredTypes)].slice(0, 10),
      telLinks,
      mailtoLinks,
      whatsappLinks,
      forms,
      socialLinks: [...socialLinks].sort(),
      linkHosts: [...linkHosts],
      ownPaths: [...ownPaths],
      inlineMarkers: [...inlineMarkers].sort(),
      copyrightYears,
    },
  }

  function page(tag: string, a: Map<string, string | null>): void {
    if (tag === 'svg') svgDepth += 1
    else if (tag === 'title' && svgDepth === 0 && realTitle === null) {
      inRealTitle = true
    } else if (tag === 'meta') {
      const name = (a.get('name') ?? '').toLowerCase().trim()
      const property = (a.get('property') ?? '').toLowerCase().trim()
      const content = (a.get('content') ?? '').replace(/\s+/g, ' ').trim()
      if (name === 'viewport' && viewport === null) viewport = content.slice(0, 200)
      else if (name === 'description' && description === null) description = content.slice(0, 400)
      else if (name === 'generator' && generator === null && content) generator = content.slice(0, 120)
      if (property.startsWith('og:') && content) openGraph.add(property.slice(0, 40))
    } else if (tag === 'script') {
      const type = (a.get('type') ?? '').toLowerCase().trim()
      scriptBody = type === 'application/ld+json' ? 'jsonld' : a.get('src') ? null : 'inline'
    } else if (tag === 'style') {
      inStyle = true
    } else if (tag === 'form') {
      forms += 1
    } else if (tag === 'a') {
      link(a.get('href') ?? '')
    }
    // schema.org microdata: an element that opens an item of a schema.org type.
    const itemtype = a.get('itemtype')
    if (itemtype && /schema\.org\//i.test(itemtype)) {
      structuredBlocks += 1
      const name = itemtype.trim().split('/').pop()
      if (name && name.length <= 60) structuredTypes.push(name)
    }
  }

  function link(rawHref: string): void {
    const href = rawHref.trim()
    const lower = href.toLowerCase()
    if (lower.startsWith('tel:')) telLinks += 1
    else if (lower.startsWith('mailto:')) mailtoLinks += 1
    else if (lower.startsWith('whatsapp:')) whatsappLinks += 1
    else {
      const host = hostOf(href)
      if (host) {
        if (WHATSAPP_HOSTS.some((h) => hostIs(host, h))) whatsappLinks += 1
        for (const [platform, hosts] of SOCIAL_HOSTS) if (hosts.some((h) => hostIs(host, h))) socialLinks.add(platform)
        if (linkHosts.size < LIST_MAX) linkHosts.add(host)
        return
      }
      // A link to a path on the page's own site: /book, /shop, /cart …
      if (lower.startsWith('/') && !lower.startsWith('//') && ownPaths.size < LIST_MAX) {
        ownPaths.add(lower.split(/[?#]/)[0]!.slice(0, 100))
      }
    }
  }

  function pageEnd(tag: string): void {
    if (tag === 'body' || tag === 'html') complete = true
    else if (tag === 'svg' && svgDepth > 0) svgDepth -= 1
    else if (tag === 'title' && inRealTitle) {
      inRealTitle = false
      const t = realTitleText.replace(/\s+/g, ' ').trim()
      realTitle = t ? t.slice(0, 200) : ''
    } else if (tag === 'script') scriptBody = null
    else if (tag === 'style') inStyle = false
  }

  function pageText(text: string): void {
    if (scriptBody === 'jsonld') {
      structuredBlocks += 1
      structuredTypes.push(...jsonLdTypes(text.slice(0, 50_000)))
      return
    }
    if (scriptBody === 'inline') {
      const head = text.slice(0, 50_000)
      for (const [marker, pattern] of INLINE_MARKERS) if (pattern.test(head)) inlineMarkers.add(marker)
      return
    }
    if (inStyle) return
    if (inRealTitle && realTitleText.length < 400) realTitleText += text
    if (copyrightYears.length < 20 && /©|\(c\)|copyright/i.test(text)) {
      for (const m of text.matchAll(COPYRIGHT_YEAR)) {
        const year = Number(m[1])
        if (year >= 1990 && year <= 2100 && copyrightYears.length < 20) copyrightYears.push(year)
      }
    }
  }
}
