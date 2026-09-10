import { describe, it, expect } from 'vitest'
import { capture, UnscannableHostError } from '../src/fetch.js'
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
