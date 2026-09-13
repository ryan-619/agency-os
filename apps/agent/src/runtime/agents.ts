/**
 * Turning `agent_defs` rows into the SDK's `agents` option (PROMPT.md §7).
 *
 * §7 gives the mapping in four lines:
 *
 *     agents = Object.fromEntries(rows.map((r) => [r.slug, {
 *       description: r.description, prompt: r.system_prompt,
 *       tools: r.tools, model: r.model,
 *     }]))
 *
 * That is right, and it is not enough, because of what ELSE `AgentDefinition`
 * accepts in this SDK version. Read from `sdk.d.ts` in this tree, a definition
 * may also carry:
 *
 *     permissionMode      'bypassPermissions' — the FIRST documented way to
 *                         skip canUseTool entirely, per subagent
 *     disallowedTools     could remove the agency tools from an agent
 *     mcpServers          a server this org never registered
 *     maxTurns            past the turn bound §5.4 sets
 *     background          fire-and-forget: a turn that ends while work goes on
 *     memory              loads files from disk into the agent's context
 *     skills, effort, observer, initialPrompt, criticalSystemReminder_…
 *
 * A row in `agent_defs` is written through a web form by an owner. A spread of
 * the row into the definition — or a later, innocent-looking `...extra` —
 * would make "add a subagent" a way to turn the approval gate off for
 * everything that subagent does. So this file whitelists, and the whitelist is
 * FROZEN and asserted key by key in a test: an SDK upgrade that adds another
 * permission knob cannot be adopted here silently.
 *
 * The four keys §7 names are the four keys that exist. Nothing else is set,
 * and nothing else can be.
 */
import type { AgentDefRow } from '@agency/db'
import type { Logger } from '../logger.js'

/** Exactly what a database row may set. Frozen; see the test. */
export const ALLOWED_AGENT_KEYS = Object.freeze([
  'description',
  'prompt',
  'tools',
  'model',
] as const)

export type BuiltAgent = {
  readonly description: string
  readonly prompt: string
  readonly tools?: string[]
  readonly model?: string
}

/**
 * The models a row may name.
 *
 * An alias rather than a full model id, and an allow-list rather than a free
 * string: `model` is passed to the SDK, and a typo produces a failure at the
 * first delegation with no indication it came from a settings screen. The
 * aliases are the SDK's own.
 */
const MODEL_ALIASES: ReadonlySet<string> = new Set(['fable', 'opus', 'sonnet', 'haiku', 'inherit'])

export interface AgentsResult {
  readonly agents: Record<string, BuiltAgent>
  readonly skipped: readonly { readonly slug: string; readonly why: string }[]
}

/**
 * Build the `agents` option from this org's enabled definitions.
 *
 * Like the connector builder: a row that cannot be used is skipped and logged,
 * never thrown on. One malformed subagent must not take the whole chat down.
 */
export function buildAgents(rows: readonly AgentDefRow[], log: Logger): AgentsResult {
  const agents: Record<string, BuiltAgent> = {}
  const skipped: { slug: string; why: string }[] = []

  for (const row of rows) {
    if (!row.enabled) continue

    const why = unusable(row)
    if (why) {
      skipped.push({ slug: row.slug, why })
      log.warn('subagent skipped', { slug: row.slug, why })
      continue
    }

    // Built key by key. NOT a spread of the row, and not a spread of anything.
    const built: BuiltAgent = {
      description: row.description,
      prompt: row.systemPrompt,
      // Omitted entirely when empty: the SDK reads an absent `tools` as
      // "inherit the parent's", and an EMPTY ARRAY as "no tools at all" — a
      // subagent that can do nothing but talk. A row with no tools listed
      // means the author did not narrow it, not that they silenced it.
      ...(row.tools.length > 0 ? { tools: [...row.tools] } : {}),
      ...(row.model ? { model: row.model } : {}),
    }
    agents[row.slug] = built
  }

  return { agents, skipped }
}

/** Why this row cannot be used, or null. */
function unusable(row: AgentDefRow): string | null {
  if (!row.slug.trim()) return 'it has no slug'
  if (!row.description.trim()) {
    // The model reads the description to decide when to delegate. An empty one
    // produces a subagent that is either never used or used for everything.
    return 'it has no description, so the model cannot tell when to use it'
  }
  if (!row.systemPrompt.trim()) return 'it has no system prompt'
  if (row.model && !MODEL_ALIASES.has(row.model)) {
    return `"${row.model}" is not a model alias (${[...MODEL_ALIASES].join(', ')})`
  }
  return null
}
