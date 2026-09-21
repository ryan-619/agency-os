/**
 * packages/llm — the single-shot model clients (PROMPT.md §5.5).
 *
 * The INTERFACE and the rule about who may see a lead's words live in
 * `packages/core/src/llm/provider.ts`, which may perform no I/O. This
 * package is the half that makes requests. See CLAUDE.md §4.
 */
export * from './providers.js'
export * from './attempt.js'
