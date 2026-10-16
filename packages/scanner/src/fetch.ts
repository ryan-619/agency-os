/**
 * The I/O half of the scanner: request a company's public pages and record
 * exactly what came back.
 *
 * COMPLIANCE — what this is allowed to touch (PROMPT.md §2.2):
 *   * the homepage, over https
 *   * the conventional, publicly-advertised paths in ALL_PUBLIC_PATHS
 *   * the TLS certificate the server presents
 *
 * Nothing else. There is no port scanning, no directory brute-forcing, and no
 * probing for .git, .env, backups or admin panels. The path list is a frozen
 * constant rather than a parameter so a caller cannot widen it.
 *
 * This is posture review from the outside, not a security test.
 *
 * The page reader (`read-page.ts`, 2026-10-13) requests through the same
 * `get()` — `fetchFollowingRedirects` below — and is a different thing from a
 * scan: one page a person would open from a search result, at an address the
 * caller names, refused by `readablePathProblem` when it looks like a probe.
 * It never widens what a scan requests; `capture` still asks for the
 * homepage, the frozen list and the certificate, and nothing else.
 *
 * Built on `node:https` rather than `fetch()`. That is not a preference: the
 * WHATWG Response hides the two things this module has to get right. It
 * decompresses before anything can measure the encoded stream — and the
 * reference engine's 1.5 MB cap applies to the ENCODED stream — and its
 * `Headers` joins repeated headers with ", " where Python's
 * `email.message.Message.get` returns the first. Both change what the scanner
 * reports about a real site. Owning the request also means owning the redirect
 * chain, which is where the host check has to be repeated.
 */
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type PeerCertificate } from 'node:tls'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { readablePathProblem } from '@agency/core'
import { ALL_PUBLIC_PATHS, type RawCapture, type RawResponse, type RawTls } from './types.js'
import { isScannableHost, normaliseDomain } from './extract.js'
import { publicOnlyLookup } from './address.js'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const HOME_TIMEOUT_MS = 12_000
const PATH_TIMEOUT_MS = 8_000

/**
 * The reference engine's `resp.read(1_500_000)`, which reads that many bytes
 * OFF THE WIRE and only then decompresses. Capping the decompressed text
 * instead would read a different amount of a gzipped page than the engine this
 * one has to agree with.
 */
export const MAX_ENCODED_BYTES = 1_500_000

/** `urllib.request.HTTPRedirectHandler.max_redirections`. */
const MAX_REDIRECTS = 10

/**
 * A FOURTH DELIBERATE DIVERGENCE, and the plainest one.
 *
 * Python 3.9's `HTTPRedirectHandler` has `http_error_301/302/303/307` and no
 * `http_error_308` — support for it arrived in a later CPython. So on the
 * interpreter the reference engine runs, a 308 is not a redirect at all; it
 * raises, and the engine records `fetch_error = "HTTP 308"` and disqualifies
 * the company as UNREACHABLE.
 *
 * `308 Location: https://www.example.com/` is the apex-to-www redirect half
 * the hosting industry emits. Two of the sixteen seed domains answer with
 * exactly that, and both were being written down as unreachable sites — a
 * statement about a company that is simply false, and §2.2's whole subject.
 * It is also not a rule the reference chose; it is the absence of one in the
 * version of a standard library.
 *
 * So 308 is followed, with the same host check as every other hop. The score
 * this changes is one that was never computed rather than one that was
 * computed differently, and parity is untouched: the fixtures are replayed
 * bytes, with no redirect in them.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308])

/** Exported so the set above is pinned by a test rather than by reading it. */
export function statusFollowed(status: number): boolean {
  return FOLLOWED_REDIRECTS.has(status)
}

// keepAlive off: a scan makes seven requests to a host and then never speaks to
// it again, and a pooled socket would keep the process alive after it.
const httpsAgent = new HttpsAgent({ keepAlive: false })
const httpAgent = new HttpAgent({ keepAlive: false })

export interface FetchOptions {
  readonly homeTimeoutMs?: number
  readonly pathTimeoutMs?: number
  readonly now?: () => Date
}

interface HttpResult {
  readonly status: number
  readonly finalUrl: string
  /** Lower-cased names. The FIRST value of a repeated header, as Python reads it. */
  readonly headers: Readonly<Record<string, string>>
  /** Every Set-Cookie, value redacted — see `setCookieHeaders`. */
  readonly setCookies: readonly string[]
  /** Every Content-Security-Policy value — see `headerValues`. */
  readonly cspHeaders: readonly string[]
  readonly body: string
  /** The response hit MAX_ENCODED_BYTES, so the body is a prefix of the page. */
  readonly truncated: boolean
}

