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
 */
import { connect as tlsConnect, type PeerCertificate } from 'node:tls'
import { ALL_PUBLIC_PATHS, type RawCapture, type RawResponse, type RawTls } from './types.js'
import { normaliseDomain } from './extract.js'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const HOME_TIMEOUT_MS = 12_000
const PATH_TIMEOUT_MS = 8_000
/** Matches the Python engine's 1.5 MB read cap. */
const MAX_BODY_BYTES = 1_500_000

export interface FetchOptions {
  readonly homeTimeoutMs?: number
  readonly pathTimeoutMs?: number
  readonly now?: () => Date
}

async function readCapped(res: Response): Promise<string> {
  const buf = await res.arrayBuffer()
  const slice = buf.byteLength > MAX_BODY_BYTES ? buf.slice(0, MAX_BODY_BYTES) : buf
  return new TextDecoder('utf-8', { fatal: false }).decode(slice)
}

async function get(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'TimeoutError: request timed out'
    return `${cause?.code ?? err.name}: ${err.message}`
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
 * Never throws: a failure is recorded as a failure so the extractor can mark
 * the signal unobserved (§2.2) rather than guess.
 */
export async function capture(domain: string, opts: FetchOptions = {}): Promise<RawCapture> {
  const host = normaliseDomain(domain)
  const now = opts.now ?? (() => new Date())
  const capturedAt = now().toISOString()

  let home: RawCapture['home']
  try {
    const res = await get(`https://${host}/`, opts.homeTimeoutMs ?? HOME_TIMEOUT_MS)
    const body = await readCapped(res)
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    home = res.ok
      ? { ok: true, status: res.status, finalUrl: res.url, headers, body }
      : { ok: false, status: res.status, finalUrl: res.url, headers, body, error: `HTTP ${res.status}` }
  } catch (err) {
    home = { ok: false, status: null, finalUrl: '', headers: {}, body: '', error: describe(err) }
  }

  // Only probe the public paths if the site answered at all.
  const paths: Record<string, RawResponse> = {}
  if (home.ok) {
    await Promise.all(
      ALL_PUBLIC_PATHS.map(async (path) => {
        try {
          const res = await get(`https://${host}${path}`, opts.pathTimeoutMs ?? PATH_TIMEOUT_MS)
          paths[path] = { status: res.status, body: await readCapped(res) }
        } catch (err) {
          // Recorded as an error, NOT as an absent page — see probePublicPath.
          paths[path] = { status: null, body: '', error: describe(err) }
        }
      }),
    )
  }

  const tls = home.ok || home.status !== null ? await fetchTls(host, now) : { ok: false, error: 'host unreachable' }

  return { domain: host, capturedAt, home, paths, tls }
}
