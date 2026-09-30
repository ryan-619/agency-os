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
  /**
   * The read hit the 1.5 MB cap, so `body` is a PREFIX of the page rather than
   * the page. Recorded because §2.2 turns on the difference: an absence read
   * off a body that was cut short was not observed.
   */
  readonly truncated?: boolean
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
    /**
     * Header names lower-cased, the FIRST value of a repeated header — which
     * is what `email.message.Message.get` gives the Python engine.
     */
    readonly headers: Readonly<Record<string, string>>
    /**
     * EVERY `Set-Cookie` the homepage response carried, in order — `headers`
     * above holds only the first, by parity, and a site sets several. Each
     * entry has its VALUE replaced by `<redacted>`: no rule reads it, and a
     * session cookie's value is a bearer credential for the session the
     * scanner was handed (§2.3). Names and attributes are what `cookie_flags`
     * judges.
     *
     * Optional because the sixteen recorded fixtures predate it. Absent means
     * "not captured", which the extractor reports as unobserved — never as a
     * site that sets no cookies.
     */
    readonly setCookies?: readonly string[]
    readonly body: string
    /** See RawResponse.truncated. */
    readonly truncated?: boolean
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