/**
 * `email.message.Message.get`: a repeated header answers with its FIRST value.
 * `Headers.get` in the fetch API answers `"a, b"` instead, which quietly
 * invents a Content-Security-Policy no server ever sent.
 *
 * Exported, with decodeBody and readCapped, so the tests can pin these three
 * Python semantics directly. Nothing else should call them.
 */
export function firstHeaders(raw: readonly string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase()
    if (!(name in out)) out[name] = raw[i + 1]!
  }
  // Returned with its null prototype intact, so a header literally named
  // `constructor` answers with nothing rather than with a function.
  return out
}

/**
 * Every `Set-Cookie` in `rawHeaders` (name/value pairs, any case), in order,
 * with each cookie's VALUE replaced by `<redacted>`.
 *
 * A second read of the same pairs, not a change to `firstHeaders`: parity
 * needs the map to keep the first value of every header, and a site that sets
 * three cookies would otherwise be judged on one of them. The value goes
 * because nothing reads it — `cookie_flags` judges names and attributes — and
 * a session cookie's value is a live bearer credential for whatever session
 * the prospect's server handed the scanner (§2.3). It has no business in
 * `scans.raw`.
 */
export function setCookieHeaders(raw: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() !== 'set-cookie') continue
    const value = raw[i + 1]!
    const semi = value.indexOf(';')
    const pair = semi === -1 ? value : value.slice(0, semi)
    const eq = pair.indexOf('=')
    const name = eq === -1 ? '' : pair.slice(0, eq)
    out.push(`${name}=<redacted>${semi === -1 ? '' : value.slice(semi)}`)
  }
  return out
}

/**
 * Every value of one header in `rawHeaders` (name/value pairs, any case), in
 * order. Another second read of the same pairs beside `firstHeaders`, like
 * `setCookieHeaders`: the map keeps the first value for parity, and a rule
 * that must see every value — a browser enforces every Content-Security-Policy
 * it is sent — reads this instead.
 */
export function headerValues(raw: readonly string[], name: string): string[] {
  const want = name.toLowerCase()
  const out: string[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === want) out.push(raw[i + 1]!)
  }
  return out
}

/**
 * `_decode()`: gunzip or inflate, and on failure keep the bytes as they came.
 * Python's `except Exception: pass` is load-bearing — a body truncated mid
 * gzip stream decodes as mojibake rather than raising, and that mojibake is
 * what the reference engine then reads.
 */
export function decodeBody(raw: Buffer, contentEncoding: string): string {
  const enc = contentEncoding.toLowerCase()
  let bytes = raw
  try {
    if (enc.includes('gzip')) bytes = gunzipSync(raw)
    else if (enc.includes('deflate')) bytes = inflateRawSync(raw)
  } catch {
    // Deliberate: the raw bytes are what gets decoded, exactly as in _decode().
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** Read at most MAX_ENCODED_BYTES off the wire, then stop reading. */
export function readCapped(
  res: Pick<IncomingMessage, 'on' | 'destroy'>,
): Promise<{ raw: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      resolve({ raw: Buffer.concat(chunks), truncated })
    }

    res.on('data', (chunk: Buffer) => {
      if (truncated) return
      const room = MAX_ENCODED_BYTES - total
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room))
        total += room
        truncated = true
        res.destroy() // stop reading, as `read(n)` stops
        finish()
        return
      }
      chunks.push(chunk)
      total += chunk.length
    })
    res.on('end', finish)
    res.on('close', finish)
    res.on('error', (err) => {
      if (truncated || settled) finish()
      else reject(err)
    })
  })
}

export class RedirectRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'RedirectRefused'
  }
}

/**
 * Where a redirect is allowed to send the scanner.
 *
 * A DELIBERATE DIVERGENCE. urllib follows a redirect wherever it points, so a
 * public marketing site answering `302 Location: http://169.254.169.254/`
 * turns the scanner into a request forwarder aimed at cloud metadata. Checking
 * only the domain the caller typed protects nothing when the server picks the
 * second hop, and §2.2's "public pages only" is a claim about every request the
 * scan makes, not just the first. urllib also permits ftp, which is not a
 * protocol this scanner has any business speaking.
 */
