/**
 * Turn one raw capture into the observations the scorer consumes.
 *
 * A port of the interpreting half of `profile_site()` in `src/signals.py`.
 * Pure: give it the same bytes and it gives the same answer, which is what
 * lets packages/scanner/test/parity.test.ts compare it against the Python
 * original for all sixteen seed domains.
 *
 * TWO DELIBERATE DIVERGENCES from the Python engine, both documented where
 * they happen — at `probePublicPath` and at `compliance_claim` — and both
 * asserted explicitly rather than hidden. In each, §2.2 outranks port
 * fidelity: a question the scan did not actually answer must not come out as a
 * gap.
 */
import type { Observation, OutdatedLib, SiteProfile } from '@agency/core'
import { additiveObservations } from './additive.js'
import { extractHtmlFacts } from './html.js'
import {
  COMPLIANCE_TERMS, OUTDATED_JS, SECURITY_TEAM_TERMS, SECURITY_VENDOR_TERMS,
  SOFT_COMPLIANCE_TERMS, TLS_EXPIRY_WARN_DAYS, VERSION_IN_URL, WEAK_TLS_PROTOCOLS,
} from './terms.js'
import { pyHead, pyLen, pyStrip } from './pystr.js'
import { PUBLIC_PATHS, type RawCapture, type RawResponse } from './types.js'

/**
 * Detail strings are capped at 160 characters, as the Python `obs()` does —
 * 160 CODE POINTS, which is what `detail[:160]` means. Truncating UTF-16 units
 * instead cuts a page with an emoji in a different place, and can leave half a
 * surrogate pair in a string that goes on to be stored as evidence.
 */
const DETAIL_MAX = 160

function observation(
  observed: boolean,
  gap: boolean | null,
  detail: string,
  evidence: Record<string, unknown>,
): Observation {
  return { observed, gap: observed ? Boolean(gap) : null, detail: pyHead(detail, DETAIL_MAX), evidence }
}

/**
 * Reduce whatever was typed or imported to a bare hostname.
 *
 * Python's `_norm` strips the scheme, the path and a leading `www.` and stops
 * there, which leaves userinfo and a port attached: `_norm("a.com@internal")`
 * is `"a.com@internal"`, and `https://a.com@internal/` requests *internal*.
 * This also strips userinfo, port, query and fragment. That is stricter than
 * the original, deliberately — it changes only which host is REQUESTED, never
 * how a response is interpreted, so it cannot affect parity.
 */
export function normaliseDomain(input: string): string {
  let d = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  d = d.split('/')[0] ?? ''
  d = d.split('?')[0] ?? ''
  d = d.split('#')[0] ?? ''
  // Everything before the last '@' is userinfo, and the host is what follows.
  const at = d.lastIndexOf('@')
  if (at !== -1) d = d.slice(at + 1)
  // Strip a port, but leave a bracketed IPv6 literal intact for the check below.
  if (!d.startsWith('[')) d = d.split(':')[0] ?? ''
  return d.startsWith('www.') ? d.slice(4) : d
}

/** A public DNS name: labels of letters, digits and hyphens, at least one dot. */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/**
 * Suffixes that never name a company's public marketing site: the RFC 2606 and
 * RFC 6761 reserved names, plus the strings ICANN identified as high-risk
 * internal-use TLDs and never delegated (.corp, .home, .mail).
 */
const NON_PUBLIC_SUFFIXES = [
  '.local', '.localhost', '.internal', '.intranet', '.private', '.localdomain',
  '.lan', '.corp', '.home', '.test', '.example', '.invalid',
]

