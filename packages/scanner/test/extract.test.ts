import { describe, it, expect } from 'vitest'
import { extractProfile, probePublicPath, outdatedLibFor, normaliseDomain, isScannableHost } from '../src/extract.js'
import { extractHtmlFacts } from '../src/html.js'
import { PUBLIC_PATHS, type RawCapture, type RawResponse } from '../src/types.js'

/** A capture with everything healthy, then overridden. */
function capture(over: Partial<RawCapture> = {}): RawCapture {
  const paths: Record<string, RawResponse> = {}
  for (const p of [...PUBLIC_PATHS.security_txt, ...PUBLIC_PATHS.trust_page]) {
    paths[p] = { status: 404, body: 'not found' }
  }
  return {
    domain: 'example.com',
    capturedAt: '2026-09-10T00:00:00.000Z',
    home: {
      ok: true, status: 200, finalUrl: 'https://example.com/',
      headers: {}, body: '<html><head><title>Acme</title></head><body><input type="password"></body></html>',
    },
    paths,
    tls: { ok: true, protocol: 'TLSv1.3', issuer: "Let's Encrypt", expires: '2026-12-01', daysToExpiry: 82 },
    ...over,
  }
}

describe('normaliseDomain', () => {
  it('strips scheme, path and a leading www', () => {
    expect(normaliseDomain('https://www.Acme.com/pricing')).toBe('acme.com')
    expect(normaliseDomain('acme.io')).toBe('acme.io')
    expect(normaliseDomain('  HTTP://Acme.IO/a/b  ')).toBe('acme.io')
  })

  // Python's _norm stops after the path, leaving userinfo attached — so
  // `https://${_norm("a.com@internal")}/` requests *internal* while the row
  // still reads "a.com". Stripping userinfo is what makes the host honest.
  it('resolves to the REAL host when userinfo is attached', () => {
    expect(normaliseDomain('evil.com@internal.corp')).toBe('internal.corp')
    expect(normaliseDomain('user:pw@internal')).toBe('internal')
  })

  it('strips port, query and fragment', () => {
    expect(normaliseDomain('acme.io:8443')).toBe('acme.io')
    expect(normaliseDomain('acme.io?x=1')).toBe('acme.io')
    expect(normaliseDomain('acme.io#frag')).toBe('acme.io')
  })
})

describe('isScannableHost — the scanner only visits public marketing sites', () => {
  it('accepts an ordinary public domain', () => {
    for (const h of ['rentman.io', 'greensparksoftware.com', 'a.co.uk', 'x-y.example-site.com']) {
      expect(isScannableHost(h), h).toBe(true)
    }
  })

  it('refuses loopback, link-local and any IP literal', () => {
    // 169.254.169.254 is the cloud metadata endpoint — the classic SSRF target.
    for (const h of ['localhost', '127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1', '[::1]']) {
      expect(isScannableHost(h), h).toBe(false)
    }
  })

  it('refuses reserved and internal-use suffixes', () => {
    for (const h of ['box.local', 'db.internal', 'host.lan', 'app.corp', 'x.home', 'a.test', 'b.invalid']) {
      expect(isScannableHost(h), h).toBe(false)
    }
  })

  it('refuses anything that is not a dotted hostname', () => {
    for (const h of ['', 'nodots', 'has space.com', 'a..com', '-lead.com', 'trail-.com', 'a'.repeat(300)]) {
      expect(isScannableHost(h), JSON.stringify(h)).toBe(false)
    }
  })

  it('lets every real seed domain through', () => {
    for (const h of ['rentman.io', 'eagronom.com', 'amberlo.io', 'solvimon.com', 'rundoo.ai',
      'greensparksoftware.com', 'respark.com', 'breedr.co', 'firstdue.com', 'stitchflow.com',
      'lawwwing.com', 'carbonmaps.io', 'vooma.com', 'usekojo.com', 'toplinepro.com', 'arcol.io']) {
      expect(isScannableHost(h), h).toBe(true)
    }
  })
})

