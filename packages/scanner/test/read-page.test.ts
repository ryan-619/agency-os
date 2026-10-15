/**
 * The page reader (`src/read-page.ts`, 2026-10-13). What it REFUSES comes
 * first, as in fetch.test.ts: it reads public pages for the assistant, and
 * the worker it runs in sits on somebody's network.
 *
 * No real network. `node:https`, `node:http` and `node:tls` are replaced for
 * this file by a fake that answers from a table and records every request it
 * was asked to make, so a test can say a refused address was never requested
 * — and drive the scanner's own `get()`, redirects and read cap included,
 * exactly as a real read would.
 */
import { randomBytes } from 'node:crypto'
import { gzipSync, deflateRawSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { describe, expect, it, beforeEach, vi } from 'vitest'

type Reply =
  | {
      readonly status: number
      readonly headers?: Readonly<Record<string, string>>
      readonly body?: Buffer | string
      /** Sends the first bytes and never ends. */
      readonly drip?: boolean
      /** Sends the first bytes, then falls silent until the per-hop timeout fires. */
      readonly stall?: boolean
    }
  | Error

const net = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const { Readable } = await import('node:stream')
  const state = {
    requests: [] as Array<{ url: string; options: Record<string, unknown> }>,
    replies: new Map<string, Reply>(),
    responses: [] as Array<{ url: string; stream: InstanceType<typeof Readable> }>,
    tlsConnects: 0,
  }

  function fakeRequest(url: URL, options: Record<string, unknown>, onResponse: (res: unknown) => void) {
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>
    let destroyed = false
    let res: InstanceType<typeof Readable> | null = null
    let onTimeout: (() => void) | null = null
    state.requests.push({ url: url.toString(), options })
    req.setTimeout = (_ms: number, cb: () => void) => {
      onTimeout = cb
      return req
    }
    req.destroy = (err?: Error) => {
      if (destroyed) return req
      destroyed = true
      if (res) {
        // As Node does once a response has arrived: the response is reset
        // ("aborted", ECONNRESET) whatever the request was destroyed with, and
        // an IncomingMessage nobody listens to for errors swallows it.
        const reset = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
        res.destroy(res.listenerCount('error') > 0 ? reset : undefined)
      }
      if (err) setImmediate(() => req.emit('error', err))
      return req
    }
    const signal = options.signal as AbortSignal | undefined
    if (signal) {
      const abort = () =>
        (req.destroy as (e: Error) => unknown)(
          Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }),
        )
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    req.end = () => {
      setImmediate(() => {
        if (destroyed) return
        const reply = state.replies.get(url.toString())
        if (reply === undefined) {
          req.emit('error', Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), {
            code: 'ENOTFOUND', hostname: url.hostname,
          }))
          return
        }
        if (reply instanceof Error) {
          req.emit('error', reply)
          return
        }
        const stream = new Readable({ read() {} })
        const raw: string[] = []
        for (const [k, v] of Object.entries(reply.headers ?? {})) raw.push(k, v)
        Object.assign(stream, { statusCode: reply.status, rawHeaders: raw })
        const body = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? '')
        if (reply.drip) stream.push(body.subarray(0, 16))
        else if (reply.stall) {
          stream.push(body.subarray(0, 16))
          setTimeout(() => onTimeout?.(), 5)
        } else {
          if (body.length > 0) stream.push(body)
          stream.push(null)
        }
        res = stream
        state.responses.push({ url: url.toString(), stream })
        onResponse(stream)
      })
    }
    return req
  }

  function fakeTlsConnect() {
    state.tlsConnects += 1
    const socket = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>
    socket.destroy = () => socket
    setImmediate(() => socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))
    return socket
  }

  return { state, fakeRequest, fakeTlsConnect }
})

vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:https')>()
  return { ...real, request: net.fakeRequest }
})
vi.mock('node:http', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:http')>()
  return { ...real, request: net.fakeRequest }
})
vi.mock('node:tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:tls')>()
  return { ...real, connect: net.fakeTlsConnect }
})

