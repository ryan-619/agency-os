import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { gzipSync, deflateRawSync } from 'node:zlib'
import { describe, it, expect } from 'vitest'
import {
  MAX_ENCODED_BYTES, capture, decodeBody, firstHeaders, readCapped, redirectTarget,
  RedirectRefused, UnscannableHostError,
} from '../src/fetch.js'
import { ALL_PUBLIC_PATHS, PUBLIC_PATHS } from '../src/types.js'

/**
 * fetch.ts is the only place in the system that makes an outbound request to a
 * prospect. These tests are about what it REFUSES to do.
 */
describe('the scanner refuses to be pointed anywhere but a public site', () => {
  it('throws rather than requesting a loopback or metadata address', async () => {
    for (const host of ['localhost', '127.0.0.1', '169.254.169.254', '[::1]', '10.0.0.1']) {
      await expect(capture(host), host).rejects.toThrow(UnscannableHostError)
    }
  })

  it('throws on a userinfo trick instead of quietly requesting the real host', async () => {
    // Would have requested internal.corp while the row read "evil.com".
    await expect(capture('evil.com@internal.corp')).rejects.toThrow(UnscannableHostError)
  })

  it('throws on reserved and internal suffixes', async () => {
    for (const host of ['db.internal', 'box.local', 'app.corp', 'thing.test']) {
      await expect(capture(host), host).rejects.toThrow(UnscannableHostError)
    }
  })

  it('names the host it refused, without inventing a reason', async () => {
    await expect(capture('127.0.0.1')).rejects.toThrow(/127\.0\.0\.1.*not a public hostname/s)
  })
})

describe('the path list is frozen (§2.2)', () => {
  it('is exactly the conventional, publicly-advertised paths — nothing else', () => {
    expect([...ALL_PUBLIC_PATHS].sort()).toEqual([
      '/.well-known/security.txt',
      '/security',
      '/security-and-privacy',
      '/security.txt',
      '/trust',
      '/trust-center',
    ])
  })

  it('probes nothing that looks like directory brute-forcing', () => {
    const forbidden = ['.git', '.env', 'admin', 'backup', 'wp-admin', '.svn', 'config', 'phpinfo']
    for (const path of ALL_PUBLIC_PATHS) {
      for (const f of forbidden) {
        expect(path.toLowerCase().includes(f), `${path} looks like probing for ${f}`).toBe(false)
      }
    }
  })

  it('splits the paths into the two signals that consume them', () => {
    expect([...PUBLIC_PATHS.security_txt, ...PUBLIC_PATHS.trust_page].sort())
      .toEqual([...ALL_PUBLIC_PATHS].sort())
  })
})

/**
 * The three places `fetch()` quietly disagreed with the engine this one has to
 * match. Each was invisible to the sixteen recorded fixtures, because the
 * fixtures store a body that is already decoded and headers that are already a
 * map — the parity harness cannot see a mistake made before the recording.
 */