export function redirectTarget(location: string, from: URL): URL {
  let next: URL
  try {
    next = new URL(location, from)
  } catch {
    throw new RedirectRefused(`redirected to an unparseable location "${location.slice(0, 120)}"`)
  }
  if (next.protocol !== 'https:' && next.protocol !== 'http:') {
    throw new RedirectRefused(`redirected to "${next.protocol}", which the scanner does not speak`)
  }
  if (!isScannableHost(next.hostname)) {
    throw new RedirectRefused(`redirected to "${next.hostname}", which is not a public hostname`)
  }
  // A company's site is served on the default port. A hop to any other port is
  // refused, so a site cannot turn the scanner into a probe of somebody's
  // ports (review, 2026-10-08) — what the page said is recorded as a failure.
  if (next.port !== '') {
    throw new RedirectRefused(`redirected to port ${next.port}, and the scanner requests only the default ports`)
  }
  return next
}

/**
 * Responses whose socket fell silent past the per-hop timeout while the body
 * was arriving. Node reports that as the SERVER resetting the connection
 * (`ECONNRESET`, "aborted") — it was this side closing a silent socket — so
 * the response is marked here, and the page reader words it as the timeout it
 * was. A scan records what Node reported, as it always has.
 */
const silencedBodies = new WeakSet<IncomingMessage>()

