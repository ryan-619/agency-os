/**
 * packages/core — domain logic.
 *
 * PROMPT.md §3: this package must have no dependency on Next.js, the Agent SDK,
 * or any HTTP framework, and no I/O. Domain rules are testable in isolation.
 * That constraint is enforced by a test in this package (see test/no-io.test.ts)
 * and by the dependency list in package.json, which is empty on purpose.
 *
 * What lands here, and when:
 *   Phase 0  authorisation (`can`), log redaction (`redact`)
 *   Phase 1  the ICP definition (`icp`) and scoring (`scoring`)
 *   Phase 1  scoring, tiering, disqualifiers, the `observed` rule — DONE
 *   Phase 2  risk classification for the agent's approval gate (§5.4)
 *   Phase 4  consent, suppression, quiet hours, daily caps — the send path (§8.4)
 *   Phase 6  the voice rules — AI disclosure, spoken opt-out, handoff (§2.1, §8.5)
 *   §5.5     the model seam — who may see a lead's words (llm/provider.ts)
 */
export * from './authz.js'
export * from './redact.js'
export * from './icp.js'
export * from './risk.js'
export * from './chat-events.js'
export * from './freshness.js'
export * from './scoring.js'
export * from './draft.js'
export * from './normalise.js'
export * from './send.js'
export * from './proposal.js'
export * from './brief.js'
export * from './voice.js'
export * from './llm/provider.js'
