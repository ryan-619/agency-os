/**
 * The page reader (2026-10-13): one public web page, read the way a person
 * opens it from a search result, so the assistant can see an address or a
 * number on the page that shows it instead of composing one.
 *
 * It is not a scan and widens nothing a scan requests. It goes through the
 * scanner's own `get()` (`fetchFollowingRedirects` in `fetch.ts`), so it
 * keeps every rule that protects the network the worker runs in: a public
 * host name on every hop (`isScannableHost`, inside `redirectTarget`), a
 * public address at every connection (`publicOnlyLookup`), the default
 * ports, and the read cap. On top of those, an address that looks like a
 * probe — a hidden file, an admin or login page, a backup, a configuration
 * file — is refused before it is requested, the first one and every
 * redirect alike (`readablePathProblem`, §2.2's "no probing for .git, .env,
 * admin panels or backups"). It sends no cookie and no credential.
 *
 * Only a web page is read: HTML, XHTML or plain text. Anything else is
 * refused from its headers, before its body is downloaded.
 *
 * It never throws for something about the page — a refusal, a site that does
 * not answer, a 404, a PDF — because each of those is an answer the caller
 * words for a person. It throws only for a programming error. No `detail`
 * carries a secret or a word of the page.
 */
import { brotliDecompressSync, constants as zlib, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { htmlToText, readablePathProblem } from '@agency/core'
import { isScannableHost } from './extract.js'
import { AddressRefused, RedirectRefused, fetchFollowingRedirects, statusFollowed } from './fetch.js'
import { unescape } from './unescape.js'

/** Each hop's socket may be silent this long; a scan's path probe uses the same. */
export const READ_PAGE_TIMEOUT_MS = 8_000

/**
 * The whole read — every hop and the body — has a ceiling of its own. The
 * per-hop timeout bounds silence, not a body that drips a byte inside each
 * window, and a scan that met one could only abandon it with its socket open
 * (CLAUDE.md §4, "A cron rescans"). Here the connection is closed when the
 * ceiling passes. Inside the agent's tool budget, with room to answer.
 */
export const READ_PAGE_TOTAL_MS = 20_000

/**
 * What a page may decompress to. The read cap counts bytes off the wire, and a
 * small gzip stream can inflate to gigabytes; a real page is a few hundred
 * kilobytes of HTML.
 */
export const READ_PAGE_MAX_DECODED_BYTES = 8_000_000

/** A title is a heading, not a paragraph. */
const TITLE_MAX = 200

const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain'])

export type PageRead =
  | {
      ok: true
      /** The address asked for, without any username or password in it. */
      url: string
      /** Where the page actually came from, after every redirect. */
      finalUrl: string
      status: number
      /** The first `<title>` that is not inside an `<svg>`, whitespace collapsed; null when it has none. */
      title: string | null
      /** The words a person would read: `htmlToText` for HTML, the body itself for plain text. */
      text: string
      /** The decoded body, as far as the read cap reached. */
      html: string
      /** The page was longer than the read cap, so `html` and `text` are its beginning only. */
      truncated: boolean
    }
  | {
      ok: false
      url: string
      why: 'refused' | 'unreachable' | 'timeout' | 'status' | 'not_a_page' | 'too_large'
      /** The status the site answered, for `status`. */
      status?: number
      /** A sentence for a person. Never a credential, never the page's words. */
      detail: string
    }

export interface ReadPageOptions {
  /** How long each hop's socket may be silent. Default `READ_PAGE_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  /** The ceiling on the whole read. Default `READ_PAGE_TOTAL_MS`. */
  readonly totalMs?: number
  /** Stops the read and closes its connection; the answer is then `timeout`. */
  readonly signal?: AbortSignal
}

type Failure = Extract<PageRead, { ok: false }>

/** A length of time as a sentence says it. */
function seconds(ms: number): string {
  const n = Math.round(ms / 1000)
  return n <= 1 ? 'a second' : `${n} seconds`
}

function failure(url: string, why: Failure['why'], detail: string, status?: number): Failure {
  return status === undefined ? { ok: false, url, why, detail } : { ok: false, url, why, status, detail }
}

/** The address asked for, as it is reported back: no username or password, and bounded. */
function reportedUrl(input: string): string {
  try {
    const parsed = new URL(input.trim())
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().slice(0, 2048)
  } catch {
    return input.trim().slice(0, 2048)
  }
}

/** The host as a sentence may name it. */
function hostWords(host: string): string {
  return host.length > 100 ? `${host.slice(0, 100)}…` : host
}

/**
 * Why this start address is never requested, or the URL to request. Every
 * check here happens before anything is resolved or connected.
 */
function startOf(input: string): { url: URL } | { detail: string } {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return {
      detail:
        'That is not a whole web address. Give the page’s full address, starting https:// — the page reader ' +
        'does not guess one from a name or a domain.',
    }
  }
  const problem = readablePathProblem(url)
  if (problem) return { detail: problem }
  // A name written with its final dot (`acme.in.`) is the same name.
  if (url.hostname.endsWith('.') && url.hostname.length > 1) url.hostname = url.hostname.slice(0, -1)
  if (!isScannableHost(url.hostname)) {
    return {
      detail:
        `"${hostWords(url.hostname)}" is not the name of a public website — it is an address, a name on a ` +
        'private network or a reserved name — so it is not read. Only public websites are read.',
    }
  }
  return { url }
}