const { readPublicPage, pageFromResponse, pageTitle, decodePageBody, withoutHiddenParts, readFailure, PageTooLarge,
  PageUndecodable, READ_PAGE_MAX_DECODED_BYTES } = await import('../src/read-page.js')
const { AddressRefused, MAX_ENCODED_BYTES, capture, fetchFollowingRedirects } = await import('../src/fetch.js')
const { NonPublicAddressError, publicOnlyLookup } = await import('../src/address.js')
const scannerRoot = await import('../src/index.js')

const html = (head: string, body: string): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const HTML = { 'Content-Type': 'text/html; charset=utf-8' }

function reply(url: string, r: Reply): void {
  net.state.replies.set(url, r)
}
const requested = (): string[] => net.state.requests.map((r) => r.url)

beforeEach(() => {
  net.state.requests.length = 0
  net.state.replies.clear()
  net.state.responses.length = 0
  net.state.tlsConnects = 0
})

// ---------------------------------------------------------------------------
// Refused before anything is resolved or connected
// ---------------------------------------------------------------------------

describe('the page reader is never pointed anywhere but a public page', () => {
  it.each([
    'http://localhost/',
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://10.0.0.1/',
    'https://127.1/',
    'https://0x7f.1/',
    'https://169.254.43518/',
    'https://db.internal/',
    'https://box.local/',
    'https://app.corp/',
    'https://shop.invalid/',
    'https://acme-dentist-1a2b.nosite.invalid/',
    'https://acme.example/',
  ])('refuses %s without a request', async (url) => {
    const read = await readPublicPage(url)
    expect(read).toMatchObject({ ok: false, why: 'refused' })
    expect(requested()).toEqual([])
  })

  it.each([
    ['https://acme.in:8443/', /port 8443/],
    ['https://acme.in:22/', /port 22/],
    ['https://user:secret@acme.in/', /username or password/],
    ['ftp://acme.in/', /http or https/],
    ['file:///etc/passwd', /http or https/],
    ['javascript:alert(1)', /http or https/],
    ['mailto:info@acme.in', /http or https/],
  ])('refuses %s, saying why', async (url, why) => {
    const read = await readPublicPage(url)
    expect(read).toMatchObject({ ok: false, why: 'refused' })
    if (!read.ok) expect(read.detail).toMatch(why)
    expect(requested()).toEqual([])
  })

  it.each([
    'https://acme.in/.git/config',
    'https://acme.in/.env',
    'https://acme.in/wp-admin/',
    'https://acme.in/wp-login.php',
    'https://acme.in/admin',
    'https://acme.in/phpmyadmin/index.php',
    'https://acme.in/server-status',
    'https://acme.in/backup.zip',
    'https://acme.in/db.sql',
    'https://acme.in/site.tar.gz',
    'https://acme.in/config.yml',
    'https://acme.in/%2Egit/HEAD',
  ])('refuses a probe, %s, before it is requested (§2.2)', async (url) => {
    const read = await readPublicPage(url)
    expect(read).toMatchObject({ ok: false, why: 'refused' })
    if (!read.ok) expect(read.detail).toMatch(/probe/)
    expect(requested()).toEqual([])
  })

  it('takes a bare domain for nothing — the caller passes a whole address', async () => {
    for (const input of ['acme.in', 'www.acme.in/contact', 'not a url at all']) {
      const read = await readPublicPage(input)
      expect(read, input).toMatchObject({ ok: false, why: 'refused' })
      if (!read.ok) expect(read.detail).toMatch(/whole web address/)
    }
    expect(requested()).toEqual([])
  })

  it('never repeats a password back, in the address or the sentence', async () => {
    const read = await readPublicPage('https://jo:hunter2@acme.in/contact')
    expect(read.ok).toBe(false)
    expect(JSON.stringify(read)).not.toContain('hunter2')
    expect(read.url).toBe('https://acme.in/contact')
  })

  it('answers a read that was already stopped without making it', async () => {
    reply('https://acme.in/', { status: 200, headers: HTML, body: html('<title>Acme</title>', 'hi') })
    const stop = new AbortController()
    stop.abort()
    const read = await readPublicPage('https://acme.in/', { signal: stop.signal })
    expect(read).toMatchObject({ ok: false, why: 'timeout' })
    expect(requested()).toEqual([])
  })
})

