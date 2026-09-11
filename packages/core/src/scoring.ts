/**
 * Turn raw observations into a fit score, a tier, and the pitch angle.
 *
 * A port of `src/score.py` from the Python lead engine, kept deliberately
 * line-for-line: PROMPT.md §8.3 says "the rules encoded in it are the product,
 * particularly the `observed` handling and the disqualifier ordering".
 * packages/scanner/test/parity.test.ts asserts this file agrees with the
 * Python original on recorded input for all sixteen seed domains.
 *
 * Pure. No I/O, no framework, no database (§3).
 */
import { orderedSignals, type IcpDefinition, type SignalKey } from './icp.js'

/** One signal as the scanner saw it. Mirrors the Python `observations` entry. */
export interface Observation {
  /**
   * §2.2 — false for a fetch failure, timeout, WAF block or CDN quirk.
   * An unobserved signal is excluded from BOTH sides of the ratio, so a
   * blocked fetch can never become a finding.
   */
  readonly observed: boolean
  /** null whenever `observed` is false: unknown, not "no gap". */
  readonly gap: boolean | null
  readonly detail: string
  /** What produced the observation — the header value seen, the URL fetched. */
  readonly evidence?: Record<string, unknown>
}

export interface OutdatedLib {
  readonly lib: string
  readonly version: string
  readonly note: string
  readonly src?: string
}

/** The scanner's output for one company: everything scoring needs, and no I/O. */
export interface SiteProfile {
  readonly domain: string
  readonly company?: string
  readonly title?: string
  readonly fetchOk: boolean
  readonly fetchError?: string
  readonly hasLoginSurface: boolean
  readonly isSecurityVendor: boolean
  readonly mentionsSecurityHiring: boolean
  readonly outdatedLibs: readonly OutdatedLib[]
  readonly observations: Readonly<Record<SignalKey, Observation>>
}

export interface ScoredGap {
  readonly key: SignalKey
  readonly weight: number
  readonly why: string
  readonly detail: string
}

export interface ScoredStrength {
  readonly key: SignalKey
  readonly detail: string
}

export interface EvidenceLine {
  readonly claim: string
  readonly observed: string
}

export interface ScoreResult {
  readonly domain: string
  readonly company: string
  readonly title: string
  /** Normalised 0-100 over the weights of OBSERVED signals only. */
  readonly score: number
  readonly tier: string
  readonly qualified: boolean
  readonly disqualified: string
  readonly gaps: readonly ScoredGap[]
  readonly strengths: readonly ScoredStrength[]
  readonly headlineFinding: string
  readonly angle: string
  readonly evidence: readonly EvidenceLine[]
  readonly reachable: boolean
  readonly fetchError: string
}

/**
 * Python's round() is banker's rounding — half to EVEN — while JavaScript's
 * Math.round is half UP. `round(42.5)` is 42 in Python and 43 in JavaScript.
 *
 * That one point straddles the qualifying threshold, so without this the two
 * engines would disagree about whether a company is worth emailing. Exported
 * so the parity test can exercise it directly.
 */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  // Exactly .5 — pick the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * Findings that can be pointed at outrank findings that are merely absent.
 * An opener quoting a library version is checkable; "you have no CSP header"
 * invites an argument. Same three buckets as the Python original.
 */
const CONCRETE_KEYS = ['outdated_js', 'tls', 'server_banner'] as const
const STRUCTURAL_KEYS = ['trust_page', 'compliance_claim', 'security_txt'] as const
const HEADER_KEYS = ['csp', 'hsts', 'frame_protection'] as const

function disqualify(domain: string, profile: SiteProfile, reason: string): ScoreResult {
  return {
    domain,
    company: profile.company || domain,
    title: profile.title ?? '',
    score: 0,
    tier: '',
    qualified: false,
    disqualified: reason,
    gaps: [],
    strengths: [],
    headlineFinding: '',
    angle: '',
    evidence: [],
    reachable: profile.fetchOk,
    fetchError: profile.fetchError ?? '',
  }
}