/** The media type a response says it is, lower-cased, without its parameters. */
function mediaTypeOf(headers: Readonly<Record<string, string>>): string {
  return (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
}

const STATUS_WORDS: Readonly<Record<number, string>> = {
  401: 'the page is not public',
  403: 'the page is not public',
  404: 'there is no page at that address',
  410: 'the page has been taken down',
  429: 'the site is refusing requests for now',
}

/**
 * Why the final response is not a page to read, or null when it is. Decided
 * from the status and the headers alone, so a refused body is never
 * downloaded (`fetchFollowingRedirects`' `readBody`).
 */
function responseProblem(url: string, status: number, headers: Readonly<Record<string, string>>): Failure | null {
  if (status >= 300 && status < 400) {
    // `get()` hands back a redirect it would follow, with somewhere to go,
    // only once it has followed ten. A 300 or a 304 is no redirect it follows.
    const detail = !statusFollowed(status)
      ? `The site answered ${status} — it gave no page.`
      : headers.location !== undefined || headers.uri !== undefined
        ? `The site kept redirecting (${status}) past the ten hops the page reader follows, so no page was read.`
        : `The site answered ${status}, a redirect that does not say where to, so no page was read.`
    return failure(url, 'status', detail, status)
  }
  // 204 and 205 succeed with nothing in them, which is no page either.
  if (status < 200 || status >= 300 || status === 204 || status === 205) {
    const words = STATUS_WORDS[status] ?? (status >= 500 ? 'its server failed to give the page' : 'it gave no page')
    return failure(url, 'status', `The site answered ${status} — ${words}.`, status)
  }
  const media = mediaTypeOf(headers)
  if (!PAGE_TYPES.has(media)) {
    const detail = /^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60}$/.test(media)
      ? `That address is a file of type ${media}, not a web page, so it was not downloaded.`
      : 'That address did not say it is a web page, so it was not downloaded.'
    return failure(url, 'not_a_page', detail)
  }
  return null
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** The page decompressed past `READ_PAGE_MAX_DECODED_BYTES`. */
export class PageTooLarge extends Error {
  constructor() {
    super('the page decompresses to more than the page reader holds')
    this.name = 'PageTooLarge'
  }
}

/** The page's bytes are compressed in a way that could not be undone. */
export class PageUndecodable extends Error {
  constructor(readonly encoding: string) {
    super('the page could not be decompressed')
    this.name = 'PageUndecodable'
  }
}

function tooLarge(err: unknown): boolean {
  return err instanceof RangeError && (err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
}

/** A charset label from the headers, or from a `<meta>` near the top of the page. */
function charsetOf(headers: Readonly<Record<string, string>>, bytes: Buffer): string | null {
  const header = /charset\s*=\s*["']?([\w.:-]{1,40})/i.exec(headers['content-type'] ?? '')
  if (header) return header[1]!.toLowerCase()
  // Bounded on both sides: 4 KB of the page and a short run inside one tag.
  const head = bytes.subarray(0, 4096).toString('latin1')
  const meta = /<meta\b[^>]{0,512}?charset\s*=\s*["']?\s*([\w.:-]{1,40})/i.exec(head)
  if (!meta) return null
  const label = meta[1]!.toLowerCase()
  // A page that says UTF-16 in a <meta> was read as ASCII to find it, so it is
  // not UTF-16 — the HTML standard reads it as UTF-8, and so does this.
  return label.startsWith('utf-16') ? 'utf-8' : label
}

/**
 * A page's bytes as text: decompressed within `READ_PAGE_MAX_DECODED_BYTES`
 * (gzip, deflate in either wrapping, brotli), a stream cut by the read cap
 * decoded as far as it goes, then read in the charset the response or the
 * page names — UTF-8 when it names none, or one this runtime does not know.
 *
 * The scan's own `decodeBody` keeps Python's semantics for parity; a page a
 * person reads has no reference engine to agree with, so this one decodes it
 * the way a browser would. Throws `PageTooLarge` or `PageUndecodable`.
 */
export function decodePageBody(raw: Buffer, headers: Readonly<Record<string, string>>): string {
  const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase()
  const max = { maxOutputLength: READ_PAGE_MAX_DECODED_BYTES }
  let bytes = raw
  if (raw.length > 0 && encoding !== '' && encoding !== 'identity') {
    try {
      if (encoding.includes('gzip')) bytes = gunzipSync(raw, { ...max, finishFlush: zlib.Z_SYNC_FLUSH })
      else if (encoding.includes('deflate')) {
        // HTTP's "deflate" is zlib-wrapped; plenty of servers send it raw.
        try {
          bytes = inflateSync(raw, { ...max, finishFlush: zlib.Z_SYNC_FLUSH })
        } catch (err) {
          if (tooLarge(err)) throw err
          bytes = inflateRawSync(raw, { ...max, finishFlush: zlib.Z_SYNC_FLUSH })
        }
      } else if (encoding === 'br') {
        bytes = brotliDecompressSync(raw, { ...max, finishFlush: zlib.BROTLI_OPERATION_FLUSH })
      } else throw new PageUndecodable(encoding.slice(0, 40))
    } catch (err) {
      if (tooLarge(err)) throw new PageTooLarge()
      if (err instanceof PageUndecodable) throw err
      throw new PageUndecodable(encoding.slice(0, 40))
    }
  }
  const label = charsetOf(headers, bytes)
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes)
    } catch {
      // A label this runtime does not know: read it as UTF-8, as below.
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

// ---------------------------------------------------------------------------
// The words of a page
// ---------------------------------------------------------------------------

/** ASCII letters lower-cased and nothing else, so every index still points at the same character. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase())
}

/** Is the tag `name` (written with its `<` or `</`) at `at`, and not a longer name beginning the same way? */
function tagAt(lower: string, at: number, name: string): boolean {
  if (!lower.startsWith(name, at)) return false
  const next = lower.charCodeAt(at + name.length)
  // End of input, `>`, `/` or HTML whitespace.
  return Number.isNaN(next) || next === 0x3e || next === 0x2f || next === 0x20 || (next >= 0x09 && next <= 0x0d)
}

function nextTag(lower: string, name: string, from: number): number {
  let at = lower.indexOf(name, from)
  while (at !== -1 && !tagAt(lower, at, name)) at = lower.indexOf(name, at + 1)
  return at
}

/**
 * The page without what a person never reads as words: comments, scripts,
 * styles and inline SVG drawings, each replaced by a space so the words on
 * either side stay apart.
 *
 * Done before `htmlToText`, which reads at most its first 200,000
 * characters: a modern page's inline scripts alone can be that long, and the
 * footer — where a business prints its address and number — comes last. And
 * an `<svg>` carries `<title>`s of its own, which are an icon's name, not
 * the page's.
 *
 * Two forward walks and a sort, never a regex that retries from every `<`
 * (the 50-second email html-text.ts was rewritten for). The first finds
 * every comment, script and style — each dropped to its end, or to the end
 * of the page when it never closes, as a browser reads one — and every
 * `<svg>` tag outside them. SVG tags are paired with a stack, so nesting is
 * counted once: a pair is dropped whole, `<svg/>` is its own pair, and an
 * `<svg>` that is never closed costs its opening tag only — a browser closes
 * a stray one at the end of whatever holds it, so the page after it is still
 * the page, and dropping it all would drop the footer. The second walk
 * copies what is left.
 */
export function withoutHiddenParts(html: string): string {
  const lower = asciiLower(html)
  const drops: Array<[number, number]> = []
  const svgs: Array<{ readonly at: number; readonly end: number; readonly kind: 'open' | 'close' | 'whole' }> = []

  let at = lower.indexOf('<')
  while (at !== -1) {
    let end = -1
    if (lower.startsWith('<!--', at)) {
      const close = lower.indexOf('-->', at + 4)
      end = close === -1 ? html.length : close + 3
    } else if (tagAt(lower, at, '<script') || tagAt(lower, at, '<style')) {
      const closing = lower.startsWith('<script', at) ? '</script' : '</style'
      const close = lower.indexOf(closing, at + closing.length - 1)
      const gt = close === -1 ? -1 : lower.indexOf('>', close)
      end = gt === -1 ? html.length : gt + 1
    } else if (tagAt(lower, at, '<svg') || tagAt(lower, at, '</svg')) {
      const gt = lower.indexOf('>', at)
      if (gt === -1) {
        end = html.length // a tag cut off by the end of the page
      } else {
        const kind = lower[at + 1] === '/' ? 'close' : lower.charCodeAt(gt - 1) === 0x2f ? 'whole' : 'open'
        svgs.push({ at, end: gt + 1, kind })
        at = lower.indexOf('<', gt + 1)
        continue
      }
    }
    if (end === -1) {
      at = lower.indexOf('<', at + 1)
      continue
    }
    drops.push([at, end])
    at = end >= html.length ? -1 : lower.indexOf('<', end)
  }

  const open: Array<(typeof svgs)[number]> = []
  for (const tag of svgs) {
    if (tag.kind === 'whole') drops.push([tag.at, tag.end])
    else if (tag.kind === 'open') open.push(tag)
    else {
      const from = open.pop()
      // A stray closing tag pairs with nothing; it is dropped alone.
      drops.push(from === undefined ? [tag.at, tag.end] : [from.at, tag.end])
    }
  }
  // Never closed: the opening tag alone.
  for (const tag of open) drops.push([tag.at, tag.end])

  drops.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const out: string[] = []
  let copied = 0
  for (const [from, to] of drops) {
    if (from >= copied) {
      out.push(html.slice(copied, from), ' ')
      copied = to
    } else if (to > copied) {
      copied = to // overlaps what was already dropped
    }
  }
  out.push(html.slice(copied))
  return out.join('')
}

function titleOfVisible(visible: string): string | null {
  const lower = asciiLower(visible)
  const at = nextTag(lower, '<title', 0)
  if (at === -1) return null
  const gt = lower.indexOf('>', at)
  if (gt === -1) return null
  const close = lower.indexOf('</title', gt + 1)
  // An unclosed title is not one a person was shown whole.
  if (close === -1) return null
  const inner = visible.slice(gt + 1, Math.min(close, gt + 1 + 4 * TITLE_MAX))
  // HTML5's own table, as a browser reads `&ndash;` in a tab's title.
  const words = unescape(inner).replace(/\s+/g, ' ').trim()
  if (!words) return null
  const chars = Array.from(words)
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('').trimEnd() : words
}

/** The first `<title>` of a page that is not inside an `<svg>`, entities decoded and whitespace collapsed. */
export function pageTitle(html: string): string | null {
  return titleOfVisible(withoutHiddenParts(html))
}

/**
 * The page the final response carries, or why it is not one. Pure: the
 * status, the first-value header map and the body already decoded. This is
 * all `readPublicPage` does with a response, and it is what the tests drive.
 */
export function pageFromResponse(
  url: string,
  res: {
    readonly status: number
    readonly finalUrl: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
    readonly truncated: boolean
  },
): PageRead {
  const problem = responseProblem(url, res.status, res.headers)
  if (problem) return problem
  const base = { ok: true as const, url, finalUrl: res.finalUrl, status: res.status, truncated: res.truncated }
  if (mediaTypeOf(res.headers) === 'text/plain') {
    const body = res.body.replace(/\r\n?/g, '\n')
    return { ...base, title: null, text: body, html: res.body }
  }
  const visible = withoutHiddenParts(res.body)
  return { ...base, title: titleOfVisible(visible), text: htmlToText(visible), html: res.body }
}

// ---------------------------------------------------------------------------
// Failures, in words
// ---------------------------------------------------------------------------

/** A redirect to an address the reader never requests, thrown from the hop check. */
class HopRefused extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'HopRefused'
  }
}

/** An error's code when it looks like one (`ENOTFOUND`, `CERT_HAS_EXPIRED`), so nothing else it carries is repeated. */
function codeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const own = (err as { code?: unknown }).code
  const cause = (err as { cause?: { code?: unknown } }).cause?.code
  const code = typeof own === 'string' ? own : typeof cause === 'string' ? cause : null
  return code !== null && /^[A-Z][A-Z0-9_]{1,47}$/.test(code) ? code : null
}

const TLS_CODE = /^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|EPROTO$)/