function once(url: URL, timeoutMs: number, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const https = url.protocol === 'https:'
    const send = https ? httpsRequest : httpRequest
    let response: IncomingMessage | null = null
    const req = send(
      url,
      {
        method: 'GET',
        agent: https ? httpsAgent : httpAgent,
        // Resolve, and refuse an address that is not public, at the moment of connecting (`address.ts`).
        lookup: publicOnlyLookup,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain,*/*',
          'accept-language': 'en-US,en;q=0.9',
          // Exactly the reference's list. Asking for brotli as well would mean
          // the two engines are handed different bytes by the same server.
          'accept-encoding': 'gzip, deflate',
        },
        // Only the page reader passes one; a scan's request is as it always was.
        ...(signal ? { signal } : {}),
      },
      (res) => {
        response = res
        resolve(res)
      },
    )
    // A socket-inactivity timeout, which is what Python's `timeout=` is. The
    // caller bounds the whole chain separately.
    req.setTimeout(timeoutMs, () => {
      if (response) silencedBodies.add(response)
      req.destroy(Object.assign(new Error('request timed out'), { name: 'TimeoutError' }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * What the page reader (`read-page.ts`, 2026-10-13) asks of `get()` beyond
 * what a scan does. A scan passes none of it, so its requests and what it
 * records are exactly as they were. None of these can widen what is
 * requested: the host check on every hop, `publicOnlyLookup` on every
 * connection and `fetchFollowingRedirects`' probe check run whatever is
 * passed here.
 */
export interface FollowHooks {
  /** Asked of every address before it is requested, the first included. Throws to refuse it. */
  readonly beforeRequest?: (url: URL) => void
  /**
   * Asked of the final response before its body is read. False leaves the
   * body unread — the connection is closed — and the result's body empty,
   * so a file the reader would refuse is never downloaded.
   */
  readonly readBody?: (status: number, headers: Readonly<Record<string, string>>) => boolean
  /** Turns the bytes read into text. A scan's own is `decodeBody`, with Python's semantics. */
  readonly decode?: (raw: Buffer, headers: Readonly<Record<string, string>>) => string
  /** Closes the connection, wherever the read has got to, when the caller stops waiting. */
  readonly signal?: AbortSignal
}

/**
 * One GET, following redirects the way urllib does, with `redirectTarget`
 * deciding which hops are allowed. The caller has already checked the starting
 * host; every hop after it is checked here. `silenceIsTimeout` is the page
 * reader's: a body that fell silent is thrown as a TimeoutError rather than
 * as the connection reset Node reports it as (`silencedBodies`).
 */
async function get(
  startUrl: string,
  timeoutMs: number,
  hooks: FollowHooks = {},
  silenceIsTimeout = false,
): Promise<HttpResult> {
  const deadline = Date.now() + timeoutMs * (MAX_REDIRECTS + 1)
  let url = new URL(startUrl)

  for (let hop = 0; ; hop += 1) {
    const remaining = Math.min(timeoutMs, deadline - Date.now())
    if (remaining <= 0) throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' })

    hooks.beforeRequest?.(url)
    const res = await once(url, remaining, hooks.signal)
    const status = res.statusCode ?? 0
    const headers = firstHeaders(res.rawHeaders)
    const location = headers.location ?? headers.uri

    if (FOLLOWED_REDIRECTS.has(status) && location !== undefined && hop < MAX_REDIRECTS) {
      res.resume() // drain, so the socket can close
      url = redirectTarget(location, url)
      continue
    }

    if (hooks.readBody && !hooks.readBody(status, headers)) {
      res.destroy() // nothing of it is wanted, so nothing more of it is read
      return {
        status, finalUrl: url.toString(), headers, setCookies: [], cspHeaders: [], body: '', truncated: false,
      }
    }

    let read: { raw: Buffer; truncated: boolean }
    try {
      read = await readCapped(res)
    } catch (err) {
      if (silenceIsTimeout && silencedBodies.has(res)) {
        throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' })
      }
      throw err
    }
    const { raw, truncated } = read
    return {
      status,
      finalUrl: url.toString(),
      headers,
      // From the FINAL response only. A cookie set on a redirect hop belongs to
      // that hop's host, which is not the page being described.
      setCookies: setCookieHeaders(res.rawHeaders),
      cspHeaders: headerValues(res.rawHeaders, 'content-security-policy'),
      body: hooks.decode ? hooks.decode(raw, headers) : decodeBody(raw, headers['content-encoding'] ?? ''),
      truncated,
    }
  }
}

/** A start address `fetchFollowingRedirects` will not request. Its message names why, never a credential. */
export class AddressRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'AddressRefused'
  }
}

/** The final response of `fetchFollowingRedirects`. */
export interface FollowedResponse {
  readonly status: number
  /** The address the final response came from, after every redirect. */
  readonly finalUrl: string
  /** Lower-cased names, the FIRST value of a repeated header. */
  readonly headers: Readonly<Record<string, string>>
  /** Empty when `readBody` said no. */
  readonly body: string
  /** The body hit MAX_ENCODED_BYTES, so it is a prefix of the page. */
  readonly truncated: boolean
  /** False when `readBody` said no and the body was never read. */
  readonly bodyRead: boolean
}

/**
 * One GET of an arbitrary public page through the scanner's own machinery —
 * the same redirect check on every hop, the same `publicOnlyLookup` on every
 * connection, the same read cap — for the page reader. No cookie and no
 * credential is ever sent: none is set on the request, and an address with a
 * username or password in it is refused here rather than turned into an
 * Authorization header, as `http.request` would.
 *
 * The start address is checked here as `capture` checks its host, because
 * this too turns a string into an outbound request: http or https, a public
 * host name, the default port, no userinfo. A refused start throws
 * `AddressRefused` before anything is resolved. A network failure throws as
 * `get()` throws; the caller words it.
 *
 * And it refuses a probe itself — `readablePathProblem`, on the start and on
 * every hop, after the caller's own `beforeRequest`. Unlike `capture`, whose
 * paths are a frozen list, this takes any path, and it is exported from the
 * package root: §2.2's "no probing for .git, .env, admin panels or backups"
 * has to hold for every caller, not only for the page reader that passes a
 * check of its own.
 */
export async function fetchFollowingRedirects(
  startUrl: string,
  timeoutMs: number,
  hooks: FollowHooks = {},
): Promise<FollowedResponse> {
  let start: URL
  try {
    start = new URL(startUrl)
  } catch {
    throw new AddressRefused('not a web address')
  }
  if (start.protocol !== 'https:' && start.protocol !== 'http:') {
    throw new AddressRefused(`"${start.protocol}" is not a protocol the scanner speaks`)
  }
  if (start.username !== '' || start.password !== '') {
    throw new AddressRefused('an address carrying a username or password is never requested')
  }
  if (start.port !== '') throw new AddressRefused(`port ${start.port} is not requested; only the default ports are`)
  if (!isScannableHost(start.hostname)) throw new AddressRefused(`"${start.hostname.slice(0, 120)}" is not a public hostname`)
  const startProblem = readablePathProblem(start)
  if (startProblem) throw new AddressRefused(startProblem)

  let bodyRead = true
  const readBody = hooks.readBody
  const beforeRequest = hooks.beforeRequest
  const res = await get(
    start.toString(),
    timeoutMs,
    {
      ...hooks,
      beforeRequest: (hop: URL) => {
        beforeRequest?.(hop)
        const problem = readablePathProblem(hop)
        if (problem) throw new AddressRefused(problem)
      },
      ...(readBody
        ? {
            readBody: (status: number, headers: Readonly<Record<string, string>>) => {
              bodyRead = readBody(status, headers)
              return bodyRead
            },
          }
        : {}),
    },
    true,
  )
  return {
    status: res.status, finalUrl: res.finalUrl, headers: res.headers, body: res.body, truncated: res.truncated, bodyRead,
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
    return `${code ?? err.name}: ${err.message}`
  }
  return String(err)
}

/** Read the certificate the server presents. Never sends a request. */
export function fetchTls(host: string, now: () => Date = () => new Date()): Promise<RawTls> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: 8000, lookup: publicOnlyLookup }, () => {
      try {
        const cert = socket.getPeerCertificate() as PeerCertificate & { issuer?: { O?: string } }
        const protocol = socket.getProtocol() ?? ''
        const out: RawTls = {
          ok: true,
          protocol,
          issuer: cert?.issuer?.O ?? '',
          ...(cert?.valid_to
            ? (() => {
                const expiry = new Date(cert.valid_to)
                const days = Math.floor((expiry.getTime() - now().getTime()) / 86_400_000)
                return { expires: expiry.toISOString().slice(0, 10), daysToExpiry: days }
              })()
            : {}),
        }
        resolve(out)
      } catch (err) {
        resolve({ ok: false, error: describe(err) })
      } finally {
        socket.destroy()
      }
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve({ ok: false, error: 'TimeoutError: TLS handshake timed out' })
    })
    socket.on('error', (err) => {
      socket.destroy()
      resolve({ ok: false, error: describe(err) })
    })
  })
}

