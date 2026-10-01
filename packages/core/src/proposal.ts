/**
 * A proposal written from what the scan actually found (PROMPT.md §8.6).
 *
 * "Proposals generate from findings — the assessment scope writes itself from
 * what the scan already found." So the scope is DERIVED: one workstream per
 * observed gap, grouped, with the evidence that produced it attached. Nothing
 * here is invented about the company; the only prose is the agency's, about
 * its own work.
 *
 * §2.2 governs this file more than any other rule:
 *
 *  - a finding whose `observed` is false is NOT a gap and never becomes scope.
 *    It is listed, separately and honestly, as "not assessed" — a proposal
 *    that quietly omits what the scanner could not see reads as if it had
 *    looked and found nothing;
 *  - a stale scan produces NO proposal. §2.2 says stale findings must be
 *    re-verified before appearing in any outbound draft, and a proposal is the
 *    most outbound draft there is. The caller re-scans first, or gets a
 *    refusal that says so;
 *  - neither does a scan scored under a different ICP profile than the one
 *    the proposal walks. After an informational signal is promoted into the
 *    ICP, a scan recorded before the promotion holds that key observed but
 *    `scored = false`; the walk below skips such a row and would list the
 *    signal as "not assessable from the outside" — in the buyer's document,
 *    about a signal the scanner DID observe. `rescore` says so instead.
 *
 * Pure. The caller reads the rows, decides freshness with `isStale`, and
 * hands the facts in. `packages/core` does no I/O.
 */
import type { IcpDefinition } from './icp.js'
import { orderedSignals } from './icp.js'

export interface ProposalFinding {
  readonly signalKey: string
  readonly observed: boolean
  readonly gap: boolean | null
  readonly weight: number
  readonly detail: string | null
  readonly evidence: Readonly<Record<string, unknown>>
  /**
   * `findings.scored`. An informational signal (false) is never scope and is
   * never counted in the summary's "of N signals observed". Optional, and
   * absent means scored (the column's default). Pass EVERY row of the scan,
   * informational ones included: a row for an ICP key that says
   * `scored = false` is how a scan recorded before a promotion is recognised.
   */
  readonly scored?: boolean
}

/**
 * Which ICP profile the scan was scored under, beside the one active now.
 * `scores.icp_profile_id` names the first; `scoreProfileId` is null only for
 * a scan with no score row, which has no score to disagree with.
 */
export interface ProposalProfiles {
  readonly activeProfileId: string
  readonly scoreProfileId: string | null
}

export interface ProposalInput {
  readonly company: { readonly domain: string; readonly name: string | null }
  readonly agency: { readonly name: string }
  readonly icp: IcpDefinition
  /** Every finding on the LATEST successful scan, observed or not. */
  readonly findings: readonly ProposalFinding[]
  readonly scan: { readonly ranAt: Date; readonly stale: boolean; readonly ok: boolean }
  readonly score: { readonly score: number; readonly tier: string | null } | null
  /** Required, so a caller cannot skip the check by not knowing it exists. */
  readonly profiles: ProposalProfiles
  /** The agency's day rate, in whole currency units; null leaves pricing as a placeholder. */
  readonly dayRate?: number | null
  readonly currency?: string
  readonly generatedAt: Date
}

export interface ScopeItem {
  readonly signalKey: string
  /** From the ICP: why this matters, in the agency's own words. */
  readonly why: string
  readonly workstream: string
  readonly deliverable: string
  readonly evidence: readonly string[]
  readonly weight: number
}

export interface Workstream {
  readonly name: string
  readonly summary: string
  readonly items: readonly ScopeItem[]
  /** Effort in days. A band, because a proposal is a promise about work. */
  readonly effortDays: { readonly low: number; readonly high: number }
}

export interface Proposal {
  readonly title: string
  readonly summary: string
  readonly basedOn: { readonly scanRanAt: string; readonly score: number | null; readonly tier: string | null }
  readonly workstreams: readonly Workstream[]
  readonly alreadyInPlace: readonly { readonly signalKey: string; readonly why: string }[]
  readonly notAssessed: readonly { readonly signalKey: string; readonly why: string }[]
  readonly assumptions: readonly string[]
  readonly pricing: {
    readonly currency: string
    readonly dayRate: number | null
    readonly effortDays: { readonly low: number; readonly high: number }
    readonly total: { readonly low: number; readonly high: number } | null
  }
  readonly generatedAt: string
}