/**
 * What went wrong, for a person. Exported so every branch is pinned by a
 * test. A plain TypeError, ReferenceError or SyntaxError with no code is a
 * bug in this code rather than anything about the page, and is thrown.
 */
export function readFailure(url: string, host: string, err: unknown, timeoutMs: number): PageRead {
  if (
    (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) &&
    codeOf(err) === null
  ) {
    throw err
  }
  if (err instanceof HopRefused) return failure(url, 'refused', err.detail)
  if (err instanceof PageTooLarge) {
    return failure(url, 'too_large', 'The page is far larger than a web page should be once decompressed, so it was not read.')
  }
  if (err instanceof PageUndecodable) {
    return failure(url, 'not_a_page', 'The page came compressed in a way that could not be undone, so it was not read.')
  }
  if (err instanceof RedirectRefused) {
    return failure(
      url,
      'refused',
      'The site redirected to an address that is not a public website on its usual port, so the redirect was not followed.',
    )
  }
  if (err instanceof AddressRefused) {
    // Its own refusals are phrases; the probe check's are whole sentences.
    const said = err.message
    return failure(url, 'refused', /[.!?]$/.test(said) ? said : `That address is not read: ${said}.`)
  }
  const code = codeOf(err)
  const name = err instanceof Error ? err.name : ''
  // The host the failure was about — a redirect's, when it was one — else the one asked for.
  const named = typeof err === 'object' && err !== null ? (err as { hostname?: unknown }).hostname : undefined
  const where = typeof named === 'string' && named ? hostWords(named) : hostWords(host)
  if (code === 'ENOTPUBLIC') {
    return failure(
      url,
      'refused',
      `${where} resolves to an address that is not on the public internet, so it is not read.`,
    )
  }
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return failure(url, 'timeout', `The site did not answer within ${seconds(timeoutMs)}.`)
  }
  if (code === 'ENOTFOUND') {
    return failure(url, 'unreachable', `No website answers at ${where}: the name does not resolve.`)
  }
  if (code === 'EAI_AGAIN') {
    return failure(url, 'unreachable', `The name ${where} could not be looked up just now.`)
  }
  if (code === 'ECONNREFUSED') return failure(url, 'unreachable', 'The site refused the connection.')
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return failure(url, 'unreachable', 'The site closed the connection before the page arrived.')
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') {
    return failure(url, 'unreachable', 'The site could not be reached from here.')
  }
  if (code !== null && TLS_CODE.test(code)) {
    return failure(
      url,
      'unreachable',
      `The site’s certificate is not one a browser would accept (${code}), so the page was not read.`,
    )
  }
  if (code !== null && code.startsWith('HPE_')) {
    return failure(url, 'unreachable', 'The site answered with something that is not a web response.')
  }
  return failure(url, 'unreachable', `The page could not be fetched${code ? ` (${code})` : ''}.`)
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Read one public web page. `url` is a whole address — a bare domain is not
 * this function's to guess at. See the module header for what it refuses.
 */
