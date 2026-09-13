/**
 * The `query()` options, and the things deliberately left out of them.
 *
 * PROMPT.md §2.4 says the approval gate is `canUseTool`. The installed SDK
 * documents three ways `canUseTool` is never consulted at all, each with its
 * own warning string inside `sdk.mjs`:
 *
 *   (a) `permissionMode: 'bypassPermissions'` — "auto-approves every tool call
 *       (except explicit deny rules) before the callback is consulted";
 *   (b) any BARE `allowedTools` entry, meaning one containing no "(" — which
 *       includes a wildcard like `mcp__apollo__*` — "auto-approve the whole
 *       tool before the callback is consulted";
 *   (c) "Allow rules from settings files can also shadow the callback but are
 *       not visible here."
 *
 * PROMPT.md §6 recommends (b) for connectors and for Skill, and §7 recommends
 * it for Agent. §2 is labelled "hard constraints" and wins, so this file
 * refuses all three and the divergence is written down in CLAUDE.md rather
 * than hidden. The cost is real: delegation and every connector tool now go
 * through the gate. That friction is the feature.
 *
 * Two further layers sit above configuration, because configuration drifts:
 * the `managedSettings` policy tier below, and the `PreToolUse` hook that
 * forces a prompt for anything above low risk.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * Every option key this application is allowed to set.
 *
 * Frozen and asserted by a test, so an SDK upgrade that introduces a new
 * permission knob cannot be adopted silently — and a contributor who wants one
 * has to edit this array in the same commit that uses it, where a reviewer
 * will see it. See the table in CLAUDE.md for what each omission prevents.
 */
export const ALLOWED_OPTION_KEYS = Object.freeze([
  'abortController',
  'agents',
  'allowDangerouslySkipPermissions',
  'allowedTools',
  'canUseTool',
  'cwd',
  'disallowedTools',
  'env',
  'hooks',
  'includePartialMessages',
  'managedSettings',
  'maxBudgetUsd',
  'maxTurns',
  'mcpServers',
  'model',
  'permissionMode',
  'permissionPrompts',
  'resume',
  'settingSources',
  'strictMcpConfig',
  'systemPrompt',
  'tools',
] as const)

/**
 * Tool names denied outright, belt-and-braces with `tools: []`.
 *
 * `disallowedTools` is documented as removing a tool "from the model's context
 * [so it] cannot be used, even if it would otherwise be allowed" — which is a
 * stronger statement than `tools: []`, whose default set is baked into a
 * shipped binary and cannot be enumerated from the types. Listing them means
 * the model is never even offered a shell.
 */
export const FORBIDDEN_TOOLS: readonly string[] = [
  'Bash', 'BashOutput', 'KillShell', 'KillBash',
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch',
  'Skill', 'SlashCommand', 'REPL', 'Workflow', 'Artifact',
]

export interface BuildOptionsInput {
  readonly canUseTool: Options['canUseTool']
  readonly mcpServers: NonNullable<Options['mcpServers']>
  /**
   * The subagents from `agent_defs` (§7).
   *
   * Built by `runtime/agents.ts` against a FROZEN key whitelist, never spread
   * from a row: `AgentDefinition` accepts `permissionMode` in this SDK
   * version, so a spread would make "add a subagent" a way to set
   * `bypassPermissions` from a web form — the first of the three documented
   * ways to skip `canUseTool` entirely.
   */
  readonly agents: NonNullable<Options['agents']>
  readonly hooks: NonNullable<Options['hooks']>
  readonly systemPrompt: string
  readonly cwd: string
  readonly abortController: AbortController
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  /** The SDK session to continue, if this thread has one (§5.3). */
  readonly resume?: string | undefined
  readonly model?: string | undefined
  /** Passed explicitly so nothing else in the process environment leaks in. */
  readonly env: Record<string, string | undefined>
}