/**
 * Collect everything one scan is permitted to look at.
 *
 * Never throws for a network failure: a failure is recorded as a failure so the
 * extractor can mark the signal unobserved (§2.2) rather than guess. It DOES
 * throw when asked to scan something that is not a public site, because that is
 * a caller error rather than an observation.
 */
export class UnscannableHostError extends Error {
  constructor(readonly host: string, input: string) {
    super(
      `Refusing to scan "${input}": "${host}" is not a public hostname. ` +
        'The scanner only requests companies\' own public marketing sites.',
    )
    this.name = 'UnscannableHostError'
  }
}

export async function capture(domain: string, opts: FetchOptions = {}): Promise<RawCapture> {
  const host = normaliseDomain(domain)
  // Checked here rather than only at import, because this is the single place
  // that turns a stored string into an outbound request. A bad row, an agent
  // tool call in a later phase, or a hand-run CLI all pass through it.
  if (!isScannableHost(host)) throw new UnscannableHostError(host, domain)
  const now = opts.now ?? (() => new Date())
  const capturedAt = now().toISOString()

  let home: RawCapture['home']
  try {
    const res = await get(`https://${host}/`, opts.homeTimeoutMs ?? HOME_TIMEOUT_MS)
    const ok = res.status >= 200 && res.status < 300
    home = {
      ok,
      status: res.status,
      finalUrl: res.finalUrl,
      headers: res.headers,
      setCookies: res.setCookies,
      cspHeaders: res.cspHeaders,
      body: res.body,
      truncated: res.truncated,
      ...(ok ? {} : { error: `HTTP ${res.status}` }),
    }
  } catch (err) {
    home = { ok: false, status: null, finalUrl: '', headers: {}, body: '', truncated: false, error: describe(err) }
  }

  // Only probe the public paths if the site answered at all.
  const paths: Record<string, RawResponse> = {}
  if (home.ok) {
    await Promise.all(
      ALL_PUBLIC_PATHS.map(async (path) => {
        try {
          const res = await get(`https://${host}${path}`, opts.pathTimeoutMs ?? PATH_TIMEOUT_MS)
          paths[path] = { status: res.status, body: res.body, truncated: res.truncated }
        } catch (err) {
          // Recorded as an error, NOT as an absent page — see probePublicPath.
          paths[path] = { status: null, body: '', truncated: false, error: describe(err) }
        }
      }),
    )
  }

  const tls = home.ok || home.status !== null ? await fetchTls(host, now) : { ok: false, error: 'host unreachable' }

  return { domain: host, capturedAt, home, paths, tls }
}
