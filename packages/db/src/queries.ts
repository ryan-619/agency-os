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
export * from './assistant.js'
export * from './connector-reads.js'
export * from './agents.js'
export * from './campaigns.js'
export * from './connectors.js'
export * from './org.js'
export * from './contacts.js'
export * from './deals.js'
export * from './booking.js'
export * from './proposals.js'
export * from './meetings.js'
export * from './calls.js'
export * from './outreach.js'
// A stop whose recording threw, as the webhooks and the IMAP inbox both read it.
export * from './inbound-fault.js'
export * from './send-preview.js'
export * from './pg-errors.js'
export * from './contacts-ledger.js'
export * from './contacts-import.js'
export * from './companies.js'
export * from './evidence.js'
export * from './rescan.js'
export * from './audit.js'
export * from './credentials.js'
export * from './heartbeat-read.js'
export * from './inbox.js'
export * from './enrolment.js'
export * from './search.js'
export * from './analytics.js'
export * from './chat-threads.js'
export * from './exports.js'
export * from './users.js'
export * from './compliance.js'
export * from './notes.js'
export * from './tasks.js'
export * from './opportunities.js'
export * from './unsubscribe.js'
export * from './icp-profiles.js'
export * from './spend.js'
export * from './digest.js'
export * from './linkedin-step.js'
export * from './proposal-shares.js'
export * from './erasure.js'
export * from './connector-tools.js'
// DoveSoft (0019): the registered templates, and the SMS draft, delivery and inbound recorders.
export * from './templates.js'
export * from './sms.js'
// NOT './smtp.js'. This subpath exists so the Next app can import queries
// without dragging in `paths.ts` and the migrations directory (CLAUDE.md §4),
// and the same logic applies to nodemailer: the web app queues messages, the
// worker sends them, and a transport that can deliver has no business in the
// module graph CI builds with no secrets.
//
// NOT './heartbeat.js' and NOT './unsubscribe-mint.js', for the same reason
// in the other direction. `writeHeartbeat` is the worker's claim to be
// alive; a web bundle that could write one is a fake-liveness oracle. The
// unsubscribe token is minted from a secret the worker holds; a bundle that
// could mint one could unsubscribe anyone. The web reads heartbeats through
// `heartbeat-read.js` and VERIFIES tokens through `unsubscribe.js`.
// `test/barrel.test.ts` asserts the split.
export * from './secrets.js'
export * as schema from './schema.js'