describe('fetchFollowingRedirects checks its own start, as capture does', () => {
  it.each([
    'not a url', 'ftp://acme.in/', 'https://u:p@acme.in/', 'https://acme.in:8080/', 'https://localhost/',
    'https://127.0.0.1/', 'https://db.internal/',
  ])('refuses %s with AddressRefused and no request', async (url) => {
    await expect(fetchFollowingRedirects(url, 1000)).rejects.toThrow(AddressRefused)
    expect(requested()).toEqual([])
  })

  // It is exported from the package root and takes any path, so the probe
  // check is its own, not only the page reader's hook (§2.2).
  it.each(['https://acme.in/.git/config', 'https://acme.in/.env', 'https://acme.in/wp-admin/', 'https://acme.in/db.sql'])(
    'refuses a probe, %s, with no hook passed and no request',
    async (url) => {
      await expect(fetchFollowingRedirects(url, 1000)).rejects.toThrow(/probe/)
      expect(requested()).toEqual([])
    },
  )

  it('refuses a redirect to a probe with no hook passed, before requesting it', async () => {
    reply('https://acme.in/', { status: 302, headers: { Location: '/.env' } })
    await expect(fetchFollowingRedirects('https://acme.in/', 1000)).rejects.toThrow(AddressRefused)
    expect(requested()).toEqual(['https://acme.in/'])
  })
})

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

describe('what a read sends', () => {
  it('connects through publicOnlyLookup, as a GET with no cookie and no credential', async () => {
    reply('https://acme.in/contact', { status: 200, headers: HTML, body: html('<title>Contact</title>', 'Call us') })
    const read = await readPublicPage('https://acme.in/contact')
    expect(read.ok).toBe(true)
    expect(net.state.requests).toHaveLength(1)
    const { options } = net.state.requests[0]!
    expect(options.lookup).toBe(publicOnlyLookup)
    expect(options.method).toBe('GET')
    const headers = Object.keys(options.headers as object).map((h) => h.toLowerCase())
    expect(headers).not.toContain('cookie')
    expect(headers).not.toContain('authorization')
    expect(options.auth).toBeUndefined()
    // A signal, so a caller that stops waiting closes the connection.
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('leaves a scan’s requests exactly as they were: no signal on any of them', async () => {
    reply('https://acme.in/', { status: 200, headers: HTML, body: html('<title>Acme</title>', 'hi') })
    const raw = await capture('acme.in')
    expect(raw.home.ok).toBe(true)
    expect(net.state.requests.length).toBe(7) // the homepage and the six frozen paths
    for (const { options } of net.state.requests) {
      expect(options).not.toHaveProperty('signal')
      expect(options.lookup).toBe(publicOnlyLookup)
    }
  })
})

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe('a redirect cannot take the reader where it would not go', () => {
  it('refuses a redirect to a probe before requesting it', async () => {
    reply('https://acme.in/', { status: 302, headers: { Location: '/wp-admin/' } })
    const read = await readPublicPage('https://acme.in/')
    expect(read).toMatchObject({ ok: false, why: 'refused' })
    if (!read.ok) expect(read.detail).toMatch(/redirected to an address the page reader never requests/)
    expect(requested()).toEqual(['https://acme.in/'])
  })

  it('refuses a redirect that would carry a username and password, before it becomes a header', async () => {
    reply('https://acme.in/', { status: 302, headers: { Location: 'https://admin:pw@acme.in/members' } })
    const read = await readPublicPage('https://acme.in/')
    expect(read).toMatchObject({ ok: false, why: 'refused' })
    expect(requested()).toEqual(['https://acme.in/'])
    expect(JSON.stringify(read)).not.toContain('pw@')
  })

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/',
    'https://intranet.corp/',
    'https://acme.in:8443/',
    'gopher://acme.in/',
  ])('refuses a redirect to %s', async (location) => {
    reply('https://acme.in/', { status: 301, headers: { Location: location } })
    const read = await readPublicPage('https://acme.in/')
    expect(read).toMatchObject({ ok: false, why: 'refused' })
    if (!read.ok) expect(read.detail).toMatch(/not a public website on its usual port/)
    expect(requested()).toEqual(['https://acme.in/'])
  })

  it('follows an ordinary redirect and says where the page came from', async () => {
    reply('https://acme.in/', { status: 308, headers: { Location: 'https://www.acme.in/' } })
    reply('https://www.acme.in/', { status: 200, headers: HTML, body: html('<title>Acme Dental</title>', 'Welcome') })
    const read = await readPublicPage('https://acme.in/')
    expect(read).toMatchObject({ ok: true, url: 'https://acme.in/', finalUrl: 'https://www.acme.in/', title: 'Acme Dental' })
  })

  it('closes a redirect’s endless body once the read is done', async () => {
    reply('https://acme.in/', { status: 302, headers: { Location: 'https://www.acme.in/' }, body: 'moved', drip: true })
    reply('https://www.acme.in/', { status: 200, headers: HTML, body: html('<title>Acme</title>', 'hi') })
    const read = await readPublicPage('https://acme.in/')
    expect(read).toMatchObject({ ok: true, title: 'Acme' })
    // Drained rather than read by get(), and never ended by the site.
    expect(net.state.responses[0]!.stream.destroyed).toBe(true)
  })

  it('stops after ten hops and calls it a status, not a page', async () => {
    reply('https://loop.acme.in/', { status: 302, headers: { Location: '/' } })
    const read = await readPublicPage('https://loop.acme.in/')
    expect(read).toMatchObject({ ok: false, why: 'status', status: 302 })
    if (!read.ok) expect(read.detail).toMatch(/kept redirecting/)
    expect(requested()).toHaveLength(11)
  })
})

