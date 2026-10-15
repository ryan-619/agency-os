/**
 * packages/scanner — the public-surface signal collector (PROMPT.md §3, §8.3).
 *
 * Split deliberately in two:
 *   fetch.ts    does the I/O and records exactly what came back
 *   extract.ts  is pure and turns that recording into observations
 *
 * Beside the scan, two readers the assistant uses before it stores anything
 * (2026-10-13): read-page.ts reads one public page through the same fetch
 * machinery, and dns-answers.ts says whether a domain receives mail and
 * whether a name resolves to the public internet.
 *
 * That split is what makes the port checkable against the Python engine it
 * came from: identical recorded bytes must produce identical findings.
 */
export * from './types.js'
export * from './terms.js'
export * from './html.js'
export * from './extract.js'
export * from './additive.js'
export * from './presence.js'
export * from './fetch.js'
export { NonPublicAddressError, isPublicAddress, publicOnlyLookup } from './address.js'
export { scanDomain } from './scan.js'
export {
  readPublicPage, READ_PAGE_TIMEOUT_MS, READ_PAGE_TOTAL_MS, READ_PAGE_MAX_DECODED_BYTES,
  type PageRead, type ReadPageOptions,
} from './read-page.js'
export {
  mailHostsOf, domainResolves, DNS_TIMEOUT_MS,
  type MailHosts, type DomainAnswer, type DnsResolverLike, type DnsAnswerOptions, type MxAnswer,
} from './dns-answers.js'
