/**
 * Where the scanner may connect (`src/address.ts`), and the name check that
 * comes before it (`isScannableHost`): found by review on 2026-10-08, once a
 * public form began handing the scanner domains typed by strangers.
 */
import { describe, expect, it } from 'vitest'
import { URL } from 'node:url'
import {
  NonPublicAddressError, RedirectRefused, endsInANumber, fetchTls, isPublicAddress, isScannableHost, publicOnlyLookup,
  redirectTarget,
} from '../src/index.js'

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8',
  ])('lets %s through', (a) => {
    expect(isPublicAddress(a)).toBe(true)
  })

  it.each([
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '127.255.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '100.127.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', 'fe80::1', 'fe80::1%en0', 'fc00::1',
    'fd12:3456::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '64:ff9b::7f00:1',
    '2002:7f00:1::1', '::127.0.0.1',
    'not an address', '1.2.3', '256.1.1.1',
  ])('refuses %s', (a) => {
    expect(isPublicAddress(a)).toBe(false)
  })
})

describe('isScannableHost', () => {
  it('refuses a name the URL parser reads as an IPv4 address, in every spelling', () => {
    for (const host of ['127.1', '10.1', '0x7f.1', '169.254.43518', '0x7f000001.0x1', 'example.123', '127.0.0.1.', 'a.0x']) {
      expect(isScannableHost(host), host).toBe(false)
    }
    // The URL parser agrees: each of those is an address, not a name.
    expect(new URL('https://127.1/').hostname).toBe('127.0.0.1')
    expect(new URL('https://169.254.43518/').hostname).toBe('169.254.169.254')
    expect(new URL('https://0x7f.1/').hostname).toBe('127.0.0.1')
  })

  it('still takes every real name, digits in it or not', () => {
    for (const host of ['example.com', '1password.com', 'web3.io', '123.example.in', 'xn--80ak6aa92e.com', 'a1.b2.c3d']) {
      expect(isScannableHost(host), host).toBe(true)
    }
    expect(endsInANumber('1password.com')).toBe(false)
    expect(endsInANumber('shop.0x1f')).toBe(true)
  })
})

describe('publicOnlyLookup', () => {
  const ask = (host: string, all: boolean) =>
    new Promise<{ err: unknown; result: unknown }>((resolve) => {
      ;(publicOnlyLookup as unknown as (h: string, o: object, cb: (err: unknown, result: unknown) => void) => void)(
        host,
        { all },
        (err, result) => resolve({ err, result }),
      )
    })

  it('refuses a name that resolves to the machine itself, in both of the shapes Node asks for', async () => {
    for (const all of [false, true]) {
      const { err } = await ask('localhost', all)
      expect(err, String(all)).toBeInstanceOf(NonPublicAddressError)
      expect((err as NonPublicAddressError).code).toBe('ENOTPUBLIC')
    }
  })

  it('refuses the certificate check before any connection is made', async () => {
    const tls = await fetchTls('localhost')
    expect(tls).toMatchObject({ ok: false })
    expect((tls as { error: string }).error).toMatch(/^ENOTPUBLIC: localhost resolves to an address that is not public/)
  })
})

describe('redirectTarget', () => {
  it('refuses a hop to any port but the default', () => {
    const from = new URL('https://acme.io/')
    expect(() => redirectTarget('https://shop.acme.io:8443/', from)).toThrow(RedirectRefused)
    expect(() => redirectTarget('http://acme.io:22/', from)).toThrow(/port 22/)
    expect(redirectTarget('https://www.acme.io/', from).hostname).toBe('www.acme.io')
    expect(redirectTarget('https://www.acme.io:443/', from).hostname).toBe('www.acme.io')
  })
})
