/**
 * Thirteen INFORMATIONAL security signals, read from bytes the scanner
 * already captures — the homepage's response headers, its markup and its
 * cookies — and, since 2026-10-08, the twelve website-presence signals of
 * presence.ts beside them, in the one list below (25 in all).
 *
 * Not a port. The reference engine has none of these, and nothing here feeds
 * the score: `scoreCompany` walks the ICP, none of these keys is in it, and
 * `parseIcpDefinition` refuses `weight: 0`, so the only way one ever counts is
 * to be promoted into the ICP with a real weight. `recordScan` writes them
 * with `scored = false`, which the schema pins to `weight = 0`, and
 * `quotableFindings`, the proposal and the brief all leave them out. They are
 * context on the company page and in `get_company`, and nothing else.
 *
 * §2.2 still governs every one of them, because a finding that is not scored
 * is still a statement about somebody's site:
 *   * "not applicable" is `observed: true, gap: false` with a detail that
 *     begins "not applicable —" — never a claim either way;
 *   * a negative read off a truncated body is unobserved, exactly as
 *     `outdated_js` and `compliance_claim` handle it in extract.ts;
 *   * `cookie_flags` on a capture with no cookie record is unobserved ("not
 *     captured"), never "sets no cookies";
 *   * every observation, unobserved ones included, carries a non-empty
 *     evidence object, and every unobserved one carries `gap: null`, which is
 *     what `findings_unobserved_has_no_gap` insists on.
 *
 * No new request class (rule 8): everything below reads `raw.home`. Pure.
 */
import type { Observation } from '@agency/core'
import type { HtmlFacts } from './html.js'
import { PRESENCE_SIGNAL_KEYS, presenceObservations } from './presence.js'
import { pyHead } from './pystr.js'
import type { RawCapture } from './types.js'

export const ADDITIVE_SIGNAL_KEYS = Object.freeze([
  'csp_report_only', 'csp_quality', 'cookie_flags', 'referrer_policy_quality', 'permissions_policy_quality',
  'content_type_options_quality', 'cross_origin_policies', 'sri_third_party', 'mixed_content',
  'stack_disclosure', 'deprecated_headers', 'hsts_quality', 'reporting_endpoints',
  ...PRESENCE_SIGNAL_KEYS,
] as const)

export type AdditiveKey = (typeof ADDITIVE_SIGNAL_KEYS)[number]

/** extract.ts's cap and shape, so an informational detail reads like any other. */
const DETAIL_MAX = 160

function observation(
  observed: boolean,
  gap: boolean | null,
  detail: string,
  evidence: Record<string, unknown>,
): Observation {
  return { observed, gap: observed ? Boolean(gap) : null, detail: pyHead(detail, DETAIL_MAX), evidence }
}

/** The "not applicable" convention: observed, no gap, and says why. */
function notApplicable(why: string, evidence: Record<string, unknown>): Observation {
  return observation(true, false, `not applicable — ${why}`, evidence)
}

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------

type Directives = ReadonlyMap<string, readonly string[]>

/**
 * One policy's directives. The FIRST occurrence of a directive wins and later
 * ones are ignored, which is what CSP3 §2.2.1 tells a browser to do.
 */
function parsePolicy(policy: string): Directives {
  const out = new Map<string, readonly string[]>()
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    const name = tokens[0]?.toLowerCase()
    if (name && !out.has(name)) out.set(name, tokens.slice(1))
  }
  return out
}