export function scoreCompany(profile: SiteProfile, icp: IcpDefinition): ScoreResult {
  const domain = profile.domain ?? ''

  // --- disqualifiers, before any scoring effort -----------------------------
  // The ORDER is part of the product: unreachable first, because nothing was
  // observed and therefore nothing can be claimed.
  if (!profile.fetchOk) {
    return disqualify(domain, profile, `unreachable (${profile.fetchError || 'no response'})`)
  }
  if (profile.isSecurityVendor) {
    return disqualify(domain, profile, icp.disqualifiers.is_security_vendor ?? 'sells security')
  }
  if (profile.mentionsSecurityHiring) {
    return disqualify(domain, profile, icp.disqualifiers.has_security_team ?? 'has in-house security')
  }
  if (!profile.hasLoginSurface) {
    return disqualify(domain, profile, icp.disqualifiers.no_public_product ?? 'no public product')
  }

  // --- score only what was actually observed --------------------------------
  let raw = 0
  let maxPossible = 0
  const gaps: ScoredGap[] = []
  const strengths: ScoredStrength[] = []

  for (const [key, signal] of orderedSignals(icp)) {
    const o = profile.observations[key]
    // Never penalise for what could not be seen: excluded from the numerator
    // AND the denominator (§2.2).
    if (!o || !o.observed) continue
    maxPossible += signal.weight
    if (o.gap) {
      raw += signal.weight
      gaps.push({ key, weight: signal.weight, why: signal.why, detail: o.detail })
    } else {
      strengths.push({ key, detail: o.detail })
    }
  }

  const score = maxPossible ? roundHalfToEven((100 * raw) / maxPossible) : 0

  // Stable sort by descending weight, so equal weights keep the order the walk
  // above used — the same tie-break Python's stable sort gives.
  const sortedGaps = [...gaps].sort((a, b) => b.weight - a.weight)

  let tier = ''
  for (const t of icp.scoring.tiers) {
    if (score >= t.floor) {
      tier = t.name
      break
    }
  }
  const qualified = score >= icp.scoring.qualify_at

  // --- the headline: the most demonstrable thing, not the heaviest ----------
  const concrete = sortedGaps.filter((g) => (CONCRETE_KEYS as readonly string[]).includes(g.key))
  const structural = sortedGaps.filter((g) => (STRUCTURAL_KEYS as readonly string[]).includes(g.key))
  const header = sortedGaps.filter((g) => (HEADER_KEYS as readonly string[]).includes(g.key))

  let headlineFinding = ''
  const lib = profile.outdatedLibs[0]
  if (lib) {
    headlineFinding = `${lib.lib} ${lib.version} served in production — ${lib.note}`
  } else if (concrete[0]) {
    headlineFinding = `${concrete[0].why} (${concrete[0].detail})`
  } else if (header[0]) {
    headlineFinding = header[0].why
  } else if (structural[0]) {
    headlineFinding = structural[0].why
  }

  // --- the angle: why THEY should care, in their language -------------------
  const noTrust = sortedGaps.some((g) => g.key === 'trust_page')
  const noSoc2 = sortedGaps.some((g) => g.key === 'compliance_claim')
  let angle: string
  if (noTrust && noSoc2) {
    angle =
      'No public trust page and no SOC 2 claim: the next enterprise deal ' +
      'stalls at the security questionnaire. Sell the questionnaire-readiness ' +
      'sprint — assessment, fixes, and the trust page that unblocks procurement.'
  } else if (noSoc2) {
    angle =
      'Security page exists but no SOC 2 / ISO claim — they are mid-journey. ' +
      'Sell the gap assessment and the DevSecOps pipeline that makes audit evidence ' +
      'a build artifact instead of a fire drill.'
  } else if (header.length >= 3) {
    angle =
      'Multiple baseline headers missing on a login-bearing app — cheap to fix, ' +
      'always flagged by scanners and buyers. Sell it as a short hardening engagement ' +
      'that opens the door to the pipeline work.'
  } else {
    angle =
      'Posture is partly there. Lead with the specific finding and offer a ' +
      'one-week assessment rather than a retainer pitch.'
  }

  const evidence: EvidenceLine[] = sortedGaps.slice(0, 6).map((g) => ({
    claim: g.why,
    observed: g.detail || 'header absent on homepage response',
  }))

  return {
    domain,
    company: profile.company || domain,
    title: profile.title ?? '',
    score,
    tier,
    qualified,
    disqualified: '',
    gaps: sortedGaps,
    strengths,
    headlineFinding,
    angle,
    evidence,
    reachable: profile.fetchOk,
    fetchError: profile.fetchError ?? '',
  }
}

/** Qualified first, then by descending score, then by domain. */
export function rank(results: readonly ScoreResult[]): ScoreResult[] {
  return [...results].sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1
    if (a.score !== b.score) return b.score - a.score
    return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0
  })
}