describe('outdated library detection', () => {
  it('flags the laggards the Python engine flags', () => {
    expect(outdatedLibFor('/assets/jquery-3.4.1.min.js')?.version).toBe('3.4.1')
    expect(outdatedLibFor('https://cdn.x.com/lodash@4.17.11/lodash.js')?.version).toBe('4.17.11')
  })

  it('leaves a current library alone', () => {
    expect(outdatedLibFor('/jquery-3.7.1.js')).toBeNull()
    expect(outdatedLibFor('/lodash-4.17.21.js')).toBeNull()
  })

  it('ignores a bundle with no recognisable library version', () => {
    expect(outdatedLibFor('/app.bundle.js')).toBeNull()
  })

  it('compares versions componentwise, not as strings', () => {
    // "10" < "9" as a string; 10 > 9 as a number.
    expect(outdatedLibFor('/angular-10.0.0.js')?.version).toBe('10.0.0')
    expect(outdatedLibFor('/angular-9.0.0.js')?.version).toBe('9.0.0')
    expect(outdatedLibFor('/angular-13.0.0.js')).toBeNull()
  })

  it('pads a two-part version, as the Python tuple padding does', () => {
    expect(outdatedLibFor('/jquery-3.5.js')?.version).toBe('3.5.0')
  })
})

describe('html facts', () => {
  it('accumulates every <title> in the document, as Python does', () => {
    // Inline SVG icons carry their own <title>; the original engine's parser
    // appends them all, so the port must too.
    const facts = extractHtmlFacts('<title>Real Title</title><svg><title>icon</title></svg>')
    expect(facts.title).toBe('Real Titleicon')
  })

  it('treats a password input as a login surface', () => {
    expect(extractHtmlFacts('<input type="password">').hasLogin).toBe(true)
  })

  it('treats a link into the product as a login surface', () => {
    for (const href of ['/login', '/signin', '/sign-in', '/app', '/dashboard']) {
      expect(extractHtmlFacts(`<a href="${href}">in</a>`).hasLogin, href).toBe(true)
    }
    expect(extractHtmlFacts('<a href="/about">about</a>').hasLogin).toBe(false)
  })
})

describe('probePublicPath', () => {
  const found = (path: string, body: string): Record<string, RawResponse> => ({ [path]: { status: 200, body } })

  it('accepts a real security.txt', () => {
    const v = probePublicPath(['/.well-known/security.txt'],
      found('/.well-known/security.txt', 'Contact: mailto:security@example.com\nExpires: 2027-01-01T00:00:00z\n'), 5000)
    expect(v).toEqual({ kind: 'found', path: '/.well-known/security.txt' })
  })

  it('rejects HTML served for a .txt path — an SPA catch-all, not a security.txt', () => {
    const body = `<html><body>${'x'.repeat(200)}</body></html>`
    expect(probePublicPath(['/.well-known/security.txt'], found('/.well-known/security.txt', body), 5000).kind)
      .toBe('absent')
  })

  it('rejects a .txt with no contact, policy or expires field', () => {
    expect(probePublicPath(['/.well-known/security.txt'],
      found('/.well-known/security.txt', 'just some prose that happens to be long enough to pass the length check'), 5000).kind)
      .toBe('absent')
  })

  it('rejects a trust page the same length as the homepage — the SPA shell', () => {
    const body = 'y'.repeat(5000)
    expect(probePublicPath(['/security'], found('/security', body), 5010).kind).toBe('absent')
  })

  it('accepts a trust page that is genuinely different from the homepage', () => {
    expect(probePublicPath(['/security'], found('/security', 'z'.repeat(900)), 5000))
      .toEqual({ kind: 'found', path: '/security' })
  })

  it('rejects a body under 40 characters', () => {
    expect(probePublicPath(['/security'], found('/security', 'tiny'), 5000).kind).toBe('absent')
  })

  it('takes the first candidate that answers', () => {
    const v = probePublicPath(['/security', '/trust'], {
      '/security': { status: 404, body: '' },
      '/trust': { status: 200, body: 'w'.repeat(900) },
    }, 5000)
    expect(v).toEqual({ kind: 'found', path: '/trust' })
  })

  // ---- the one deliberate divergence from the Python engine ----------------
  it('reports INCONCLUSIVE when no candidate answered at all', () => {
    const v = probePublicPath(['/security', '/trust'], {
      '/security': { status: null, body: '', error: 'TimeoutError: request timed out' },
      '/trust': { status: null, body: '', error: 'ECONNRESET: socket hang up' },
    }, 5000)
    expect(v.kind).toBe('inconclusive')
  })

  it('still says ABSENT when at least one candidate answered with a 404', () => {
    // A 404 IS an observation. Only silence is inconclusive.
    const v = probePublicPath(['/security', '/trust'], {
      '/security': { status: null, body: '', error: 'TimeoutError' },
      '/trust': { status: 404, body: 'nope' },
    }, 5000)
    expect(v.kind).toBe('absent')
  })
})

