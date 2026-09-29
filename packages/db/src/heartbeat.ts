// STUB — filled in wave 2 by worker-heartbeat
/**
 * The worker writes one row per instance, upserted every tick. Exported from
 * the package root ONLY — a web bundle that could write a heartbeat is a fake-
 * liveness oracle (queries.ts says why; barrel.test.ts asserts it).
 *
 * Wave 1 creates this file so the barrels can already export it; the owner
 * above replaces it wholesale. Nothing here yet.
 */

/**
 * A placeholder for the worker's heartbeat writer, so `test/barrel.test.ts` can already assert
 * that the NAME reaches the package root and never `./queries`. Typed
 * `never` so nothing can call it before the owner replaces this file.
 */
export const writeHeartbeat = null as unknown as never