/** What is wrong with one policy's script sources; empty when nothing is. */
function scriptProblems(d: Directives): string[] {
  const sources = d.get('script-src') ?? d.get('default-src')
  // No script-src and no default-src restricts nothing: every source, inline
  // and eval included, is allowed. That is `*` spelled by omission.
  if (sources === undefined) return ['no script-src or default-src, so scripts are unrestricted']

  const lower = sources.map((s) => s.toLowerCase())
  const nonceOrHash = lower.some((s) => /^'(nonce|sha256|sha384|sha512)-/.test(s))
  const strictDynamic = lower.includes("'strict-dynamic'")
  const problems: string[] = []
  // A nonce or a hash makes a CSP2+ browser ignore 'unsafe-inline'.
  if (lower.includes("'unsafe-inline'") && !nonceOrHash) problems.push("'unsafe-inline' without a nonce or hash")
  if (lower.includes("'unsafe-eval'")) problems.push("'unsafe-eval'")
  // 'strict-dynamic' with a nonce or hash makes a browser ignore host and
  // scheme sources, so a `*` beside it allows nothing.
  if (!(strictDynamic && nonceOrHash)) {
    for (const wide of ['*', 'http:']) if (lower.includes(wide)) problems.push(`${wide} as a script source`)
  }
  return problems
}

/**
 * Read when the capture recorded more than one non-blank enforced policy.
 * Each is enforced, so the effective script policy is their INTERSECTION —
 * and judging an intersection is not what this check does. Reading the first
 * alone gave "scripts are unrestricted" to a site whose script-src sat in its
 * second header, so it says it did not judge rather than guess (§2.2).
 */
export const SEVERAL_CSP_HEADERS =
  'several Content-Security-Policy headers were sent; this check reads one policy at a time'

function cspObservations(raw: RawCapture, url: string): Pick<Record<AdditiveKey, Observation>, 'csp_report_only' | 'csp_quality'> {
  const headers = raw.home.headers
  const enforced = headers['content-security-policy']
  const reportOnly = headers['content-security-policy-report-only']
  // Every enforced value when the capture recorded them (`cspHeaders`), else
  // the first-value map's one — which is all a recorded fixture holds.
  const enforcedValues = (raw.home.cspHeaders ?? (enforced !== undefined ? [enforced] : []))
    .filter((v) => v.trim() !== '')
  const enforcedPresent = enforcedValues.length > 0

  const csp_report_only =
    reportOnly === undefined
      ? notApplicable('no report-only policy is sent', {
          url, header: 'content-security-policy-report-only', seen: 'absent', enforcedPresent,
        })
      : observation(
          true,
          !enforcedPresent,
          enforcedPresent
            ? 'report-only policy sent alongside an enforced one'
            : 'report-only policy with no enforced policy: violations are reported, nothing is blocked',
          { url, header: 'content-security-policy-report-only', seen: reportOnly, enforcedPresent },
        )

  if (!enforcedPresent) {
    return {
      csp_report_only,
      csp_quality: notApplicable('no enforced Content-Security-Policy to judge', {
        url, header: 'content-security-policy', seen: 'absent',
      }),
    }
  }
  if (enforcedValues.length > 1) {
    return {
      csp_report_only,
      csp_quality: observation(false, null, SEVERAL_CSP_HEADERS, {
        url, header: 'content-security-policy', headers: enforcedValues.length, seen: enforcedValues,
      }),
    }
  }
  const policy = enforcedValues[0]!

  // A value can hold several policies separated by commas, and a browser
  // enforces every one. A script must satisfy all of them, so one policy
  // with a clean script source bounds the rest — the weaker policies are
  // only a gap when no policy is clean.
  const policies = policy.split(',').map(parsePolicy).filter((p) => p.size > 0)
  // A value that is only separators is a policy with no directives at all.
  const judged = (policies.length > 0 ? policies : [new Map<string, readonly string[]>()])
    .map((p) => ({ p, problems: scriptProblems(p) }))
  const clean = judged.find((j) => j.problems.length === 0)
  const shown = clean ?? judged[0]
  const problems = clean ? [] : [...new Set(judged.flatMap((j) => j.problems))]
  const directive = (name: string): string | null => shown?.p.get(name)?.join(' ') ?? null

  return {
    csp_report_only,
    csp_quality: observation(
      true,
      problems.length > 0,
      problems.length > 0 ? problems.join('; ') : 'script sources carry no unsafe-inline, unsafe-eval or wildcard',
      {
        url,
        directives: {
          scriptSrc: directive('script-src') ?? directive('default-src'),
          frameAncestors: directive('frame-ancestors'),
          baseUri: directive('base-uri'),
          objectSrc: directive('object-src'),
        },
        problems,
      },
    ),
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Cookies a CDN or an analytics vendor sets on the site's behalf. They are the
 * vendor's, labelled as such, and never make the site's cookie_flags a gap:
 * the site did not choose their flags and usually cannot change them.
 */
const VENDOR_COOKIE = /^(__cf_bm|_cfuvid|cf_clearance|__cfruid|_ga|_ga_.+|_gid|AWSALB.*)$/

/** Observatory's heuristic for a cookie that carries a session. */
const SESSION_COOKIE = /sess|login|auth|token/i

export interface CookieFacts {
  readonly name: string
  readonly secure: boolean
  readonly httpOnly: boolean
  /** Lower-cased; null when the attribute is absent. */
  readonly sameSite: string | null
  readonly isCdn: boolean
}

/** Read one Set-Cookie line. Attribute names are case-insensitive. */
export function parseSetCookie(line: string): CookieFacts {
  const [pair = '', ...attrs] = line.split(';')
  const eq = pair.indexOf('=')
  const name = (eq === -1 ? '' : pair.slice(0, eq)).trim()
  let secure = false
  let httpOnly = false
  let sameSite: string | null = null
  for (const attr of attrs) {
    const [k = '', ...v] = attr.split('=')
    const key = k.trim().toLowerCase()
    if (key === 'secure') secure = true
    else if (key === 'httponly') httpOnly = true
    else if (key === 'samesite') sameSite = v.join('=').trim().toLowerCase() || null
  }
  return { name, secure, httpOnly, sameSite, isCdn: VENDOR_COOKIE.test(name) }
}

function cookieFlags(raw: RawCapture, url: string): Observation {
  const lines = raw.home.setCookies
  if (lines === undefined) {
    // The recording holds only the first Set-Cookie (in `headers`), so the
    // question cannot be answered from it. Not "no cookies".
    return observation(false, null, 'not captured', {
      url, reason: 'this capture did not record every Set-Cookie header',
    })
  }
  const cookies = lines.map(parseSetCookie)
  if (cookies.length === 0) return notApplicable('no cookies set on the homepage', { url, cookies: [] })

  const problems: string[] = []
  for (const c of cookies) {
    if (c.isCdn) continue
    const missing: string[] = []
    if (SESSION_COOKIE.test(c.name)) {
      if (!c.secure) missing.push('Secure')
      if (!c.httpOnly) missing.push('HttpOnly')
    }
    if (c.sameSite === 'none' && !c.secure && !missing.includes('Secure')) missing.push('Secure (SameSite=None)')
    if (missing.length) problems.push(`${c.name || '(unnamed)'} lacks ${missing.join(' and ')}`)
  }
  const vendor = cookies.filter((c) => c.isCdn).length
  return observation(
    true,
    problems.length > 0,
    problems.length > 0
      ? problems.join('; ')
      : `${cookies.length} cookie${cookies.length === 1 ? '' : 's'} set, none flagged` +
          (vendor > 0 ? ` (${vendor} set by a CDN or analytics vendor)` : ''),
    { url, cookies },
  )
}

// ---------------------------------------------------------------------------
// The quality of headers the scored signals only check for presence
// ---------------------------------------------------------------------------

const WEAK_REFERRER = new Set(['unsafe-url', 'origin', 'origin-when-cross-origin', 'no-referrer-when-downgrade'])
const STRICT_REFERRER = new Set(['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'])

function referrerQuality(raw: RawCapture, url: string): Observation {
  const seen = raw.home.headers['referrer-policy']
  if (seen === undefined) {
    return notApplicable('no Referrer-Policy header', { url, seen: 'absent', class: 'absent' })
  }
  // A comma-separated list is a fallback chain: the browser uses the LAST
  // token it recognises.
  const tokens = seen.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  const effective = [...tokens].reverse().find((t) => WEAK_REFERRER.has(t) || STRICT_REFERRER.has(t))
  if (effective === undefined) {
    return observation(true, false, 'unrecognised value: browsers ignore it and apply their own default', {
      url, seen, class: 'unrecognised',
    })
  }
  const weak = WEAK_REFERRER.has(effective)
  const detail =
    effective === 'no-referrer-when-downgrade'
      ? 'no-referrer-when-downgrade: browser default, not restrictive'
      : weak
        ? `${effective}: sends the origin or full URL to other sites`
        : effective
  return observation(true, weak, detail, { url, seen, class: weak ? 'weak' : 'strict' })
}

/** The powerful features a Permissions-Policy is worth having for. */
const POWERFUL_FEATURES = ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'browsing-topics'] as const

function permissionsQuality(raw: RawCapture, url: string): Observation {
  const seen = raw.home.headers['permissions-policy']
  const featurePolicy = raw.home.headers['feature-policy']
  if (seen === undefined && featurePolicy === undefined) {
    return notApplicable('no Permissions-Policy header', { url, seen: 'absent', restricts: [] })
  }
  // A structured-field dictionary: `camera=(), geolocation=(self), usb=*`.
  // A member that is not `*` narrows the feature to something less than
  // everyone; a member that does not parse restricts nothing.
  const members = new Map<string, string>()
  for (const part of (seen ?? '').split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    members.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim())
  }
  const restricts = POWERFUL_FEATURES.filter((f) => members.has(f) && members.get(f) !== '*')
  const problems: string[] = []
  if (featurePolicy !== undefined) problems.push('the deprecated Feature-Policy spelling is sent')
  if (seen !== undefined && restricts.length === 0) {
    problems.push(`restricts none of ${POWERFUL_FEATURES.join(', ')}`)
  }
  return observation(
    true,
    problems.length > 0,
    problems.length > 0 ? problems.join('; ') : `restricts ${restricts.join(', ')}`,
    { url, seen: seen ?? 'absent', restricts, ...(featurePolicy !== undefined ? { featurePolicy } : {}) },
  )
}

function contentTypeQuality(raw: RawCapture, url: string): Observation {
  const seen = raw.home.headers['x-content-type-options']
  if (seen === undefined) return notApplicable('no X-Content-Type-Options header', { url, seen: 'absent' })
  const ok = seen.trim().toLowerCase() === 'nosniff'
  return observation(true, !ok, ok ? 'nosniff' : `"${seen}" is not nosniff, so browsers ignore it`, { url, seen })
}

function crossOriginPolicies(raw: RawCapture, url: string): Observation {
  const h = raw.home.headers
  const coop = h['cross-origin-opener-policy']
  const coep = h['cross-origin-embedder-policy']
  const corp = h['cross-origin-resource-policy']
  const evidence = { url, coop: coop ?? 'absent', coep: coep ?? 'absent', corp: corp ?? 'absent' }
  const present = [
    coop !== undefined ? `COOP ${coop}` : null,
    coep !== undefined ? `COEP ${coep}` : null,
    corp !== undefined ? `CORP ${corp}` : null,
  ].filter((p): p is string => p !== null)
  if (present.length === 0) return observation(true, true, 'none of COOP, COEP or CORP is sent', evidence)
  const unsafeCoop = coop !== undefined && coop.trim().toLowerCase() === 'unsafe-none'
  return observation(
    true,
    unsafeCoop,
    unsafeCoop ? `COOP is unsafe-none, which opts out of isolation; ${present.join(', ')}` : present.join(', '),
    evidence,
  )
}

// ---------------------------------------------------------------------------
// Markup: third-party scripts and mixed content
// ---------------------------------------------------------------------------

/**
 * Script hosts whose content changes without notice by design — tag managers
 * and vendor loaders that document they must not be pinned. SRI cannot be
 * applied to them, so they are counted in the ratio and never flagged.
 */
const DYNAMIC_SCRIPT_HOSTS = [
  'googletagmanager.com', 'google-analytics.com', 'js.stripe.com', 'cdn.segment.com',
  'static.hotjar.com', 'hs-scripts.com',
] as const

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

function resolve(ref: string, base: string): URL | null {
  try {
    return new URL(ref.trim(), base)
  } catch {
    return null
  }
}

/** The page's own names: the domain scanned, and where the homepage landed. */
function siteHosts(raw: RawCapture, url: string): string[] {
  const landed = resolve(url, `https://${raw.domain}/`)?.hostname.replace(/^www\./, '')
  return [...new Set([raw.domain, ...(landed ? [landed] : [])])]
}

function sriThirdParty(raw: RawCapture, facts: HtmlFacts, url: string): Observation {
  const own = siteHosts(raw, url)
  const external = facts.scriptTags
    .filter((s) => !s.inNoscript)
    .map((s) => ({ s, u: resolve(s.src, url) }))
    .filter((x) => x.u !== null && x.u.protocol === 'https:' && !own.some((o) => hostMatches(x.u!.hostname, o)))
  const withIntegrity = external.filter((x) => x.s.integrity !== null).length
  const lacking = external.filter((x) => x.s.integrity === null)
  const dynamic = lacking.filter((x) => DYNAMIC_SCRIPT_HOSTS.some((d) => hostMatches(x.u!.hostname, d)))
  const flagged = lacking.filter((x) => !dynamic.includes(x))
  const hosts = [...new Set(flagged.map((x) => x.u!.hostname))]
  const evidence = {
    url,
    external: external.length,
    withIntegrity,
    hosts,
    tagManagerHosts: [...new Set(dynamic.map((x) => x.u!.hostname))],
  }

  // §2.2: "no third-party script lacks integrity" read off a prefix of the
  // page is not an observation — the rest of the page was never read.
  if (raw.home.truncated === true && flagged.length === 0) {
    return observation(false, null, 'homepage exceeded the read cap', { ...evidence, outcome: 'body truncated' })
  }
  if (external.length === 0) return notApplicable('no third-party scripts on the homepage', evidence)
  // A ratio, with the hosts in the evidence rather than the detail, where a
  // list of eight CDNs would be cut off mid-name at 160 characters.
  const ratio = `integrity= on ${withIntegrity} of ${external.length} third-party script${external.length === 1 ? '' : 's'}`
  const without =
    hosts.length === 0 ? '' : `; without it: ${hosts[0]}${hosts.length > 1 ? ` and ${hosts.length - 1} more host${hosts.length > 2 ? 's' : ''}` : ''}`
  const managers = dynamic.length > 0 ? `; ${dynamic.length} from tag managers, which cannot use SRI and are not flagged` : ''
  return observation(true, flagged.length > 0, `${ratio}${without}${managers}`, evidence)
}

/** `<link rel>` values that make the browser fetch and APPLY what they name. */
const ACTIVE_LINK_RELS = ['stylesheet', 'preload', 'modulepreload']

function mixedContent(raw: RawCapture, facts: HtmlFacts, url: string): Observation {
  if (!url.toLowerCase().startsWith('https://')) {
    return notApplicable('the homepage itself was served over http', { url, blockable: [], upgradable: [] })
  }
  const isHttp = (ref: string): boolean => ref.trim().toLowerCase().startsWith('http://')
  const blockable: string[] = []
  const upgradable: string[] = []
  for (const s of facts.scriptTags) if (!s.inNoscript && isHttp(s.src)) blockable.push(s.src)
  for (const r of facts.resourceRefs) {
    if (r.inNoscript || !isHttp(r.url)) continue
    if (r.tag === 'iframe') blockable.push(r.url)
    else if (r.tag === 'link') {
      const rels = (r.rel ?? '').split(/\s+/)
      // A canonical or alternate link with http:// is a pointer, not a load.
      if (rels.some((x) => ACTIVE_LINK_RELS.includes(x))) blockable.push(r.url)
      else if (rels.some((x) => x.includes('icon'))) upgradable.push(r.url)
    } else upgradable.push(r.url)
  }
  const evidence = { url, blockable, upgradable }

  if (raw.home.truncated === true && blockable.length === 0) {
    return observation(false, null, 'homepage exceeded the read cap', { ...evidence, outcome: 'body truncated' })
  }
  if (blockable.length > 0) {
    return observation(true, true, `${blockable.length} script, stylesheet or frame loaded over http: ${blockable[0]}`, evidence)
  }
  return observation(
    true,
    false,
    upgradable.length > 0
      ? `${upgradable.length} image or media reference over http, which browsers upgrade; nothing blockable`
      : 'no http:// scripts, stylesheets or frames',
    evidence,
  )
}

// ---------------------------------------------------------------------------
// What the server says about itself
// ---------------------------------------------------------------------------

const STACK_HEADERS = ['x-aspnet-version', 'x-aspnetmvc-version', 'x-generator', 'x-backend-server'] as const
/** A version, or a build hash — `Framer/bea9510`. A bare `cloudflare` is neither. */
const VERSIONED_SERVER = /\/[0-9a-f]{6,}$|\d+\.\d+/i

/**
 * Whether a `Via` header names a version or a build. Each hop is
 * `[protocol/]version received-by [(comment)]` (RFC 9110 §7.6.3), and the
 * leading `1.1` is the HTTP version every intermediary is REQUIRED to add —
 * not a software version. So the protocol token is dropped and the rest of
 * each hop is judged the way `Server` is: `1.1 varnish (Varnish/6.0)` names
 * one, while `1.1 google`, `1.1 varnish` and `1.1 vegur` name a CDN hop, which
 * is no more a disclosure than a bare `Server: cloudflare`.
 */
export function viaDisclosesVersion(via: string): boolean {
  return via.split(',').some((hop) => VERSIONED_SERVER.test(hop.trim().replace(/^\S+\s*/, '')))
}

function stackDisclosure(raw: RawCapture, url: string): Observation {
  const h = raw.home.headers
  const seen: Record<string, string> = {}
  for (const name of STACK_HEADERS) if (h[name] !== undefined) seen[name] = h[name]!
  if (h.via !== undefined && viaDisclosesVersion(h.via)) seen.via = h.via
  if (h.server !== undefined && VERSIONED_SERVER.test(h.server.trim())) seen.server = h.server
  const names = Object.keys(seen)
  return observation(
    true,
    names.length > 0,
    names.length > 0 ? names.map((n) => `${n}: ${seen[n]}`).join('; ') : 'no version or backend disclosed',
    { url, headers: seen, server: h.server ?? 'absent', via: h.via ?? 'absent' },
  )
}

function deprecatedHeaders(raw: RawCapture, url: string): Observation {
  const h = raw.home.headers
  const seen: Record<string, string> = {}
  const xss = h['x-xss-protection']
  // `0` is the recommended value — it turns the retired auditor OFF.
  if (xss !== undefined && xss.trim() !== '0') seen['x-xss-protection'] = xss
  for (const name of ['expect-ct', 'feature-policy', 'public-key-pins'] as const) {
    if (h[name] !== undefined) seen[name] = h[name]!
  }
  const names = Object.keys(seen)
  return observation(
    true,
    names.length > 0,
    names.length > 0
      ? `still sent: ${names.map((n) => `${n}: ${seen[n]}`).join('; ')}`
      : 'none of x-xss-protection (other than 0), expect-ct, feature-policy, public-key-pins',
    { url, seen, ...(xss !== undefined ? { xXssProtection: xss } : {}) },
  )
}

/** 180 days — the floor the HSTS preload list and most scanners use. */
const HSTS_MIN_MAX_AGE = 15_552_000

function hstsQuality(raw: RawCapture, url: string): Observation {
  const seen = raw.home.headers['strict-transport-security']
  if (seen === undefined) {
    return notApplicable('no Strict-Transport-Security header', {
      url, maxAge: null, includeSubDomains: false, preload: false,
    })
  }
  let maxAge: number | null = null
  let includeSubDomains = false
  let preload = false
  for (const part of seen.split(';')) {
    const [k = '', ...v] = part.split('=')
    const key = k.trim().toLowerCase()
    if (key === 'max-age' && maxAge === null) {
      const n = Number.parseInt(v.join('=').trim().replace(/^"|"$/g, ''), 10)
      maxAge = Number.isFinite(n) ? n : null
    } else if (key === 'includesubdomains') includeSubDomains = true
    else if (key === 'preload') preload = true
  }
  const evidence = { url, seen, maxAge, includeSubDomains, preload }
  if (maxAge === null) return observation(true, true, 'no parseable max-age, so browsers ignore the header', evidence)
  const short = maxAge < HSTS_MIN_MAX_AGE
  return observation(
    true,
    short,
    `max-age=${maxAge}${short ? ' is under 180 days' : ''}${includeSubDomains ? '; includeSubDomains' : ''}${preload ? '; preload' : ''}`,
    evidence,
  )
}

function reportingEndpoints(raw: RawCapture, url: string): Observation {
  const h = raw.home.headers
  const evidence = {
    url,
    reportTo: h['report-to'] ?? 'absent',
    reportingEndpoints: h['reporting-endpoints'] ?? 'absent',
    nel: h.nel ?? 'absent',
  }
  const present = [
    h['report-to'] !== undefined ? 'Report-To' : null,
    h['reporting-endpoints'] !== undefined ? 'Reporting-Endpoints' : null,
    h.nel !== undefined ? 'NEL' : null,
  ].filter((p): p is string => p !== null)
  // Never a gap: reporting is plumbing a site may or may not want, and its
  // absence says nothing about the site's exposure.
  return observation(true, false, present.length > 0 ? `${present.join(', ')} sent` : 'no reporting headers sent', evidence)
}

// ---------------------------------------------------------------------------

/**
 * All twenty-five, for a homepage that answered. The caller (extractProfile)
 * only calls this when `raw.home.ok`; a homepage that never answered has no
 * headers and no markup, and nothing is observed about it at all.
 */
export function additiveObservations(raw: RawCapture, facts: HtmlFacts): Record<AdditiveKey, Observation> {
  const url = raw.home.finalUrl || `https://${raw.domain}/`
  return {
    ...presenceObservations(raw, facts),
    ...cspObservations(raw, url),
    cookie_flags: cookieFlags(raw, url),
    referrer_policy_quality: referrerQuality(raw, url),
    permissions_policy_quality: permissionsQuality(raw, url),
    content_type_options_quality: contentTypeQuality(raw, url),
    cross_origin_policies: crossOriginPolicies(raw, url),
    sri_third_party: sriThirdParty(raw, facts, url),
    mixed_content: mixedContent(raw, facts, url),
    stack_disclosure: stackDisclosure(raw, url),
    deprecated_headers: deprecatedHeaders(raw, url),
    hsts_quality: hstsQuality(raw, url),
    reporting_endpoints: reportingEndpoints(raw, url),
  }
}