/**
 * Is this a host the scanner is willing to request?
 *
 * The scanner exists to look at companies' public marketing sites. Anything
 * that is not a public DNS name — an IP literal, localhost, a private suffix —
 * is refused, so a bad row in `companies.domain` cannot turn the scanner into
 * a request forwarder aimed at the machine it runs on or at cloud metadata.
 *
 * It judges the NAME. What the name resolves to is judged when the scanner
 * connects (`publicOnlyLookup` in `address.ts`, 2026-10-08), because a public
 * name can point at a private address and only resolution can tell.
 *
 * A name whose LAST label is a number is an IPv4 address to the URL parser —
 * `127.1`, `10.1`, `0x7f.1` and `169.254.43518` become 127.0.0.1, 10.0.0.1,
 * 127.0.0.1 and 169.254.169.254 — whatever it looks like (the WHATWG URL
 * standard's "ends in a number"). No top-level domain is a number, so such a
 * name is never a company's site. The dotted-quad test alone let them all
 * through (found by review, 2026-10-08).
 */
export function endsInANumber(host: string): boolean {
  const labels = host.split('.')
  if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop()
  const last = labels[labels.length - 1] ?? ''
  return /^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last)
}

export function isScannableHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (host.startsWith('[')) return false                 // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false  // IPv4 literal
  if (endsInANumber(host)) return false                   // an IPv4 address in another spelling
  if (host === 'localhost') return false
  if (NON_PUBLIC_SUFFIXES.some((s) => host.endsWith(s))) return false
  return HOSTNAME.test(host)
}

type PathVerdict =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'absent' }
  /** Every candidate failed to answer, so nothing can be concluded. */
  | { readonly kind: 'inconclusive'; readonly reason: string }

/**
 * Walk the candidate paths for one signal and decide whether the page exists.
 *
 * The accept/reject rules are the Python original's, including both catch-all
 * guards: a `.txt` path that answers with HTML, and an HTML page whose length
 * is within 40 characters of the homepage (an SPA serving its shell for every
 * route).
 *
 * THE DIVERGENCE. Python does `except Exception: continue`, so a request that
 * never completed — timeout, DNS failure, connection reset, WAF block — is
 * indistinguishable from a clean 404, and both end as "no trust page". That is
 * exactly the case §2.2 forbids: "A fetch failure, timeout, WAF block, or CDN
 * quirk produces observed: false, which scores zero and is never rendered as a
 * gap." A 404 IS an observation and still counts as absent; a request that got
 * no answer at all is not, and returns `inconclusive` instead.
 */
export function probePublicPath(
  candidates: readonly string[],
  responses: Readonly<Record<string, RawResponse>>,
  homeLength: number,
): PathVerdict {
  let sawAnyAnswer = false
  const failures: string[] = []

  for (const path of candidates) {
    const res = responses[path]
    if (!res || res.error !== undefined || res.status === null) {
      failures.push(`${path}: ${res?.error ?? 'not probed'}`)
      continue
    }
    sawAnyAnswer = true

    if (res.status !== 200) continue
    // Every length below is Python's: code points, and Python's whitespace set.
    const body = pyStrip(res.body)
    const bodyLength = pyLen(body)
    if (bodyLength < 40) continue

    if (path.endsWith('.txt')) {
      // A catch-all serving HTML for a .txt path is not a security.txt.
      if (pyHead(body, 400).toLowerCase().includes('<html')) continue
      if (!/(contact|policy|expires)\s*:/i.test(body)) continue
      return { kind: 'found', path }
    }

    // An HTML page the same size as the homepage is the SPA shell, not a page.
    if (homeLength && Math.abs(bodyLength - homeLength) < 40) continue
    return { kind: 'found', path }
  }

  return sawAnyAnswer ? { kind: 'absent' } : { kind: 'inconclusive', reason: failures.join('; ') }
}

/** Parse the version out of a script src and decide whether it is a laggard. */
export function outdatedLibFor(src: string): OutdatedLib | null {
  const m = VERSION_IN_URL.exec(src)
  if (!m) return null
  const lib = m[1]!.toLowerCase()
  const entry = OUTDATED_JS[lib]
  if (!entry) return null

  const parts = [m[2], m[3], m[4]].filter((p) => p !== undefined).map((p) => Number.parseInt(p!, 10))
  while (parts.length < 3) parts.push(0)
  const version: [number, number, number] = [parts[0]!, parts[1]!, parts[2]!]

  // Tuple comparison, same as Python's `ver < floor`.
  const isBelow =
    version[0] !== entry.floor[0] ? version[0] < entry.floor[0]
      : version[1] !== entry.floor[1] ? version[1] < entry.floor[1]
        : version[2] < entry.floor[2]

  if (!isBelow) return null
  return { lib, version: version.join('.'), note: entry.note, src: pyHead(src, 150) }
}

