/**
 * The thirteen informational signals (additive.ts), on hand-built captures.
 *
 * None of these is scored, so none of them can move a number — which makes
 * the §2.2 rules the only thing worth asserting about them: an absence read
 * off a prefix is not an absence, a capture that never recorded cookies says
 * nothing about cookies, "not applicable" is never a claim either way, and a
 * vendor's cookie or a tag manager's script is not the site's failing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ADDITIVE_SIGNAL_KEYS, additiveObservations, parseSetCookie, type AdditiveKey } from '../src/additive.js'
import { extractProfile } from '../src/extract.js'
import { extractHtmlFacts } from '../src/html.js'
import type { RawCapture } from '../src/types.js'
import { fixtureNames, loadFixture } from './fixtures.js'

type Home = RawCapture['home']

function capture(home: Partial<Home> = {}): RawCapture {
  return {
    domain: 'example.com',
    capturedAt: '2026-09-10T00:00:00.000Z',
    home: {
      ok: true, status: 200, finalUrl: 'https://example.com/',
      headers: {}, body: '<html><head><title>Acme</title></head><body></body></html>',
      ...home,
    },
    paths: {},
    tls: { ok: true, protocol: 'TLSv1.3', issuer: "Let's Encrypt", expires: '2026-12-01', daysToExpiry: 82 },
  }
}

function observe(home: Partial<Home> = {}) {
  const raw = capture(home)
  return additiveObservations(raw, extractHtmlFacts(raw.home.body))
}

function one(key: AdditiveKey, home: Partial<Home> = {}) {
  return observe(home)[key]
}

describe('the key set', () => {
  it('is thirteen keys, none of them in the ICP the goldens were computed against', () => {
    expect(ADDITIVE_SIGNAL_KEYS).toHaveLength(13)
    expect(new Set(ADDITIVE_SIGNAL_KEYS).size).toBe(13)
    const icp = JSON.parse(readFileSync(new URL('./icp-parity.json', import.meta.url), 'utf8')) as {
      signals: Record<string, unknown>
    }
    for (const key of ADDITIVE_SIGNAL_KEYS) expect(Object.keys(icp.signals), key).not.toContain(key)
  })

  it('is produced whole for a homepage that answered, and not at all for one that did not', () => {
    const reached = extractProfile(capture())
    for (const key of ADDITIVE_SIGNAL_KEYS) expect(reached.observations, key).toHaveProperty(key)

    const unreachable = extractProfile(capture({ ok: false, status: null, finalUrl: '', error: 'TimeoutError' }))
    expect(Object.keys(unreachable.observations)).toEqual([])
  })

  /**
   * `findings_unobserved_has_no_gap` rejects an unobserved row with a gap, and
   * §2.2 wants evidence on every row — so one malformed observation here would
   * fail every real scan's insert, not just this signal's.
   */
  it('gives every observation evidence, and every unobserved one gap null', () => {
    const variants: Array<Partial<Home>> = [
      {},
      { truncated: true },
      { setCookies: [] },
      { setCookies: ['sid=<redacted>'] },
      { finalUrl: 'http://example.com/' },
      {
        headers: {
          'content-security-policy': "script-src 'self' 'unsafe-inline'",
          'content-security-policy-report-only': "default-src 'self'",
          'referrer-policy': 'unsafe-url',
          'permissions-policy': 'camera=*',
          'x-content-type-options': 'yes',
          'strict-transport-security': 'max-age=60',
          'x-xss-protection': '1',
          server: 'nginx/1.2',
        },
      },
    ]
    for (const home of variants) {
      for (const [key, o] of Object.entries(observe(home))) {
        expect(Object.keys(o.evidence ?? {}).length, `${key} carries no evidence`).toBeGreaterThan(0)
        if (!o.observed) expect(o.gap, `${key} is unobserved but claims a gap`).toBeNull()
        if (o.detail.startsWith('not applicable')) {
          expect(o.observed, key).toBe(true)
          expect(o.gap, `${key}: not applicable is never a gap`).toBe(false)
        }
      }
    }
  })
})