/** Why no proposal was written. Every screen that offers the button renders each of these. */
export type ProposalRefusal = 'stale' | 'unreachable' | 'no_gaps' | 'no_scan' | 'rescore'

export type ProposalOutcome =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly reason: ProposalRefusal; readonly message: string }

/** The `rescore` refusal's words, for the company page's button and the generator alike. */
export const PROPOSAL_RESCORE_SENTENCE = 'scored under a different profile — re-scan'

/**
 * Whether the scan's findings were scored under a profile other than the
 * active one, so the proposal's walk over the active ICP would misread them.
 * Two ways to know: the score row names another profile, or a signal the
 * active ICP scores has a row on this scan that was recorded unscored — the
 * promotion case, which a score row alone cannot show if the promotion
 * edited the active profile rather than replacing it.
 */
export function proposalNeedsRescore(input: {
  readonly icp: IcpDefinition
  readonly findings: readonly { readonly signalKey: string; readonly scored?: boolean }[]
  readonly profiles: ProposalProfiles
}): boolean {
  const { activeProfileId, scoreProfileId } = input.profiles
  if (scoreProfileId !== null && scoreProfileId !== activeProfileId) return true
  const scoredNow = new Set(orderedSignals(input.icp).map(([key]) => key))
  return input.findings.some((f) => f.scored === false && scoredNow.has(f.signalKey))
}

/**
 * Where each signal's remediation belongs, and how much of it there is.
 *
 * Keyed by the seeded ICP's signal names. A key the table does not know still
 * produces scope — under a generic workstream, with the ICP's own `why` as the
 * only description — because an ICP is editable data and a proposal that
 * silently dropped a signal the team added would be wrong in the quiet way.
 */
const WORKSTREAMS: Readonly<
  Record<string, { readonly name: string; readonly summary: string; readonly deliverable: string; readonly days: number }>
> = {
  csp: {
    name: 'Security headers baseline',
    summary: 'Define, stage and roll out the browser-side protections the site currently lacks, with a report-only phase so nothing breaks.',
    deliverable: 'A Content-Security-Policy, deployed report-only first, then enforced, with the violation reports reviewed.',
    days: 3,
  },
  hsts: {
    name: 'Security headers baseline',
    summary: 'Define, stage and roll out the browser-side protections the site currently lacks, with a report-only phase so nothing breaks.',
    deliverable: 'Strict-Transport-Security with a safe max-age ramp and a preload decision.',
    days: 0.5,
  },
  frame_protection: {
    name: 'Security headers baseline',
    summary: 'Define, stage and roll out the browser-side protections the site currently lacks, with a report-only phase so nothing breaks.',
    deliverable: 'Clickjacking protection via frame-ancestors, with any legitimate embedding allow-listed.',
    days: 0.5,
  },
  content_type_options: {
    name: 'Security headers baseline',
    summary: 'Define, stage and roll out the browser-side protections the site currently lacks, with a report-only phase so nothing breaks.',
    deliverable: 'X-Content-Type-Options: nosniff, verified against every served content type.',
    days: 0.25,
  },
  referrer_policy: {
    name: 'Security headers baseline',
    summary: 'Define, stage and roll out the browser-side protections the site currently lacks, with a report-only phase so nothing breaks.',
    deliverable: 'A Referrer-Policy that stops internal URLs leaking to third parties.',
    days: 0.25,
  },
  permissions_policy: {
    name: 'Security headers baseline',
    summary: 'Define, stage and roll out the browser-side protections the site currently lacks, with a report-only phase so nothing breaks.',
    deliverable: 'A Permissions-Policy covering camera, microphone, geolocation and payment.',
    days: 0.25,
  },
  tls: {
    name: 'Transport and server hygiene',
    summary: 'Bring the edge up to a defensible configuration and remove what it discloses about itself.',
    deliverable: 'TLS configuration review and remediation: protocol versions, cipher order, certificate chain and renewal.',
    days: 1,
  },
  server_banner: {
    name: 'Transport and server hygiene',
    summary: 'Bring the edge up to a defensible configuration and remove what it discloses about itself.',
    deliverable: 'Server and framework version disclosure removed from response headers.',
    days: 0.25,
  },
  outdated_js: {
    name: 'Dependency hygiene',
    summary: 'Replace the front-end libraries with known vulnerabilities and put a process in place so they do not come back.',
    deliverable: 'Outdated front-end libraries upgraded or removed, with an inventory and an update cadence.',
    days: 2,
  },
  security_txt: {
    name: 'Trust and disclosure programme',
    summary: 'Give buyers and researchers the public signals enterprise procurement looks for first.',
    deliverable: 'A /.well-known/security.txt with a named contact, a policy and an expiry.',
    days: 0.25,
  },
  trust_page: {
    name: 'Trust and disclosure programme',
    summary: 'Give buyers and researchers the public signals enterprise procurement looks for first.',
    deliverable: 'A public security and trust page describing controls, data handling and how to report an issue.',
    days: 1.5,
  },
  compliance_claim: {
    name: 'Trust and disclosure programme',
    summary: 'Give buyers and researchers the public signals enterprise procurement looks for first.',
    deliverable: 'A compliance readiness assessment against SOC 2 / ISO 27001 with a gap list and a realistic timeline.',
    days: 3,
  },
}

