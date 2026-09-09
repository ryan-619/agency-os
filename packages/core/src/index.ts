/**
 * packages/core — domain logic.
 *
 * PROMPT.md §3: this package must have no dependency on Next.js, the Agent SDK,
 * or any HTTP framework, and no I/O. Domain rules are testable in isolation.
 * That constraint is enforced by a test in this package (see test/no-io.test.ts)
 * and by the dependency list in package.json, which is empty on purpose.
 *
 * What lands here, and when:
 *   Phase 0  authorisation (this file's `can`)
 *   Phase 1  scoring, tiering, disqualifiers, the `observed` rule
 *   Phase 2  risk classification for the agent's approval gate (§5.4)
 *   Phase 4  consent, suppression, quiet hours, daily caps — the send path (§8.4)
 */
export * from './authz.js'