describe('Content-Security-Policy', () => {
  it('flags a report-only policy standing in for an enforced one', () => {
    const o = one('csp_report_only', { headers: { 'content-security-policy-report-only': "default-src 'self'" } })
    expect(o.gap).toBe(true)
    expect(o.evidence).toMatchObject({ enforcedPresent: false, seen: "default-src 'self'" })
  })

  it('does not flag report-only beside an enforced policy', () => {
    const o = one('csp_report_only', {
      headers: {
        'content-security-policy': "default-src 'self'",
        'content-security-policy-report-only': "default-src 'none'",
      },
    })
    expect(o.gap).toBe(false)
    expect(o.evidence).toMatchObject({ enforcedPresent: true })
  })

  it('is not applicable, never a gap, when there is no CSP to judge', () => {
    const o = one('csp_quality')
    expect(o).toMatchObject({ observed: true, gap: false })
    expect(o.detail).toMatch(/^not applicable/)
  })

  it("flags 'unsafe-inline' in script-src without a nonce", () => {
    const o = one('csp_quality', { headers: { 'content-security-policy': "script-src 'self' 'unsafe-inline'" } })
    expect(o.gap).toBe(true)
    expect(o.evidence).toMatchObject({ problems: ["'unsafe-inline' without a nonce or hash"] })
  })

  it("does not flag 'unsafe-inline' beside a nonce, which makes browsers ignore it", () => {
    const o = one('csp_quality', {
      headers: { 'content-security-policy': "script-src 'self' 'unsafe-inline' 'nonce-r4nd0m'" },
    })
    expect(o.gap).toBe(false)
  })

  it("does not flag 'unsafe-inline' that appears only in style-src", () => {
    const o = one('csp_quality', {
      headers: { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" },
    })
    expect(o.gap).toBe(false)
    expect((o.evidence as { directives: { scriptSrc: string } }).directives.scriptSrc).toBe("'self'")
  })

  it("flags 'unsafe-eval' and a wildcard source, falling back to default-src", () => {
    const o = one('csp_quality', { headers: { 'content-security-policy': "default-src * 'unsafe-eval'" } })
    expect(o.gap).toBe(true)
    expect((o.evidence as { problems: string[] }).problems).toEqual(["'unsafe-eval'", '* as a script source'])
  })

  it('treats a policy with no script directive as restricting no scripts', () => {
    const o = one('csp_quality', { headers: { 'content-security-policy': "frame-ancestors 'self'" } })
    expect(o.gap).toBe(true)
    expect(o.detail).toMatch(/scripts are unrestricted/)
  })
})

describe('headers the scored signals only check for presence', () => {
  it('calls no-referrer-when-downgrade what it is: the old default, not a restriction', () => {
    const weak = one('referrer_policy_quality', { headers: { 'referrer-policy': 'no-referrer-when-downgrade' } })
    expect(weak.gap).toBe(true)
    expect(weak.detail).toContain('browser default, not restrictive')

    const strict = one('referrer_policy_quality', { headers: { 'referrer-policy': 'strict-origin-when-cross-origin' } })
    expect(strict.gap).toBe(false)
  })

  it('reads a Referrer-Policy fallback list the way a browser does — the last token it knows', () => {
    const o = one('referrer_policy_quality', { headers: { 'referrer-policy': 'unsafe-url, strict-origin' } })
    expect(o.gap).toBe(false)
  })

  it('flags the deprecated Feature-Policy spelling', () => {
    const o = one('permissions_policy_quality', { headers: { 'feature-policy': "camera 'none'" } })
    expect(o.gap).toBe(true)
    expect(o.detail).toMatch(/Feature-Policy/)
  })

  it('flags a Permissions-Policy that restricts none of the powerful features', () => {
    expect(one('permissions_policy_quality', { headers: { 'permissions-policy': 'fullscreen=(self)' } }).gap).toBe(true)
    expect(one('permissions_policy_quality', { headers: { 'permissions-policy': 'camera=*' } }).gap).toBe(true)
    const ok = one('permissions_policy_quality', { headers: { 'permissions-policy': 'camera=(), geolocation=(self)' } })
    expect(ok.gap).toBe(false)
    expect(ok.evidence).toMatchObject({ restricts: ['camera', 'geolocation'] })
  })

  it('accepts nosniff in any case and with whitespace, and flags anything else', () => {
    expect(one('content_type_options_quality', { headers: { 'x-content-type-options': 'NOSNIFF ' } }).gap).toBe(false)
    expect(one('content_type_options_quality', { headers: { 'x-content-type-options': 'nosniff, nosniff' } }).gap).toBe(true)
  })

  it('flags COOP unsafe-none, and the absence of all three cross-origin headers', () => {
    expect(one('cross_origin_policies', { headers: { 'cross-origin-opener-policy': 'unsafe-none' } }).gap).toBe(true)
    expect(one('cross_origin_policies').gap).toBe(true)
    const ok = one('cross_origin_policies', { headers: { 'cross-origin-opener-policy': 'same-origin' } })
    expect(ok.gap).toBe(false)
    expect(ok.evidence).toMatchObject({ coop: 'same-origin', coep: 'absent', corp: 'absent' })
  })

  it('flags an HSTS max-age under 180 days, not a year', () => {
    const short = one('hsts_quality', { headers: { 'strict-transport-security': 'max-age=3600' } })
    expect(short.gap).toBe(true)
    expect(short.evidence).toMatchObject({ maxAge: 3600 })
    const year = one('hsts_quality', { headers: { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } })
    expect(year.gap).toBe(false)
    expect(year.evidence).toMatchObject({ maxAge: 31536000, includeSubDomains: true, preload: false })
    expect(one('hsts_quality').detail).toMatch(/^not applicable/)
  })
})

describe('what the server says about itself', () => {
  it('flags a build hash in Server, but not a bare CDN name', () => {
    expect(one('stack_disclosure', { headers: { server: 'Framer/bea9510' } }).gap).toBe(true)
    expect(one('stack_disclosure', { headers: { server: 'cloudflare' } }).gap).toBe(false)
    expect(one('stack_disclosure', { headers: { 'x-aspnet-version': '4.0.30319' } }).gap).toBe(true)
  })

  it('does not flag x-xss-protection: 0, which is the recommended value', () => {
    const zero = one('deprecated_headers', { headers: { 'x-xss-protection': '0' } })
    expect(zero.gap).toBe(false)
    expect(zero.evidence).toMatchObject({ xXssProtection: '0' })
    expect(one('deprecated_headers', { headers: { 'x-xss-protection': '1; mode=block' } }).gap).toBe(true)
    expect(one('deprecated_headers', { headers: { 'expect-ct': 'max-age=0' } }).gap).toBe(true)
  })

  it('never flags reporting endpoints, present or not', () => {
    const nel = one('reporting_endpoints', { headers: { nel: '{"report_to":"default","max_age":2592000}' } })
    expect(nel).toMatchObject({ observed: true, gap: false })
    expect(nel.detail).toContain('NEL')
    expect(one('reporting_endpoints')).toMatchObject({ observed: true, gap: false })
  })
})

describe('cookies', () => {
  it('is UNOBSERVED when the capture did not record cookies — never "no cookies"', () => {
    const o = one('cookie_flags')
    expect(o).toMatchObject({ observed: false, gap: null, detail: 'not captured' })
  })

  it('is not applicable, never a strength, when the homepage set none', () => {
    const o = one('cookie_flags', { setCookies: [] })
    expect(o).toMatchObject({ observed: true, gap: false })
    expect(o.detail).toBe('not applicable — no cookies set on the homepage')
  })

  it('reads attribute names in any case', () => {
    expect(parseSetCookie('SID=<redacted>; SECURE; httponly; SameSite=STRICT')).toEqual({
      name: 'SID', secure: true, httpOnly: true, sameSite: 'strict', isCdn: false,
    })
  })

  it('flags a session cookie without Secure or HttpOnly', () => {
    const o = one('cookie_flags', { setCookies: ['app_session=<redacted>; Path=/; Secure'] })
    expect(o.gap).toBe(true)
    expect(o.detail).toMatch(/app_session lacks HttpOnly/)
  })

  it('flags SameSite=None without Secure on any cookie', () => {
    const o = one('cookie_flags', { setCookies: ['prefs=<redacted>; SameSite=None'] })
    expect(o.gap).toBe(true)
  })

  it("labels a CDN's cookie as the CDN's and leaves it out of the verdict", () => {
    const o = one('cookie_flags', { setCookies: ['_cfuvid=<redacted>; SameSite=None; Path=/'] })
    expect(o.gap).toBe(false)
    const cookies = (o.evidence as { cookies: Array<{ name: string; isCdn: boolean }> }).cookies
    expect(cookies).toEqual([expect.objectContaining({ name: '_cfuvid', isCdn: true })])
  })
})

describe('third-party scripts and mixed content', () => {
  const page = (body: string) => `<html><head><title>x</title>${body}</head><body></body></html>`

  it('counts third-party scripts only: not same-site ones, not ones inside noscript', () => {
    const o = one('sri_third_party', {
      body: page(
        '<script src="/app.js"></script>' +
          '<script src="https://cdn.example.com/lib.js"></script>' +
          '<script src="https://cdn.jsdelivr.net/a.js"></script>' +
          '<script src="https://unpkg.com/b.js" integrity="sha384-abc" crossorigin="anonymous"></script>' +
          '<noscript><script src="https://tracker.test/c.js"></script></noscript>',
      ),
    })
    expect(o.gap).toBe(true)
    expect(o.evidence).toMatchObject({ external: 2, withIntegrity: 1, hosts: ['cdn.jsdelivr.net'] })
    expect(o.detail).toMatch(/^integrity= on 1 of 2 third-party scripts/)
  })

  it('counts a tag manager in the ratio without flagging it', () => {
    const o = one('sri_third_party', {
      body: page('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-X"></script>'),
    })
    expect(o.gap).toBe(false)
    expect(o.evidence).toMatchObject({ external: 1, withIntegrity: 0, tagManagerHosts: ['www.googletagmanager.com'] })
    expect(o.detail).toMatch(/cannot use SRI/)
  })

  it('tells a blockable http:// script from an upgradable http:// image', () => {
    const o = one('mixed_content', {
      body: page('<script src="http://cdn.test/a.js"></script><img src="http://cdn.test/logo.png">'),
    })
    expect(o.gap).toBe(true)
    expect(o.evidence).toMatchObject({ blockable: ['http://cdn.test/a.js'], upgradable: ['http://cdn.test/logo.png'] })

    const imageOnly = one('mixed_content', { body: page('<img src="http://cdn.test/logo.png">') })
    expect(imageOnly.gap).toBe(false)
  })

  it('does not call a protocol-relative reference, a canonical link or a noscript script mixed', () => {
    const o = one('mixed_content', {
      body: page(
        '<script src="//cdn.test/a.js"></script>' +
          '<link rel="canonical" href="http://example.com/">' +
          '<noscript><iframe src="http://cdn.test/frame"></iframe></noscript>',
      ),
    })
    expect(o.gap).toBe(false)
    expect(o.evidence).toMatchObject({ blockable: [], upgradable: [] })
  })

  it('flags an http:// stylesheet as blockable', () => {
    const o = one('mixed_content', { body: page('<link rel="stylesheet" href="http://cdn.test/a.css">') })
    expect(o.gap).toBe(true)
  })

  /** The same §2.2 rule extract.ts applies to outdated_js and compliance_claim. */
  it('claims no absence off a body that hit the read cap', () => {
    const clean = observe({ truncated: true, body: page('<script src="/app.js"></script>') })
    expect(clean.sri_third_party).toMatchObject({ observed: false, gap: null })
    expect(clean.mixed_content).toMatchObject({ observed: false, gap: null })

    // A problem actually read in the part that was read still stands.
    const found = observe({
      truncated: true,
      body: page('<script src="http://cdn.test/a.js"></script><script src="https://cdn.jsdelivr.net/b.js"></script>'),
    })
    expect(found.mixed_content).toMatchObject({ observed: true, gap: true })
    expect(found.sri_third_party).toMatchObject({ observed: true, gap: true })
  })
})

/**
 * The sixteen recorded sites. Twelve informational signals read bytes these
 * recordings already hold; `cookie_flags` reads a field they predate, so it is
 * unobserved on every one of them — which is the honest answer.
 */
describe('every recorded fixture', () => {
  it.each(fixtureNames())('%s yields all thirteen keys without throwing', (domain) => {
    const fixture = loadFixture(domain)
    const profile = extractProfile(fixture, fixture.company)
    // All sixteen answered when recorded. Asserted rather than skipped, so a
    // re-recording that loses one cannot turn this into a test of nothing.
    expect(profile.fetchOk).toBe(true)
    for (const key of ADDITIVE_SIGNAL_KEYS) expect(profile.observations, key).toHaveProperty(key)
    expect(profile.observations.cookie_flags).toMatchObject({ observed: false, gap: null, detail: 'not captured' })
  })
})
