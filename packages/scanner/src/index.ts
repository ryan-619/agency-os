/**
 * packages/scanner — the public-surface signal collector (PROMPT.md §3, §8.3).
 *
 * Split deliberately in two:
 *   fetch.ts    does the I/O and records exactly what came back
 *   extract.ts  is pure and turns that recording into observations
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
