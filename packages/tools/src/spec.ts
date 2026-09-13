/**
 * The shape of an agency tool.
 *
 * These are the tools PROMPT.md §6 says the agent reaches the database
 * through — "never by writing SQL through a Bash tool". They are declared here
 * as PLAIN DATA, with no import of the Agent SDK anywhere in this package, for
 * three reasons that all point the same way:
 *
 *  1. The SDK ships no mock transport and no recorded-session mode, so
 *     anything that needs the SDK to be *defined* is also something that
 *     cannot be unit-tested. SDK-free specs mean every handler is tested
 *     directly against a real Postgres engine, like the repository tests.
 *  2. A package that CANNOT import the SDK cannot drag it into the Next
 *     module graph, whatever anyone writes later — and CI builds the web app
 *     with no secrets on purpose.
 *  3. The adapter that turns these into `createSdkMcpServer` tools is then
 *     about thirty lines in one file, which is a thing a person can read in
 *     full before trusting it.
 *
 * Every handler here obeys the same four rules, and the tests assert them
 * rather than trusting the prose:
 *
 *  - `orgId` comes from the context, NEVER from the model. There is no
 *    argument a model could set to reach another org's data.
 *  - A finding whose `observed` is not true is dropped before anything is
 *    serialised. §2.2: the model's context is a rendering, and §12 forbids
 *    rendering a finding nobody observed.
 *  - Freshness is derived from the scan's `ran_at`, never read from
 *    `findings.stale` — that column is a cache written only when a scan runs.
 *  - Output is bounded, with an explicit marker when rows were omitted, so a
 *    wide query degrades into a narrower answer rather than into a context
 *    window full of one table.
 */
import type { ZodObject, ZodRawShape, infer as ZodInfer } from 'zod'
import type { AgencyToolName, Principal } from '@agency/core'
import type { AgencyDb } from '@agency/db'

/** What a tool is allowed to know. Assembled by the worker, per turn. */
export interface ToolContext {
  readonly db: AgencyDb
  /** The org of the signed-in person whose chat this is. Never model-supplied. */
  readonly orgId: string
  readonly principal: Principal
  readonly turnId: string
  readonly now: () => Date
  /** §5.4: approval decides, the audit log remembers. */
  readonly audit: (action: string, detail: Record<string, unknown>) => Promise<void>
}

export type ToolErrorCode =
  | 'not_found'
  | 'unreachable'
  | 'invalid_state'
  | 'no_fresh_evidence'
  | 'not_permitted'

export type ToolOutcome<T> =
  | { readonly ok: true; readonly data: T; readonly summary: string }
  | { readonly ok: false; readonly code: ToolErrorCode; readonly message: string }

export function ok<T>(data: T, summary: string): ToolOutcome<T> {
  return { ok: true, data, summary }
}

export function fail<T = never>(code: ToolErrorCode, message: string): ToolOutcome<T> {
  return { ok: false, code, message }
}

export interface AgencyToolSpec<S extends ZodRawShape = ZodRawShape, T = unknown> {
  /**
   * `keyof AGENCY_TOOL_RISK`. A tool whose name is not in the risk registry
   * does not compile — which is what stops a tool from becoming reachable
   * without also being classified.
   */
  readonly name: AgencyToolName
  /** The model reads this to decide when to call the tool. It is product copy. */
  readonly description: string
  /** The SDK's `tool()` takes a RAW shape, not a `z.object(...)`. */
  readonly shape: S
  handler(input: ZodInfer<ZodObject<S>>, ctx: ToolContext): Promise<ToolOutcome<T>>
}

/**
 * The text budget for one tool result.
 *
 * A tool that answers "which companies are in the pipeline" with two hundred
 * rows spends the turn's context on one table and leaves nothing for the
 * reasoning the person actually asked for. Truncation is visible on purpose:
 * a model that can see it was truncated asks a narrower question, and a model
 * that cannot see it answers confidently from a prefix.
 */
export const TOOL_TEXT_BUDGET = 8_000

export function bounded(lines: readonly string[], budget = TOOL_TEXT_BUDGET): string {
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > budget) break
    kept.push(line)
    size += line.length + 1
  }
  const omitted = lines.length - kept.length
  if (omitted > 0) {
    kept.push(`… ${omitted} more row${omitted === 1 ? '' : 's'} omitted — narrow the filter.`)
  }
  return kept.join('\n')
}