describe('§2.2 — a failure never becomes a finding', () => {
  it('marks trust_page UNOBSERVED when every probe timed out', () => {
    const paths: Record<string, RawResponse> = {}
    for (const p of PUBLIC_PATHS.trust_page) paths[p] = { status: null, body: '', error: 'TimeoutError' }
    for (const p of PUBLIC_PATHS.security_txt) paths[p] = { status: 404, body: 'no' }

    const profile = extractProfile(capture({ paths }))
    // The Python engine reports gap=true here — "no trust page" — which is the
    // exact "a timeout became a finding" case §2.2 forbids. This is the one
    // place the port deliberately disagrees with it.
    expect(profile.observations.trust_page!.observed).toBe(false)
    expect(profile.observations.trust_page!.gap).toBeNull()
    // The signal that DID answer is unaffected.
    expect(profile.observations.security_txt!.observed).toBe(true)
    expect(profile.observations.security_txt!.gap).toBe(true)
  })

  it('marks tls UNOBSERVED when the handshake failed', () => {
    const profile = extractProfile(capture({ tls: { ok: false, error: 'ECONNRESET' } }))
    expect(profile.observations.tls!.observed).toBe(false)
    expect(profile.observations.tls!.gap).toBeNull()
  })

  it('observes nothing at all when the homepage never answered', () => {
    const profile = extractProfile(capture({
      home: { ok: false, status: null, finalUrl: '', headers: {}, body: '', error: 'TimeoutError' },
    }))
    expect(profile.fetchOk).toBe(false)
    expect(Object.keys(profile.observations)).toEqual([])
  })

  it('gives every observed finding the evidence that produced it', () => {
    const profile = extractProfile(capture())
    for (const [key, o] of Object.entries(profile.observations)) {
      if (!o.observed) continue
      expect(o.evidence, `${key} must carry evidence`).toBeDefined()
      expect(Object.keys(o.evidence!).length, `${key} evidence must not be empty`).toBeGreaterThan(0)
    }
  })
})

describe('header interpretation', () => {
  it('accepts frame-ancestors in the CSP as frame protection', () => {
    const profile = extractProfile(capture({
      home: { ...capture().home, headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" } },
    }))
    expect(profile.observations.frame_protection!.gap).toBe(false)
  })

  it('treats a bare CDN name as no disclosure, but a version as one', () => {
    const bare = extractProfile(capture({ home: { ...capture().home, headers: { server: 'cloudflare' } } }))
    expect(bare.observations.server_banner!.gap).toBe(false)

    const versioned = extractProfile(capture({ home: { ...capture().home, headers: { server: 'nginx/1.18.0' } } }))
    expect(versioned.observations.server_banner!.gap).toBe(true)

    const powered = extractProfile(capture({ home: { ...capture().home, headers: { 'x-powered-by': 'Express' } } }))
    expect(powered.observations.server_banner!.gap).toBe(true)
  })

  it('does not accept GDPR or HIPAA alone as a compliance claim', () => {
    const soft = extractProfile(capture({
      home: { ...capture().home, body: '<html>we are GDPR compliant and HIPAA ready<input type="password"></html>' },
    }))
    expect(soft.observations.compliance_claim!.gap).toBe(true)

    const hard = extractProfile(capture({
      home: { ...capture().home, body: '<html>SOC 2 Type II certified<input type="password"></html>' },
    }))
    expect(hard.observations.compliance_claim!.gap).toBe(false)
  })

  it('needs two vendor terms before calling a company a security vendor', () => {
    const one = extractProfile(capture({ home: { ...capture().home, body: '<html>we do pentest work</html>' } }))
    expect(one.isSecurityVendor).toBe(false)
    const two = extractProfile(capture({ home: { ...capture().home, body: '<html>pentest and siem</html>' } }))
    expect(two.isSecurityVendor).toBe(true)
  })
})