const GENERIC = {
  name: 'Additional remediation',
  summary: 'Findings outside the standard workstreams, scoped individually.',
  days: 1,
}

/** Lines a person can read from a finding's raw evidence. Never invented. */
function evidenceLines(evidence: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(evidence)) {
    if (value === null || value === undefined || value === '') continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    out.push(`${key}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`)
  }
  return out
}

export function proposalFromFindings(input: ProposalInput): ProposalOutcome {
  const companyName = input.company.name ?? input.company.domain
  const currency = input.currency ?? 'USD'

  if (!input.scan.ok) {
    return {
      ok: false,
      reason: 'unreachable',
      message: `The last scan of ${input.company.domain} never reached the site, so nothing was observed. Nothing can be proposed from it.`,
    }
  }
  if (input.findings.length === 0) {
    return { ok: false, reason: 'no_scan', message: `${input.company.domain} has not been scanned, so there are no findings to write from.` }
  }
  if (input.scan.stale) {
    return {
      ok: false,
      reason: 'stale',
      message:
        `The last scan of ${input.company.domain} ran on ${input.scan.ranAt.toISOString().slice(0, 10)} and has aged out. ` +
        'A proposal quotes findings, and stale findings must be re-verified first (§2.2). Re-scan, then generate.',
    }
  }
  if (proposalNeedsRescore(input)) {
    return {
      ok: false,
      reason: 'rescore',
      message:
        `The last scan of ${input.company.domain} was ${PROPOSAL_RESCORE_SENTENCE}, then generate. The active ICP ` +
        'scores signals that scan did not, so a signal the scanner observed would be listed to the buyer as not assessed.',
    }
  }

  // Scored rows only. An informational row is not part of the score this
  // proposal is based on, so it is neither scope nor "in place" nor counted.
  const bySignal = new Map(input.findings.filter((f) => f.scored !== false).map((f) => [f.signalKey, f]))
  const signals = orderedSignals(input.icp)

  const scope: ScopeItem[] = []
  const alreadyInPlace: { signalKey: string; why: string }[] = []
  const notAssessed: { signalKey: string; why: string }[] = []

  for (const [key, signal] of signals) {
    const f = bySignal.get(key)
    if (!f || !f.observed) {
      // §2.2. Not a gap, not a strength: not seen. Said so.
      notAssessed.push({ signalKey: key, why: signal.why })
      continue
    }
    if (f.gap !== true) {
      alreadyInPlace.push({ signalKey: key, why: signal.why })
      continue
    }
    const ws = WORKSTREAMS[key]
    scope.push({
      signalKey: key,
      why: signal.why,
      workstream: ws?.name ?? GENERIC.name,
      deliverable: ws?.deliverable ?? `Remediate: ${signal.why}`,
      evidence: [...(f.detail ? [f.detail] : []), ...evidenceLines(f.evidence)],
      weight: f.weight,
    })
  }

  if (scope.length === 0) {
    return {
      ok: false,
      reason: 'no_gaps',
      message: `The last scan of ${input.company.domain} found nothing to remediate among what it could observe. There is no assessment to propose.`,
    }
  }

  // Group into workstreams, in the order the ICP weights them — the heaviest
  // gap's workstream first, because that is the one the buyer was written to
  // about.
  const raw: Array<{ name: string; summary: string; items: ScopeItem[]; low: number; high: number }> = []
  for (const item of scope) {
    let ws = raw.find((s) => s.name === item.workstream)
    if (!ws) {
      const meta = WORKSTREAMS[item.signalKey] ?? GENERIC
      ws = { name: item.workstream, summary: meta.summary, items: [], low: 0, high: 0 }
      raw.push(ws)
    }
    const days = WORKSTREAMS[item.signalKey]?.days ?? GENERIC.days
    ws.items.push(item)
    // The low end is the days; the high end allows for what is always found
    // once someone is inside a codebase.
    ws.low += days
    ws.high += days * 1.6
  }
  // Rounded to halves ONCE, at the end — quarter-days on a proposal read as
  // false precision, and rounding each increment compounds the error.
  const streams: Workstream[] = raw.map((s) => ({
    name: s.name,
    summary: s.summary,
    items: s.items,
    effortDays: { low: roundHalf(s.low), high: roundHalf(s.high) },
  }))

  const effort = {
    low: roundHalf(raw.reduce((n, s) => n + s.low, 0)),
    high: roundHalf(raw.reduce((n, s) => n + s.high, 0)),
  }
  const dayRate = input.dayRate ?? null
  const total = dayRate ? { low: Math.round(effort.low * dayRate), high: Math.round(effort.high * dayRate) } : null

  const gapCount = scope.length
  // Counted over the ICP's signals — the same walk the scope came from — and
  // not over every row on the scan. A scan also records informational
  // signals, and "Of 25 signals observed, 4 were gaps" about a review scored
  // on twelve is a number nobody computed, in the document a buyer reads.
  const observedCount = signals.filter(([key]) => bySignal.get(key)?.observed === true).length

  return {
    ok: true,
    proposal: {
      title: `Application security posture remediation for ${companyName}`,
      summary:
        `On ${input.scan.ranAt.toISOString().slice(0, 10)} ${input.agency.name} reviewed ${input.company.domain} from the outside — ` +
        `its public pages, response headers, well-known paths and TLS certificate; nothing private was accessed. ` +
        `Of ${observedCount} signals observed, ${gapCount} ${gapCount === 1 ? 'was' : 'were'} gaps. ` +
        `This proposal scopes closing them, grouped into ${streams.length} workstream${streams.length === 1 ? '' : 's'}, ` +
        `with the evidence for each attached so the scope can be checked against the site rather than taken on trust.`,
      basedOn: {
        scanRanAt: input.scan.ranAt.toISOString(),
        score: input.score?.score ?? null,
        tier: input.score?.tier ?? null,
      },
      workstreams: streams,
      alreadyInPlace,
      notAssessed,
      assumptions: [
        'Scope is limited to what was observed from the outside on the date above. Anything found once inside the codebase or infrastructure is raised, estimated and agreed separately before work on it starts.',
        'Every header change is deployed in a report-only or staged mode first, and nothing is enforced without a review of what it would have blocked.',
        `${companyName} provides access to the relevant repositories and deployment configuration, and a named engineer to review changes.`,
        ...(notAssessed.length > 0
          ? [`${notAssessed.length} signal${notAssessed.length === 1 ? ' was' : 's were'} not assessable from the outside and ${notAssessed.length === 1 ? 'is' : 'are'} excluded from scope, not assumed to be fine. They are listed below.`]
          : []),
      ],
      pricing: { currency, dayRate, effortDays: effort, total },
      generatedAt: input.generatedAt.toISOString(),
    },
  }
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2
}
