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
import { ALL_PUBLIC_PATHS, type RawCapture, type RawResponse, type RawTls } from './types.js'
import { isScannableHost, normaliseDomain } from './extract.js'

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
 * Python 3.9's redirect handler implements 301, 302, 303 and 307 — and NOT
 * 308, which arrived in 3.11. A 308 therefore surfaces as an HTTP error there,
 * and does the same here.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307])

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
  return next
}

function once(url: URL, timeoutMs: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const https = url.protocol === 'https:'
    const send = https ? httpsRequest : httpRequest
    const req = send(
      url,
      {
        method: 'GET',
        agent: https ? httpsAgent : httpAgent,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain,*/*',
          'accept-language': 'en-US,en;q=0.9',
          // Exactly the reference's list. Asking for brotli as well would mean
          // the two engines are handed different bytes by the same server.
          'accept-encoding': 'gzip, deflate',
        },
      },
      resolve,
    )
    // A socket-inactivity timeout, which is what Python's `timeout=` is. The
    // caller bounds the whole chain separately.
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('request timed out'), { name: 'TimeoutError' }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * One GET, following redirects the way urllib does, with `redirectTarget`
 * deciding which hops are allowed. The caller has already checked the starting
 * host; every hop after it is checked here.
 */
async function get(startUrl: string, timeoutMs: number): Promise<HttpResult> {
  const deadline = Date.now() + timeoutMs * (MAX_REDIRECTS + 1)
  let url = new URL(startUrl)

  for (let hop = 0; ; hop += 1) {
    const remaining = Math.min(timeoutMs, deadline - Date.now())
    if (remaining <= 0) throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' })

    const res = await once(url, remaining)
    const status = res.statusCode ?? 0
    const headers = firstHeaders(res.rawHeaders)
    const location = headers.location ?? headers.uri

    if (FOLLOWED_REDIRECTS.has(status) && location !== undefined && hop < MAX_REDIRECTS) {
      res.resume() // drain, so the socket can close
      url = redirectTarget(location, url)
      continue
    }

    const { raw, truncated } = await readCapped(res)
    return {
      status,
      finalUrl: url.toString(),
      headers,
      body: decodeBody(raw, headers['content-encoding'] ?? ''),
      truncated,
    }
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
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: 8000 }, () => {
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