export async function readPublicPage(url: string, opts: ReadPageOptions = {}): Promise<PageRead> {
  const reported = reportedUrl(url)
  const timeoutMs = opts.timeoutMs ?? READ_PAGE_TIMEOUT_MS
  const totalMs = opts.totalMs ?? READ_PAGE_TOTAL_MS
  const stopped = (): Failure => failure(reported, 'timeout', 'The read was stopped before the page arrived.')
  const tookTooLong = (): Failure =>
    failure(reported, 'timeout', `The page took longer than ${seconds(totalMs)} to arrive, so it was not read.`)

  const start = startOf(url)
  if ('detail' in start) return failure(reported, 'refused', start.detail)
  if (opts.signal?.aborted) return stopped()

  const ceiling = new AbortController()
  const timer = setTimeout(() => ceiling.abort(), totalMs)
  timer.unref?.()
  const signal = opts.signal ? AbortSignal.any([opts.signal, ceiling.signal]) : ceiling.signal
  const host = start.url.hostname

  try {
    const res = await fetchFollowingRedirects(start.url.toString(), timeoutMs, {
      signal,
      beforeRequest: (hop) => {
        const problem = readablePathProblem(hop)
        if (problem) throw new HopRefused(`The site redirected to an address the page reader never requests. ${problem}`)
      },
      readBody: (status, headers) => responseProblem(reported, status, headers) === null,
      decode: decodePageBody,
    })
    if (opts.signal?.aborted) return stopped()
    if (ceiling.signal.aborted) return tookTooLong()
    return pageFromResponse(reported, res)
  } catch (err) {
    if (opts.signal?.aborted) return stopped()
    if (ceiling.signal.aborted) return tookTooLong()
    return readFailure(reported, host, err, timeoutMs)
  } finally {
    clearTimeout(timer)
    // Closes whatever this read left open. A redirect's own body is drained
    // rather than read (`get()`), and a site that sends one without end would
    // otherwise stream into the worker for as long as it liked after the
    // answer was given.
    ceiling.abort()
  }
}