export function buildQueryOptions(input: BuildOptionsInput): Options {
  const options: Options = {
    // --- what the agent may do -------------------------------------------
    //
    // No built-in tools at all. The agent reaches the database through the
    // `agency` MCP server and nothing else (§6: "never by writing SQL through
    // a Bash tool"). This also settles a question the SDK's types cannot
    // answer — what IS in the default tool set — by making it irrelevant.
    tools: [],
    disallowedTools: [...FORBIDDEN_TOOLS],
    mcpServers: input.mcpServers,
    // Only servers declared here. Without it, an `.mcp.json` on disk would add
    // servers nobody registered in the connectors table.
    strictMcpConfig: true,
    // §7's subagents. Note what is NOT done alongside this: §7 says to include
    // "Agent" in allowedTools "so delegation does not stall on approval". That
    // is a bare entry, which auto-approves before the gate is consulted — and
    // it would not stall anything anyway, because `canUseTool` answers
    // delegation itself, in milliseconds, without a human (classifyRisk rates
    // it `medium`, and the gate's medium path is a card, not a block).
    agents: input.agents,

    // --- the gate ---------------------------------------------------------
    canUseTool: input.canUseTool,
    // EMPTY, and it must stay empty. A bare entry here — including the
    // `mcp__server__*` wildcard §6 recommends and the "Agent" §7 recommends —
    // auto-approves before canUseTool is consulted.
    allowedTools: [],
    permissionMode: 'default',
    permissionPrompts: 'host',
    allowDangerouslySkipPermissions: false,
    hooks: input.hooks,

    /**
     * The policy tier, above configuration.
     *
     * `managedSettings` is filtered restrictive-only by the SDK, and exactly
     * two keys survive that matter here:
     *
     *  - `allowManagedPermissionRulesOnly` — documented as "permission rules
     *    from user, project, local, and --settings files AND ALLOW RULES FROM
     *    --allowedTools are ignored". That closes (b) and (c) together, even
     *    if someone later adds a bare entry to the array above.
     *  - `permissions.disableBypassPermissionsMode: 'disable'` — closes (a).
     *
     * Do not add `permissions.defaultMode` here: the filter drops it silently,
     * so it would read as protection that is not there.
     *
     * The caveat, recorded rather than hidden: this tier is skipped on a
     * machine that already has an IT-managed settings tier. On the agency's
     * own VPS there is none. It is a lock, not a proof — which is why the
     * ledger below the SDK exists as well.
     */
    managedSettings: {
      allowManagedPermissionRulesOnly: true,
      permissions: { disableBypassPermissionsMode: 'disable' },
    },

    // --- what the agent is told -------------------------------------------
    //
    // A plain string, not the `claude_code` preset: that preset describes a
    // coding agent's tools, and `tools: []` has just removed every one of
    // them. Telling the model about tools it does not have is how it spends a
    // turn trying to read a file.
    systemPrompt: input.systemPrompt,
    // EMPTY. Omitting it loads every settings source, and an allow rule in one
    // of them shadows the gate invisibly.
    settingSources: [],

    // --- limits -----------------------------------------------------------
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    includePartialMessages: true,
    abortController: input.abortController,
    cwd: input.cwd,
    // Set explicitly, which REPLACES the subprocess environment rather than
    // inheriting it. The worker's own environment holds DATABASE_URL and the
    // API key; the child needs the key and nothing else (§2.3).
    env: input.env,
  }

  if (input.resume !== undefined) options.resume = input.resume
  if (input.model !== undefined) options.model = input.model
  return options
}

/**
 * The environment the SDK subprocess gets.
 *
 * §2.3: no credential in an agent's context window. The subprocess needs the
 * API key to authenticate and nothing else — in particular not DATABASE_URL,
 * which would be one `Bash('env')` away from the model if a future change ever
 * re-enabled a shell.
 */
export function childEnv(apiKey: string): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: apiKey,
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    // The SDK writes transcripts under the config dir; without a writable one
    // in the container, `resume` has nowhere to read from.
    CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'],
    // Bound a subagent fan-out (§7).
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: process.env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'] ?? '3',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: process.env['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'] ?? '2',
  }
}

/**
 * What the agent is told about itself.
 *
 * Written as product copy rather than configuration, because every line here
 * is a rule the model will follow or break in front of a customer. The
 * constraints restated are the ones §2 says must never be violated, and
 * restating them costs a few hundred tokens a turn — cheap next to one email
 * quoting a finding nobody observed.
 */
export function systemPrompt(orgName: string, icpLabel: string | null): string {
  return [
    `You are the agent inside Agency OS, the internal tool of ${orgName} — a small application-security`,
    'and DevSecOps consultancy. You help the team find, qualify and approach companies that need their work.',
    '',
    'WHAT YOU CAN SEE',
    'You reach the CRM only through the agency tools. There is no shell, no filesystem and no web browser.',
    icpLabel
      ? `The active ideal-customer profile is "${icpLabel}". Call get_icp before judging fit, so you use the`
      : 'No ideal-customer profile is configured, so you cannot judge fit until someone creates one.',
    icpLabel ? "team's own weighting rather than your own intuition." : '',
    '',
    'WHAT "THE PIPELINE" MEANS HERE',
    'The pipeline is the companies already in the CRM. search_companies reads it. Deal stages and a kanban',
    'board do not exist yet, so if someone asks about deals, say that and offer the company list instead.',
    '',
    'EVIDENCE — THE RULE THAT MATTERS MOST',
    'Never state a security finding you have not read from a tool result. If a scan could not observe',
    'something, it is absent from what you are given, and absence means UNKNOWN, not "they are fine" and not',
    '"they are missing it". Findings carry the date they were observed; anything marked stale must be',
    're-verified with score_company before you repeat it to anyone. Everything the scanner sees is on the',
    "company's own public pages — describe it as a review from the outside, never as a security test, and",
    'never imply you probed anything.',
    '',
    'ACTIONS THAT LEAVE THE BUILDING',
    'Cold outreach is email and LinkedIn only. You cannot send anything: queue_touch writes a draft that a',
    'person has to read and approve, and a human is asked before it is even written. If someone denies a',
    'request, report that plainly and do not try a different route to the same thing.',
    '',
    'HOW TO ANSWER',
    'Be concise and concrete. Prefer a short list of companies with their scores over a paragraph about them.',
    'When you make a claim about a company, say which finding it came from and when it was observed.',
    'Say plainly when you do not know something or when a tool could not answer.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}