// ---------------------------------------------------------------------------
// What came back
// ---------------------------------------------------------------------------

describe('only a web page is read', () => {
  it('refuses a PDF from its headers and never downloads it', async () => {
    reply('https://acme.in/brochure', { status: 200, headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-1.7 …' })
    const read = await readPublicPage('https://acme.in/brochure')
    expect(read).toMatchObject({ ok: false, why: 'not_a_page' })
    if (!read.ok) expect(read.detail).toMatch(/application\/pdf/)
    expect(net.state.responses[0]!.stream.readableDidRead).toBe(false)
  })

  it('refuses a response that does not say what it is', async () => {
    reply('https://acme.in/x', { status: 200, headers: {}, body: '<title>x</title>' })
    expect(await readPublicPage('https://acme.in/x')).toMatchObject({ ok: false, why: 'not_a_page' })
  })

  it('answers a 404 as a status, and reads none of its body', async () => {
    reply('https://acme.in/contact', { status: 404, headers: HTML, body: html('<title>Not found</title>', 'gone') })
    const read = await readPublicPage('https://acme.in/contact')
    expect(read).toMatchObject({ ok: false, why: 'status', status: 404 })
    if (!read.ok) expect(read.detail).toBe('The site answered 404 — there is no page at that address.')
    expect(net.state.responses[0]!.stream.readableDidRead).toBe(false)
  })

  it('reads a gzipped page: title, words and the HTML', async () => {
    const page = html(
      '<title> Kumar   Dental &amp; Implants &ndash; Bengaluru </title><script>var t="<title>no</title>"</script>',
      '<svg><title>phone icon</title></svg><p>Call +91 98765 43210</p><footer>info@kumardental.in</footer>',
    )
    reply('https://kumardental.in/', {
      status: 200, headers: { ...HTML, 'Content-Encoding': 'gzip' }, body: gzipSync(Buffer.from(page)),
    })
    const read = await readPublicPage('https://kumardental.in/')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.title).toBe('Kumar Dental & Implants – Bengaluru')
    expect(read.text).toContain('Call +91 98765 43210')
    expect(read.text).toContain('info@kumardental.in')
    expect(read.text).not.toContain('phone icon')
    expect(read.text).not.toContain('var t')
    expect(read.html).toBe(page)
    expect(read.truncated).toBe(false)
    expect(read.status).toBe(200)
  })

  it('reads plain text as itself, with no title', async () => {
    reply('http://acme.in/humans.txt', { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'Team:\r\nJo' })
    expect(await readPublicPage('http://acme.in/humans.txt')).toMatchObject({
      ok: true, title: null, text: 'Team:\nJo', html: 'Team:\r\nJo',
    })
  })

  it('says a page longer than the read cap is its beginning only', async () => {
    const body = Buffer.concat([Buffer.from('<title>Big</title><p>'), Buffer.alloc(MAX_ENCODED_BYTES + 5_000, 0x61)])
    reply('https://acme.in/big', { status: 200, headers: HTML, body })
    const read = await readPublicPage('https://acme.in/big')
    expect(read).toMatchObject({ ok: true, truncated: true, title: 'Big' })
    if (read.ok) expect(read.html.length).toBe(MAX_ENCODED_BYTES)
  })

  it('refuses a compressed page that would inflate past what the reader holds', async () => {
    const bomb = gzipSync(Buffer.alloc(READ_PAGE_MAX_DECODED_BYTES + 1_000_000, 0x61))
    reply('https://acme.in/', { status: 200, headers: { ...HTML, 'Content-Encoding': 'gzip' }, body: bomb })
    expect(await readPublicPage('https://acme.in/')).toMatchObject({ ok: false, why: 'too_large' })
  })
})

describe('a read that fails says how, in a sentence', () => {
  it('refuses a name that resolves to an address that is not public', async () => {
    reply('https://rebind.acme.in/', new NonPublicAddressError('rebind.acme.in'))
    const read = await readPublicPage('https://rebind.acme.in/')
    expect(read).toMatchObject({ ok: false, why: 'refused' })
    if (!read.ok) expect(read.detail).toBe('rebind.acme.in resolves to an address that is not on the public internet, so it is not read.')
  })

  it('says a name that does not resolve answers nowhere', async () => {
    const read = await readPublicPage('https://yummybites-delhi.business.site/')
    expect(read).toMatchObject({ ok: false, why: 'unreachable' })
    if (!read.ok) expect(read.detail).toBe('No website answers at yummybites-delhi.business.site: the name does not resolve.')
  })

  it('calls a silent socket a timeout', async () => {
    reply('https://slow.acme.in/', Object.assign(new Error('request timed out'), { name: 'TimeoutError' }))
    const read = await readPublicPage('https://slow.acme.in/', { timeoutMs: 3_000 })
    expect(read).toMatchObject({ ok: false, why: 'timeout', detail: 'The site did not answer within 3 seconds.' })
  })

  it('calls a body that falls silent a timeout, not the site closing the connection', async () => {
    reply('https://stall.acme.in/', { status: 200, headers: HTML, body: '<title>half a page', stall: true })
    const read = await readPublicPage('https://stall.acme.in/', { timeoutMs: 3_000 })
    expect(read).toMatchObject({ ok: false, why: 'timeout', detail: 'The site did not answer within 3 seconds.' })
  })

  it('leaves a scan recording a silent body as Node reported it', async () => {
    reply('https://stall.acme.in/', { status: 200, headers: HTML, body: '<title>half a page', stall: true })
    const raw = await capture('stall.acme.in')
    expect(raw.home).toMatchObject({ ok: false, error: 'ECONNRESET: aborted' })
  })

  it('closes a body that drips past the ceiling, and says it took too long', async () => {
    reply('https://drip.acme.in/', { status: 200, headers: HTML, body: '<title>never ends</title>', drip: true })
    const read = await readPublicPage('https://drip.acme.in/', { totalMs: 50 })
    expect(read).toMatchObject({ ok: false, why: 'timeout' })
    if (!read.ok) expect(read.detail).toMatch(/took longer than a second/)
    expect(net.state.responses[0]!.stream.destroyed).toBe(true)
  })

  it('stops when the caller stops, and closes the connection', async () => {
    reply('https://drip.acme.in/', { status: 200, headers: HTML, body: '<title>never ends</title>', drip: true })
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    const read = await readPublicPage('https://drip.acme.in/', { signal: stop.signal })
    expect(read).toMatchObject({ ok: false, why: 'timeout', detail: 'The read was stopped before the page arrived.' })
    expect(net.state.responses[0]!.stream.destroyed).toBe(true)
  })

  it('words the rest by the error’s code, and never its message', () => {
    const err = (code: string) => Object.assign(new Error(`secret-token-in-message ${code}`), { code })
    const cases: Array<[string, string, string]> = [
      ['ECONNREFUSED', 'unreachable', 'The site refused the connection.'],
      ['ECONNRESET', 'unreachable', 'The site closed the connection before the page arrived.'],
      ['EHOSTUNREACH', 'unreachable', 'The site could not be reached from here.'],
      ['EAI_AGAIN', 'unreachable', 'The name acme.in could not be looked up just now.'],
      ['ETIMEDOUT', 'timeout', 'The site did not answer within 8 seconds.'],
      ['CERT_HAS_EXPIRED', 'unreachable', 'The site’s certificate is not one a browser would accept (CERT_HAS_EXPIRED), so the page was not read.'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'unreachable', 'The site’s certificate is not one a browser would accept (ERR_TLS_CERT_ALTNAME_INVALID), so the page was not read.'],
      ['HPE_INVALID_CONSTANT', 'unreachable', 'The site answered with something that is not a web response.'],
      ['EWHATEVER', 'unreachable', 'The page could not be fetched (EWHATEVER).'],
    ]
    for (const [code, why, detail] of cases) {
      const read = readFailure('https://acme.in/', 'acme.in', err(code), 8_000)
      expect(read, code).toEqual({ ok: false, url: 'https://acme.in/', why, detail })
    }
    expect(JSON.stringify(readFailure('https://acme.in/', 'acme.in', new Error('secret-token-in-message'), 8_000)))
      .not.toContain('secret-token')
    // A redirect's host, when the failure names one, rather than the one asked for.
    const hop = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN', hostname: 'www.acme.in' })
    expect(readFailure('https://acme.in/', 'acme.in', hop, 8_000)).toMatchObject({
      detail: 'The name www.acme.in could not be looked up just now.',
    })
    // Something that is not an error at all is still an answer, not a crash.
    for (const thrown of [null, undefined, 'a string']) {
      expect(readFailure('https://acme.in/', 'acme.in', thrown, 8_000)).toMatchObject({ ok: false, why: 'unreachable' })
    }
  })

  it('throws a bug in its own code rather than calling it a page that could not be read', () => {
    expect(() => readFailure('https://acme.in/', 'acme.in', new TypeError('x is not a function'), 8_000)).toThrow(TypeError)
    expect(readFailure('https://acme.in/', 'acme.in', new PageTooLarge(), 8_000)).toMatchObject({ why: 'too_large' })
    expect(readFailure('https://acme.in/', 'acme.in', new PageUndecodable('zstd'), 8_000)).toMatchObject({ why: 'not_a_page' })
  })
})

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

describe('pageFromResponse', () => {
  const res = (status: number, headers: Record<string, string>, body = '') => ({
    status, finalUrl: 'https://acme.in/', headers, body, truncated: false,
  })
  const ctHtml = { 'content-type': 'text/html' }

  it('reads status as a refusal with its own words', () => {
    expect(pageFromResponse('u', res(403, ctHtml))).toMatchObject({ why: 'status', status: 403, detail: 'The site answered 403 — the page is not public.' })
    expect(pageFromResponse('u', res(429, ctHtml))).toMatchObject({ detail: 'The site answered 429 — the site is refusing requests for now.' })
    expect(pageFromResponse('u', res(503, ctHtml))).toMatchObject({ detail: 'The site answered 503 — its server failed to give the page.' })
    expect(pageFromResponse('u', res(204, ctHtml))).toMatchObject({ why: 'status', detail: 'The site answered 204 — it gave no page.' })
    expect(pageFromResponse('u', res(302, ctHtml))).toMatchObject({ why: 'status', detail: expect.stringMatching(/does not say where to/) })
    expect(pageFromResponse('u', res(302, { ...ctHtml, location: '/next' }))).toMatchObject({ detail: expect.stringMatching(/kept redirecting/) })
    // Not redirects get() follows, so never "kept redirecting", Location or not.
    expect(pageFromResponse('u', res(300, { ...ctHtml, location: '/a' }))).toMatchObject({ why: 'status', status: 300, detail: 'The site answered 300 — it gave no page.' })
    expect(pageFromResponse('u', res(304, ctHtml))).toMatchObject({ why: 'status', status: 304, detail: 'The site answered 304 — it gave no page.' })
  })

  it('accepts HTML, XHTML and plain text — parameters and case ignored — and nothing else', () => {
    for (const ct of ['text/html', 'TEXT/HTML; charset=UTF-8', 'application/xhtml+xml', 'text/plain; charset=us-ascii']) {
      expect(pageFromResponse('u', res(200, { 'content-type': ct })).ok, ct).toBe(true)
    }
    for (const ct of ['application/json', 'image/png', 'application/octet-stream', 'text/css', 'text/xml', '']) {
      expect(pageFromResponse('u', res(200, { 'content-type': ct })), ct).toMatchObject({ ok: false, why: 'not_a_page' })
    }
  })

  it('never repeats a header that is not a media type', () => {
    const read = pageFromResponse('u', res(200, { 'content-type': 'x"><script>alert(1)</script>' }))
    expect(read).toMatchObject({ why: 'not_a_page', detail: 'That address did not say it is a web page, so it was not downloaded.' })
  })
})

describe('pageTitle', () => {
  it('takes the first title outside an SVG, whitespace collapsed and entities decoded', () => {
    expect(pageTitle('<svg><title>icon</title></svg><title>\n  Acme\t&amp;  Co  </title>')).toBe('Acme & Co')
    expect(pageTitle('<svg><svg><title>inner</title></svg><title>outer</title></svg><title>Page</title>')).toBe('Page')
    expect(pageTitle('<SVG viewBox="0 0 1 1"><TITLE>icon</TITLE></SVG><TITLE>Upper</TITLE>')).toBe('Upper')
    expect(pageTitle('<svg/><title>After a self-closed svg</title>')).toBe('After a self-closed svg')
  })

  it('reads no title out of a comment or a script', () => {
    expect(pageTitle('<!-- <title>old</title> --><title>new</title>')).toBe('new')
    expect(pageTitle('<script>document.write("<title>x</title>")</script><title>real</title>')).toBe('real')
    expect(pageTitle('<style>title{}</style><title>styled</title>')).toBe('styled')
  })

  it('is null for none, an empty one, or one never closed', () => {
    expect(pageTitle('<p>no title</p>')).toBeNull()
    expect(pageTitle('<title>   </title>')).toBeNull()
    expect(pageTitle('<title>cut off by the read cap')).toBeNull()
    expect(pageTitle('<titles>not a title</titles>')).toBeNull()
  })

  it('keeps a long title to two hundred characters', () => {
    const t = pageTitle(`<title>${'é'.repeat(500)}</title>`)
    expect(Array.from(t!)).toHaveLength(200)
  })
})

describe('withoutHiddenParts', () => {
  it('keeps the page after an SVG that is never closed, so the footer is still read', () => {
    const out = withoutHiddenParts('<header><svg viewBox="0 0 1 1"><path d="M0"></header><footer>Call 98765 43210</footer>')
    expect(out).toContain('Call 98765 43210')
  })

  it('drops a script or comment that never closes to the end, as a browser does', () => {
    expect(withoutHiddenParts('<p>a</p><script>var x = 1')).toBe('<p>a</p> ')
    expect(withoutHiddenParts('<p>a</p><!-- <p>b</p>')).toBe('<p>a</p> ')
  })

  it('keeps the words either side apart', () => {
    expect(withoutHiddenParts('Call<script>x</script>us')).toBe('Call us')
  })

  it('reads hostile markup in linear time', () => {
    for (const hostile of [
      '<svg'.repeat(200_000),
      '<svg>'.repeat(100_000),
      '<script'.repeat(100_000),
      '<svg><svg/>'.repeat(50_000) + '</svg'.repeat(50_000),
      '<title'.repeat(150_000),
      '<!-'.repeat(200_000),
    ]) {
      const started = performance.now()
      withoutHiddenParts(hostile)
      pageTitle(hostile)
      expect(performance.now() - started, hostile.slice(0, 12)).toBeLessThan(1_500)
    }
  })
})

describe('decodePageBody', () => {
  const page = '<title>Café Nilgiri — Ooty</title>'

  it('undoes gzip, deflate in either wrapping, and brotli', () => {
    expect(decodePageBody(gzipSync(Buffer.from(page)), { 'content-encoding': 'gzip' })).toBe(page)
    expect(decodePageBody(deflateSync(Buffer.from(page)), { 'content-encoding': 'deflate' })).toBe(page)
    expect(decodePageBody(deflateRawSync(Buffer.from(page)), { 'content-encoding': 'deflate' })).toBe(page)
    expect(decodePageBody(brotliCompressSync(Buffer.from(page)), { 'content-encoding': 'br' })).toBe(page)
    expect(decodePageBody(Buffer.from(page), {})).toBe(page)
    expect(decodePageBody(Buffer.from(page), { 'content-encoding': 'identity' })).toBe(page)
  })

  it('reads a gzip stream cut by the read cap as far as it goes', () => {
    // Varied enough that half the compressed stream is half the page, as a real one is.
    const rows = Array.from({ length: 4_000 }, (_, i) => `<p>Item ${i} ${randomBytes(6).toString('hex')}</p>`).join('')
    const whole = gzipSync(Buffer.from(page + rows + '<footer>end</footer>'))
    const out = decodePageBody(whole.subarray(0, Math.floor(whole.length / 2)), { 'content-encoding': 'gzip' })
    expect(out.startsWith(page)).toBe(true)
  })

  it('refuses what it cannot undo, and a bomb', () => {
    expect(() => decodePageBody(Buffer.from('not gzip at all'), { 'content-encoding': 'gzip' })).toThrow(PageUndecodable)
    expect(() => decodePageBody(Buffer.from('zz'), { 'content-encoding': 'zstd' })).toThrow(PageUndecodable)
    const bomb = gzipSync(Buffer.alloc(READ_PAGE_MAX_DECODED_BYTES + 1, 0x20))
    expect(() => decodePageBody(bomb, { 'content-encoding': 'gzip' })).toThrow(PageTooLarge)
  })

  it('reads the charset the response or the page names, and UTF-8 otherwise', () => {
    const cp1252 = Buffer.from([0x3c, 0x70, 0x3e, 0x93, 0x48, 0x69, 0x94, 0x20, 0x96, 0x20, 0x43, 0x61, 0x66, 0xe9])
    expect(decodePageBody(cp1252, { 'content-type': 'text/html; charset=windows-1252' })).toBe('<p>“Hi” – Café')
    const meta = Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), Buffer.from([0x43, 0x61, 0x66, 0xe9])])
    expect(decodePageBody(meta, {})).toBe('<meta charset="iso-8859-1">Café')
    expect(decodePageBody(Buffer.from('<p>Café</p>'), { 'content-type': 'text/html; charset=klingon' })).toBe('<p>Café</p>')
    expect(decodePageBody(Buffer.from('<meta charset="utf-16"><p>Café</p>'), {})).toBe('<meta charset="utf-16"><p>Café</p>')
  })
})

describe('the package root', () => {
  it('exports the reader and its types, not its insides', () => {
    expect(typeof scannerRoot.readPublicPage).toBe('function')
    expect(typeof scannerRoot.fetchFollowingRedirects).toBe('function')
    expect(scannerRoot).not.toHaveProperty('readFailure')
    expect(scannerRoot).not.toHaveProperty('pageFromResponse')
  })
})
