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
import type { AgencyToolName, Draft, IcpDefinition, Principal, SiteProfile } from '@agency/core'
import type { AgencyDb, SiteAuditResult } from '@agency/db'

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
  /**
   * The worker's own view of itself, for the ops tools (ops.ts) — what chat
   * offers in place of a terminal. Present when the worker runs the turn;
   * absent anywhere else, and every tool that reads it still answers what it
   * can from the database and says the worker's own view is not available.
   */
  readonly ops?: OpsContext
  /**
   * Polishes an opener before it is drafted — the worker's model when one is
   * configured (§5.5's `draft_outreach`, through `refineDraft`, which keeps
   * every observed claim or hands the words back unchanged). Absent, the
   * template stands. The signal ends the model call when the tool's time
   * budget runs out.
   */
  readonly refineOpener?: (draft: Draft, signal: AbortSignal) => Promise<Draft>
  /**
   * Google Maps search (2026-10-08), built once at boot when the worker holds
   * GOOGLE_API_KEY. Absent, `find_businesses` says how to switch it on.
   */
  readonly places?: PlacesClient
  /** Google PageSpeed Insights, built once at boot; works keyless at a low quota. */
  readonly pagespeed?: PageSpeedClient
}

// ---------------------------------------------------------------------------
// Google, as the opportunity tools see it (2026-10-08)
// ---------------------------------------------------------------------------

/** One business as its Google Maps listing describes it. */
export interface PlaceListing {
  readonly placeId: string
  readonly name: string
  readonly address: string | null
  /** As Google gives it, e.g. "+91 80 4123 4567". */
  readonly phone: string | null
  /** The website the listing names — maybe a Facebook page or a directory entry. */
  readonly website: string | null
  readonly rating: number | null
  readonly reviews: number | null
  /** The primary type, e.g. `dentist`. */
  readonly category: string | null
  readonly mapsUrl: string | null
  readonly status: 'operational' | 'closed_temporarily' | 'closed_permanently' | null
}

export interface PlacesClient {
  /** Searches allowed per org per UTC day — each costs the agency money past Google's free tier. */
  readonly dailyLimit: number
  search(
    args: { readonly query: string; readonly pageToken?: string; readonly regionCode?: string },
    signal?: AbortSignal,
  ): Promise<{ readonly places: readonly PlaceListing[]; readonly nextPageToken: string | null }>
}

export interface PageSpeedClient {
  /**
   * Measure one page from Google's side. A page Lighthouse could not load is
   * an `ok: false` result with its reason — never a throw, never a score. A
   * throw is the SERVICE failing (quota, key, network), and records nothing.
   */
  run(
    args: { readonly url: string; readonly strategy: 'mobile' | 'desktop' },
    signal?: AbortSignal,
  ): Promise<SiteAuditResult>
}


// ---------------------------------------------------------------------------
// The worker, as the ops tools see it (2026-10-06)
// ---------------------------------------------------------------------------

/**
 * The worker's health, from the same object `/readyz` answers from
 * (`healthInputs()` in apps/agent/src/worker.ts). Configuration facts and
 * instants only — never a host, a URL, an address or a credential (§2.3).
 */
export interface OpsHealth {
  /** The gate's latched halt: a tool ran that was never authorised. A halted runtime refuses every turn. */
  readonly halted: boolean
  /** The single-worker advisory lock: held, lost (`false`), or not yet taken (`null`). */
  readonly lockHeld: boolean | null
  /** The MAILBOX, in `/readyz`'s vocabulary. Says nothing about SMS. */
  readonly outreach: 'disabled' | 'send-only' | 'send-and-receive' | 'receive-only'
  /** SMS through DoveSoft: on with both DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID where the worker runs. */
  readonly sms: 'on' | 'off'
  /** Whether the worker can reach a model. Never which credential. */
  readonly chat: 'enabled' | 'disabled'
  /** Stamped after the single-worker lock, like everything else at boot. */
  readonly bootedAt: Date
  /** The package version when the worker was started through npm; null under `node dist/index.js`. */
  readonly version: string | null
  /** When this worker's heartbeat last REACHED the database, or null when none has. */
  readonly heartbeatWrittenAt: Date | null
}

/**
 * One kind of warning or error the worker logged: the line's message, its
 * level, how often and when — and its `error` field only when that is an
 * error CLASS or an upper-case CODE. No other field and no other value is
 * ever kept, because a field can carry an id, a host or a reason (§2.3).
 */
export interface OpsLogEntry {
  readonly level: 'warn' | 'error'
  readonly msg: string
  readonly count: number
  readonly firstAt: Date
  readonly lastAt: Date
  readonly error?: string
}

/**
 * The scanner `rescan_stale` calls: `scanDomain`, bound by the worker to the
 * nightly rescan's tighter timeouts. A test passes a fake, so no test
 * touches the network.
 */
export type OpsScan = (
  domain: string,
  definition: IcpDefinition,
  opts: { readonly company?: string },
) => Promise<{ readonly raw: unknown; readonly profile: SiteProfile }>

export interface OpsContext {
  /** Read fresh on every call: the halt, the lock and the heartbeat move while the worker runs. */
  health(): OpsHealth
  /** The worker's recent warnings and errors, most recently seen first. */
  recentLog(): readonly OpsLogEntry[]
  readonly scan?: OpsScan
}

/**
 * What one tool call may spend on the clock before it answers. The adapter
 * gives every call a hard 30 s (`TOOL_TIMEOUT_MS` in apps/agent's
 * mcp/agency.ts), and a call cut off there tells the model nothing — so a
 * tool that waits on the network answers inside this budget and says what
 * is still running. apps/agent's tests hold it below the adapter's limit.
 */
export const TOOL_TIME_BUDGET_MS = 25_000

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