/**
 * Interpret a raw capture. The result feeds `scoreCompany` unchanged.
 */
export function extractProfile(raw: RawCapture, company?: string): SiteProfile {
  const observations: Record<string, Observation> = {}

  if (!raw.home.ok) {
    // Nothing was fetched, so nothing is observed. The scorer disqualifies on
    // this before touching a single signal.
    return {
      domain: raw.domain,
      company: company ?? '',
      title: '',
      fetchOk: false,
      fetchError: raw.home.error ?? (raw.home.status ? `HTTP ${raw.home.status}` : 'no response'),
      hasLoginSurface: false,
      isSecurityVendor: false,
      mentionsSecurityHiring: false,
      outdatedLibs: [],
      observations,
    }
  }

  const html = raw.home.body
  const low = html.toLowerCase()
  const homeLength = pyLen(pyStrip(html))
  const truncated = raw.home.truncated === true
  const headers = raw.home.headers
  const facts = extractHtmlFacts(html)
  const url = raw.home.finalUrl || `https://${raw.domain}/`

  // --- security response headers -------------------------------------------
  // The response arrived, so every header question is genuinely answered.
  const csp = headers['content-security-policy'] ?? ''
  // Python truncates this one to 140 at the call site, before obs() applies
  // its own 160 cap — so a long policy shows 140 characters, not 160. The
  // full value is kept in `evidence`, which is what a finding is judged on.
  observations.csp = observation(true, !csp, pyHead(csp, 140), {
    url, header: 'content-security-policy', seen: csp || 'absent',
  })

  const hsts = headers['strict-transport-security']
  observations.hsts = observation(true, hsts === undefined, hsts ?? '', {
    url, header: 'strict-transport-security', seen: hsts ?? 'absent',
  })

  const xfo = headers['x-frame-options']
  const frameOk = xfo !== undefined || csp.includes('frame-ancestors')
  observations.frame_protection = observation(true, !frameOk, xfo ?? '', {
    url,
    header: 'x-frame-options',
    seen: xfo ?? 'absent',
    cspFrameAncestors: csp.includes('frame-ancestors'),
  })

  const xcto = headers['x-content-type-options']
  observations.content_type_options = observation(true, xcto === undefined, xcto ?? '', {
    url, header: 'x-content-type-options', seen: xcto ?? 'absent',
  })

  const referrer = headers['referrer-policy']
  observations.referrer_policy = observation(true, referrer === undefined, referrer ?? '', {
    url, header: 'referrer-policy', seen: referrer ?? 'absent',
  })

  const permissions = headers['permissions-policy']
  observations.permissions_policy = observation(true, permissions === undefined, permissions ?? '', {
    url, header: 'permissions-policy', seen: permissions ?? 'absent',
  })

  // --- server banner --------------------------------------------------------
  // A bare CDN name is not a disclosure; a version number is.
  const banner = pyStrip([headers.server, headers['x-powered-by']].filter(Boolean).join(' '))
  const leaky = /\d+\.\d+/.test(banner) || Boolean(headers['x-powered-by'])
  observations.server_banner = observation(true, leaky, banner, {
    url, server: headers.server ?? 'absent', xPoweredBy: headers['x-powered-by'] ?? 'absent',
  })

  // --- conventional public paths -------------------------------------------
  const securityTxt = probePublicPath(PUBLIC_PATHS.security_txt, raw.paths, homeLength)
  observations.security_txt =
    securityTxt.kind === 'inconclusive'
      ? observation(false, null, securityTxt.reason, { probed: PUBLIC_PATHS.security_txt, outcome: 'no response' })
      : observation(true, securityTxt.kind === 'absent', securityTxt.kind === 'found' ? securityTxt.path : '', {
          probed: PUBLIC_PATHS.security_txt,
          found: securityTxt.kind === 'found' ? securityTxt.path : null,
        })

  const trustPage = probePublicPath(PUBLIC_PATHS.trust_page, raw.paths, homeLength)
  observations.trust_page =
    trustPage.kind === 'inconclusive'
      ? observation(false, null, trustPage.reason, { probed: PUBLIC_PATHS.trust_page, outcome: 'no response' })
      : observation(true, trustPage.kind === 'absent', trustPage.kind === 'found' ? trustPage.path : '', {
          probed: PUBLIC_PATHS.trust_page,
          found: trustPage.kind === 'found' ? trustPage.path : null,
        })

  // --- compliance posture stated publicly ----------------------------------
  // THE SECOND DIVERGENCE. A body that hit the read cap is a PREFIX of the
  // page, and "the term is not in the prefix" is not "the company does not say
  // it". Python cannot tell the difference and reports the gap; §2.2 says a
  // finding nobody observed must not be stated, so a negative result off a
  // truncated body is unobserved. A POSITIVE result still stands — a term
  // found in the half that was read was genuinely read.
  const claims = COMPLIANCE_TERMS.filter((t) => low.includes(t))
  const hard = claims.filter((c) => !SOFT_COMPLIANCE_TERMS.includes(c))
  observations.compliance_claim =
    truncated && hard.length === 0
      ? observation(false, null, 'homepage exceeded the read cap', {
          url, outcome: 'body truncated', termsFound: claims,
        })
      : observation(true, hard.length === 0, claims.join(', '), {
          url, termsFound: claims, qualifyingTerms: hard,
        })

  // --- outdated JS served in production ------------------------------------
  const outdatedLibs = facts.scripts
    .map(outdatedLibFor)
    .filter((l): l is OutdatedLib => l !== null)
  observations.outdated_js =
    truncated && outdatedLibs.length === 0
      ? observation(false, null, 'homepage exceeded the read cap', {
          url, outcome: 'body truncated', scriptsRead: facts.scripts.length,
        })
      : observation(
          true,
          outdatedLibs.length > 0,
          outdatedLibs.map((l) => `${l.lib} ${l.version}`).join('; '),
          { url, libraries: outdatedLibs.map((l) => ({ lib: l.lib, version: l.version, src: l.src })) },
        )

  // --- TLS ------------------------------------------------------------------
  if (raw.tls.ok) {
    const protocol = raw.tls.protocol ?? ''
    const days = raw.tls.daysToExpiry ?? 999
    const weak = WEAK_TLS_PROTOCOLS.includes(protocol) || days < TLS_EXPIRY_WARN_DAYS
    observations.tls = observation(true, weak, `${protocol}, ${days}d to expiry`, {
      host: raw.domain, protocol, issuer: raw.tls.issuer ?? '', expires: raw.tls.expires ?? '', daysToExpiry: days,
    })
  } else {
    // The handshake failed, so the certificate was never seen. Claims nothing.
    observations.tls = observation(false, null, raw.tls.error ?? '', {
      host: raw.domain, outcome: 'handshake failed',
    })
  }

  // --- informational: observed, recorded, never scored (additive.ts) ---------
  Object.assign(observations, additiveObservations(raw, facts))

  return {
    domain: raw.domain,
    company: company ?? '',
    title: pyHead(facts.title, DETAIL_MAX),
    fetchOk: true,
    fetchError: '',
    hasLoginSurface: facts.hasLogin,
    isSecurityVendor: SECURITY_VENDOR_TERMS.filter((t) => low.includes(t)).length >= 2,
    mentionsSecurityHiring: SECURITY_TEAM_TERMS.some((t) => low.includes(t)),
    outdatedLibs,
    observations,
  }
}
