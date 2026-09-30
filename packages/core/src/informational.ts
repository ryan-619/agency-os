/**
 * The informational scanner signals: observed from the outside and recorded,
 * never scored.
 *
 * The scanner (packages/scanner/src/additive.ts) computes thirteen of these
 * from bytes it already captures. They are not in the ICP — `parseIcpDefinition`
 * refuses `weight: 0`, so an ICP cannot even pretend to hold one — and
 * `recordScan` stores them with `scored = false`, which the schema pins to
 * `weight = 0`. Nothing quotes them: not a draft, not a proposal, not a brief.
 * They are context on the company page and in `get_company`, with the label
 * and the one-line `why` below.
 *
 * Promotion is the ICP's business, not this file's: add the key to the ICP
 * with a real weight and it scores from the next scan on, and `recordScan`
 * writes it `scored = true` because the key is then in the ICP.
 *
 * Keyed by string rather than by the scanner's `AdditiveKey`, because the
 * scanner depends on this package and not the other way round;
 * `test/informational.test.ts` holds the two lists together.
 *
 * Pure, like everything in packages/core.
 */

import { isStale } from './freshness.js'

export interface InformationalSignal {
  /** A short name for a table row. */
  readonly label: string
  /** Why anyone would look at it — never a claim that it matters to a sale. */
  readonly why: string
  /** Which part of the homepage response it is read from. */
  readonly source: 'header' | 'html' | 'cookie'
}

export const INFORMATIONAL_SIGNALS: Readonly<Record<string, InformationalSignal>> = Object.freeze({
  csp_report_only: {
    label: 'CSP in report-only mode',
    why: 'A report-only policy records violations and blocks nothing; on its own it is a rollout step, not protection.',
    source: 'header',
  },
  csp_quality: {
    label: 'CSP script sources',
    why: "'unsafe-inline', 'unsafe-eval' or a wildcard in the script sources lets the policy allow the injection it exists to stop.",
    source: 'header',
  },
  cookie_flags: {
    label: 'Cookie flags',
    why: 'A session cookie without Secure and HttpOnly can be read by script or sent over plain HTTP. CDN and analytics cookies are labelled and left out.',
    source: 'cookie',
  },
  referrer_policy_quality: {
    label: 'Referrer-Policy value',
    why: 'Some values send the full URL to other sites, which is what the header is usually set to prevent.',
    source: 'header',
  },
  permissions_policy_quality: {
    label: 'Permissions-Policy coverage',
    why: 'Whether the header actually restricts the powerful features (camera, microphone, geolocation, payment, USB, topics), and whether the deprecated Feature-Policy spelling is used.',
    source: 'header',
  },
  content_type_options_quality: {
    label: 'X-Content-Type-Options value',
    why: 'Browsers honour only the exact value nosniff; anything else is ignored.',
    source: 'header',
  },
  cross_origin_policies: {
    label: 'Cross-origin isolation headers',
    why: 'COOP, COEP and CORP limit what other origins can do with the page; none of them sent, or COOP unsafe-none, is no isolation.',
    source: 'header',
  },
  sri_third_party: {
    label: 'Subresource integrity on third-party scripts',
    why: 'A ratio of third-party scripts pinned with integrity=. Tag managers cannot use SRI and are counted, not flagged.',
    source: 'html',
  },
  mixed_content: {
    label: 'Mixed content',
    why: 'Scripts, stylesheets or frames over http:// on an https page are blocked or tamperable; images are upgraded by browsers and listed separately.',
    source: 'html',
  },
  stack_disclosure: {
    label: 'Stack disclosure headers',
    why: 'Version numbers, build hashes and backend names in response headers tell a visitor what the site runs.',
    source: 'header',
  },
  deprecated_headers: {
    label: 'Deprecated headers',
    why: 'X-XSS-Protection (other than 0), Expect-CT, Feature-Policy and Public-Key-Pins are retired; they do nothing useful now and some did harm.',
    source: 'header',
  },
  hsts_quality: {
    label: 'HSTS max-age',
    why: 'A max-age under 180 days lapses between visits and does not qualify for the preload list.',
    source: 'header',
  },
  reporting_endpoints: {
    label: 'Reporting endpoints',
    why: 'Report-To, Reporting-Endpoints and NEL show whether the site collects browser reports. Recorded as context; never a gap.',
    source: 'header',
  },
})

export function isInformationalSignal(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(INFORMATIONAL_SIGNALS, key)
}

/**
 * How one informational finding reads in a table, in the words a page or the
 * agent should use for it.
 *
 * Deliberately NOT "in place": an informational signal that raised nothing is
 * observed, not a strength. "Not applicable" is the scanner's convention for
 * a question the page gave no occasion to ask (no CSP to judge, no cookies
 * set) — observed, no gap, and a detail that says so — and it is shown as
 * exactly that rather than as a pass.
 */
export type InformationalStatus = 'gap' | 'observed' | 'not applicable' | 'not observed'

export function informationalStatus(f: {
  readonly observed: boolean
  readonly gap: boolean | null
  readonly detail: string | null
}): InformationalStatus {
  if (!f.observed) return 'not observed'
  if (f.gap === true) return 'gap'
  if ((f.detail ?? '').startsWith('not applicable')) return 'not applicable'
  return 'observed'
}

export interface InformationalRow {
  readonly key: string
  readonly label: string
  /** Null for a key the catalogue does not know — shown by name, never dropped. */
  readonly why: string | null
  readonly status: InformationalStatus
  readonly detail: string | null
  readonly evidence: Readonly<Record<string, unknown>>
}

export interface InformationalSection {
  /**
   * Derived from the scan's `ran_at` with `isStale`, never read from the
   * `findings.stale` cache — the rule every other reader of findings follows.
   * Nothing quotes these rows, but they are still statements about somebody's
   * site, and one that aged out is shown as aged out.
   */
  readonly stale: boolean
  readonly rows: readonly InformationalRow[]
}

const STATUS_ORDER: Readonly<Record<InformationalStatus, number>> = {
  gap: 0, observed: 1, 'not applicable': 2, 'not observed': 3,
}

/**
 * Everything the company page's "Also observed (not scored)" section shows,
 * decided here so it can be tested with a fixed clock: the rows in a stable
 * order (what was flagged first, then the catalogue's order), each with its
 * label, why and status, and whether the scan they came from has aged out.
 */
export function informationalSection(input: {
  readonly scan: { readonly ranAt: Date | string }
  readonly findings: readonly {
    readonly signalKey: string
    readonly observed: boolean
    readonly gap: boolean | null
    readonly detail: string | null
    readonly evidence: unknown
  }[]
  readonly staleAfterDays: number
  readonly now?: Date
}): InformationalSection {
  const catalogue = Object.keys(INFORMATIONAL_SIGNALS)
  const place = (key: string): number => {
    const i = catalogue.indexOf(key)
    return i === -1 ? catalogue.length : i
  }
  const rows: InformationalRow[] = input.findings.map((f) => ({
    key: f.signalKey,
    label: INFORMATIONAL_SIGNALS[f.signalKey]?.label ?? f.signalKey,
    why: INFORMATIONAL_SIGNALS[f.signalKey]?.why ?? null,
    status: informationalStatus(f),
    detail: f.detail,
    evidence: f.evidence && typeof f.evidence === 'object' ? (f.evidence as Record<string, unknown>) : {},
  }))
  rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      place(a.key) - place(b.key) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  return { stale: isStale(input.scan.ranAt, input.staleAfterDays, input.now ?? new Date()), rows }
}
