// STUB — filled in wave 2 by unsubscribe-link
/**
 * The MINT half: `${touchId}.${hmac}` from the shared secret. Exported from
 * the package root ONLY — a web bundle that could mint a token could
 * unsubscribe anyone (queries.ts says why; barrel.test.ts asserts it).
 *
 * Wave 1 creates this file so the barrels can already export it; the owner
 * above replaces it wholesale. Nothing here yet.
 */

/**
 * A placeholder for the unsubscribe-token minter, so `test/barrel.test.ts` can already assert
 * that the NAME reaches the package root and never `./queries`. Typed
 * `never` so nothing can call it before the owner replaces this file.
 */
export const unsubscribeToken = null as unknown as never
