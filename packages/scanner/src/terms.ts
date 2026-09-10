/**
 * The term lists and library floors, ported verbatim from `src/signals.py`.
 * Order matters for `compliance_claims`, which is joined into a finding's
 * detail string and compared against the Python engine's output.
 */

export const SECURITY_VENDOR_TERMS: readonly string[] = [
  'penetration testing', 'pentest', 'vulnerability management', 'siem',
  'threat detection', 'endpoint protection', 'compliance automation',
  'security posture', 'cspm', 'cnapp', 'web application firewall',
  'zero trust', 'bug bounty', 'soc 2 automation', 'attack surface',
]

export const SECURITY_TEAM_TERMS: readonly string[] = [
  'security engineer', 'head of security', 'ciso', 'security team',
  'application security engineer', 'appsec engineer',
]

export const COMPLIANCE_TERMS: readonly string[] = [
  'soc 2', 'soc2', 'iso 27001', 'iso27001', 'hipaa', 'pci dss', 'fedramp', 'gdpr compliant',
]

/**
 * A claim that does NOT by itself mean a security programme. GDPR is a legal
 * regime everyone claims; HIPAA is sector-specific. Neither answers the
 * question a SOC 2 claim answers, so they do not clear compliance_claim.
 */
export const SOFT_COMPLIANCE_TERMS: readonly string[] = ['gdpr compliant', 'hipaa']

/** (library, minimum-safe version, note). Conservative floors — clear laggards only. */
export const OUTDATED_JS: Readonly<Record<string, { floor: readonly [number, number, number]; note: string }>> = {
  jquery: { floor: [3, 6, 0], note: 'jQuery below 3.6 carries published XSS advisories' },
  bootstrap: { floor: [5, 0, 0], note: 'Bootstrap 4.x is end-of-life' },
  lodash: { floor: [4, 17, 21], note: 'lodash below 4.17.21 has prototype-pollution CVEs' },
  angular: { floor: [12, 0, 0], note: 'AngularJS / early Angular is out of support' },
  moment: { floor: [99, 0, 0], note: 'moment.js is in maintenance mode — a modernisation hook' },
}

/** Mirrors Python's VERSION_IN_URL, including its case-insensitive flag. */
export const VERSION_IN_URL =
  /\/(jquery|bootstrap|angular|lodash|moment)[-./@]?v?(\d+)\.(\d+)(?:\.(\d+))?/i

/** TLS protocol names the engine treats as weak. */
export const WEAK_TLS_PROTOCOLS: readonly string[] = ['TLSv1', 'TLSv1.1']

/** Certificates expiring sooner than this many days count as a gap. */
export const TLS_EXPIRY_WARN_DAYS = 21
