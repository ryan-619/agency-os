/**
 * Every typed query, in one import.
 *
 * This exists because of a build constraint rather than a design preference.
 * The package root (`index.ts`) also exports `paths.ts`, which resolves the
 * `migrations/` and `seed/` directories off disk — correct for the CLIs, and
 * unresolvable for Turbopack when the Next app imports it. So the web app
 * reaches the database through this subpath instead, and gets the queries
 * without dragging the filesystem in.
 *
 * Aggregating here rather than widening `repository.ts` keeps the dependency
 * one-way: `approvals.ts` and `chat.ts` import `AgencyDb` FROM `repository.ts`,
 * so having `repository.ts` re-export them would be a cycle.
 */
export * from './repository.js'
export * from './approvals.js'
export * from './chat.js'
export * from './agents.js'
export * from './campaigns.js'
export * from './connectors.js'
export * from './contacts.js'
export * from './deals.js'
export * from './booking.js'
export * from './proposals.js'
export * from './meetings.js'
export * from './calls.js'
export * from './outreach.js'
// NOT './smtp.js'. This subpath exists so the Next app can import queries
// without dragging in `paths.ts` and the migrations directory (CLAUDE.md §4),
// and the same logic applies to nodemailer: the web app queues messages, the
// worker sends them, and a transport that can deliver has no business in the
// module graph CI builds with no secrets.
export * from './secrets.js'
export * as schema from './schema.js'