describe('the reference engine\'s wire semantics', () => {
  it('reads the FIRST value of a repeated header, not a comma-joined one', () => {
    // `Headers.get` answers "default-src 'self', default-src *" here, which is
    // a Content-Security-Policy the server never sent — and the scanner would
    // quote it back to the prospect as what their site serves.
    const headers = firstHeaders([
      'Content-Security-Policy', "default-src 'self'",
      'Content-Security-Policy', 'default-src *',
      'X-Frame-Options', 'DENY',
    ])
    expect(headers['content-security-policy']).toBe("default-src 'self'")
    expect(headers['x-frame-options']).toBe('DENY')
  })

  it('answers nothing for a header name that is an Object property', () => {
    const headers = firstHeaders(['Server', 'nginx', 'Constructor', 'not a function'])
    expect(headers['server']).toBe('nginx')
    expect(headers['constructor']).toBe('not a function')
    expect(headers['tostring']).toBeUndefined()
    expect(headers['__proto__']).toBeUndefined()
  })

  it('gunzips and inflates, and keeps the raw bytes when it cannot', () => {
    expect(decodeBody(gzipSync(Buffer.from('<title>gz</title>')), 'gzip')).toBe('<title>gz</title>')
    expect(decodeBody(deflateRawSync(Buffer.from('<title>fl</title>')), 'deflate')).toBe('<title>fl</title>')
    expect(decodeBody(Buffer.from('<title>plain</title>'), '')).toBe('<title>plain</title>')

    // A gzip stream cut short by the read cap — incompressible bytes, so the
    // cut is a real cut. Python's `except Exception: pass` decodes the
    // COMPRESSED bytes as text and reads the mojibake as the page; this does
    // the same, because the two engines have to agree about it.
    const marker = '<title>never seen</title>'
    const whole = gzipSync(Buffer.concat([randomBytes(200_000), Buffer.from(marker)]))
    const out = decodeBody(whole.subarray(0, 1_000), 'gzip')
    expect(out).not.toContain(marker)
    expect(out.length).toBeGreaterThan(0)
  })

  it('caps the ENCODED stream, which is what `resp.read(1_500_000)` caps', async () => {
    const body = Buffer.alloc(MAX_ENCODED_BYTES + 10_000, 0x61)
    const stream = Readable.from([body.subarray(0, 1_000_000), body.subarray(1_000_000)])
    const { raw, truncated } = await readCapped(stream as never)
    expect(truncated).toBe(true)
    expect(raw.byteLength).toBe(MAX_ENCODED_BYTES)
  })

  it('does not claim truncation for a body that fitted', async () => {
    const stream = Readable.from([Buffer.from('<title>small</title>')])
    const { raw, truncated } = await readCapped(stream as never)
    expect(truncated).toBe(false)
    expect(raw.toString()).toBe('<title>small</title>')
  })
})


/**
 * The host check has to survive the redirect chain. Refusing `169.254.169.254`
 * in `companies.domain` is worth nothing if a company's own marketing site can
 * answer `302 Location: http://169.254.169.254/` and be followed.
 */
describe('a redirect cannot take the scanner off the public internet', () => {
  const from = new URL('https://example.com/')

  it('refuses a hop to a loopback, private or metadata address', () => {
    for (const target of [
      'http://127.0.0.1/', 'http://localhost:8080/', 'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/', 'https://[::1]/', 'http://db.internal/', 'http://box.local/',
    ]) {
      expect(() => redirectTarget(target, from), target).toThrow(RedirectRefused)
    }
  })

  it('refuses a relative hop that resolves onto a private host', () => {
    expect(() => redirectTarget('//169.254.169.254/', from)).toThrow(RedirectRefused)
  })

  it('refuses a scheme the scanner does not speak, including urllib\'s ftp', () => {
    for (const target of ['ftp://files.example.com/', 'file:///etc/passwd', 'gopher://x.example.com/']) {
      expect(() => redirectTarget(target, from), target).toThrow(RedirectRefused)
    }
  })

  it('names what it refused rather than inventing a reason', () => {
    expect(() => redirectTarget('http://169.254.169.254/', from))
      .toThrow(/169\.254\.169\.254.*not a public hostname/)
  })

  it('follows an ordinary hop, absolute or relative', () => {
    expect(redirectTarget('https://www.example.com/', from).toString()).toBe('https://www.example.com/')
    expect(redirectTarget('/en/', from).toString()).toBe('https://example.com/en/')
    expect(redirectTarget('//www.example.org/x', from).toString()).toBe('https://www.example.org/x')
  })
})


/**
 * The reference runs on Python 3.9, whose redirect handler has no
 * `http_error_308`, so a 308 raises there and the company is written down as
 * unreachable. `308 Location: https://www.<host>/` is the apex-to-www redirect
 * half the hosting industry emits: two of the sixteen seed domains answer with
 * exactly that, and "unreachable" is a false statement about both of them.
 */
describe('which redirects are followed', () => {
  it('follows every permanent and temporary redirect, 308 included', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { statusFollowed } = await import('../src/fetch.js')
      expect(statusFollowed(status), String(status)).toBe(true)
    }
  })

  it('does not treat a non-redirect status as one', async () => {
    const { statusFollowed } = await import('../src/fetch.js')
    for (const status of [200, 204, 304, 400, 404, 500]) {
      expect(statusFollowed(status), String(status)).toBe(false)
    }
  })
})
