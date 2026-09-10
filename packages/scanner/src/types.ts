/**
 * What one scan collected from a company's public surface, before any
 * interpretation.
 *
 * Splitting the raw capture from the interpretation is what makes the port
 * checkable: the same recorded bytes can be fed to this engine and to the
 * original Python one, and the findings compared. It is also what
 * `scans.raw jsonb` stores (§4), so a finding can always be traced back to
 * what was actually on the wire.
 */

export interface RawResponse {
  /** HTTP status, or null when the request never completed. */
  readonly status: number | null
  readonly body: string
  /** Populated instead of status when the request failed outright. */
  readonly error?: string
}

export interface RawTls {
  readonly ok: boolean
  readonly protocol?: string
  readonly issuer?: string
  /** ISO date. */
  readonly expires?: string
  readonly daysToExpiry?: number
  readonly error?: string
}

export interface RawCapture {
  /** Normalised host — no scheme, no path, no leading `www.`. */
  readonly domain: string
  readonly capturedAt: string
  readonly home: {
    readonly ok: boolean
    readonly status: number | null
    readonly finalUrl: string
    /** Header names lower-cased, exactly as the Python engine sees them. */
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
    readonly error?: string
  }
  /**
   * Every conventional public path probed, keyed by path. §2.2 / COMPLIANCE:
   * these are the only paths requested, and each is one a site publishes on
   * purpose. No directory brute-forcing, ever.
   */
  readonly paths: Readonly<Record<string, RawResponse>>
  readonly tls: RawTls
}

/** The conventional, publicly-advertised paths — and nothing else. */
export const PUBLIC_PATHS = {
  security_txt: ['/.well-known/security.txt', '/security.txt'],
  trust_page: ['/security', '/trust', '/trust-center', '/security-and-privacy'],
} as const

export const ALL_PUBLIC_PATHS: readonly string[] = [
  ...PUBLIC_PATHS.security_txt,
  ...PUBLIC_PATHS.trust_page,
]
