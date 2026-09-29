/**
 * How dangerous is this tool call?
 *
 * PROMPT.md §5.4 puts this decision in `packages/core` and says it is a pure
 * function, and that matters more here than anywhere else in the package: this
 * is the input to the approval gate, so it has to be decidable without a
 * database, a network, or an agent, and it has to be testable one row at a
 * time. No zod, no I/O, no environment reads — `test/no-io.test.ts` reads this
 * file and enforces that, by a blunt source scan that this comment must not
 * trip.
 *
 * The classifier returns a FLOOR. Nothing downstream lowers it. §5.4 describes
 * one carve-out — a high-risk send may skip the human "unless the campaign has
 * `auto_send` and the recipient has the matching consent and the suppression
 * check passes" — and all three of those are lookups this function may not do.
 * They belong to Phase 4's single send path, downstream of the gate, where the
 * consent and suppression tables exist. Until then every `high` needs a human.
 *
 * The hard case is the one that recurs: PROMPT.md §6 makes new MCP servers
 * addable from inside the running product, so this function will routinely be
 * handed a tool name nobody has ever seen. It therefore has no "unknown"
 * answer. Every path ends in a verdict, and the default direction is the safe
 * one — the same rule `can()` follows in authz.ts.
 */

export type Risk = 'low' | 'medium' | 'high'

/** Why a call was classified the way it was. One per branch, so a test table
 *  can name the branch it is exercising rather than matching on prose. */
export type RiskRule =
  | 'malformed_name'
  | 'forbidden_channel'
  | 'forbidden_tool'
  | 'unregistered_tool'
  | 'read_only'
  | 'derived_write'
  | 'writes_internal_state'
  | 'leaves_the_building'
  | 'delegation'
  | 'connector_unreviewed'

export interface ToolCall {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  /** The SDK's `options.agentID` / the hook's `agent_id`. Non-null inside a
   *  subagent. Recorded so an approval card can say who asked; it does NOT
   *  change the verdict — a subagent is not more trusted than its parent. */
  readonly agentId?: string | null
}

export interface RiskVerdict {
  readonly risk: Risk
  readonly rule: RiskRule
  /** One sentence, shown on the approval card and used as the deny message.
   *  Written for a human deciding in a hurry. Never contains the input. */
  readonly explain: string
  /**
   * True means no human may approve this: the gate denies outright and nobody
   * is asked. Reserved for calls that are forbidden rather than dangerous —
   * asking a person to approve something §2 forbids is how a policy becomes a
   * habit of clicking yes.
   */
  readonly refuse: boolean
}

// ---------------------------------------------------------------------------
// The Phase 2 agency tools
// ---------------------------------------------------------------------------

/**
 * Every tool the in-process `agency` MCP server exposes, with its risk.
 *
 * This is the registry, and `PERMITTED_TOOLS` below is DERIVED from it rather
 * than maintained alongside it — so a tool cannot become reachable without
 * also being classified. A tool added to the server but not to this table is
 * refused by rule 6, not quietly allowed.
 */
export const AGENCY_TOOL_RISK = {
  get_icp: ['low', 'read_only', 'Reads the active ICP definition.'],
  search_companies: [
    'low',
    'read_only',
    'Reads companies already in the CRM, with their latest scan’s score.',
  ],
  get_company: [
    'low',
    'read_only',
    'Reads one company and the findings its last scan actually observed.',
  ],
  scan_company: [
    'low',
    'derived_write',
    'Requests a company’s own public pages and records what came back.',
  ],
  score_company: [
    'low',
    'derived_write',
    'Returns a company’s current score, re-scanning only if the last scan has aged out.',
  ],
  queue_touch: [
    'high',
    'leaves_the_building',
    'Drafts a message intended for someone outside the company.',
  ],
  // Phase 5. §6 lists all three; Phase 2 withheld them because nothing wrote
  // the deals table yet and a tool that reliably returns [] teaches the model
  // a false shape of the business. Phase 4's send path writes deals now.
  get_pipeline: ['low', 'read_only', 'Reads the deal pipeline: every open deal, its stage and next action.'],
  update_deal: [
    'medium',
    'writes_internal_state',
    'Moves a deal to another stage or sets its next action. Nothing leaves the building.',
  ],
  book_meeting: [
    'medium',
    'writes_internal_state',
    'Records a meeting with a company and moves its deal to the meeting stage. Does not send an invitation.',
  ],
  // --- the fourteen tools of the enhancement, each named after the feature
  //     that implements it. Reads are low; internal writes are medium; nothing
  //     new leaves the building — `queue_touch` stays the only one that does.
  // consent-ledger-and-check-send
  check_send: ['low', 'read_only', 'Runs the send rules for one person and campaign, and reports the answer. Queues nothing.'],
  // consent-ledger-and-check-send
  get_consent: ['low', 'read_only', 'Reads the consent recorded per channel for one person, and any suppression that matches them.'],
  // evidence-and-reply-tools
  get_replies: ['low', 'read_only', 'Reads inbound replies with their kind, whether a teammate handled them, and the message each answered.'],
  // evidence-and-reply-tools
  classify_reply: ['medium', 'writes_internal_state', 'Records what kind of reply a message was, or that a person dealt with it. Never records an opt-out and sends nothing.'],
  // evidence-and-reply-tools
  get_scan_history: ['low', 'read_only', 'Reads every scan of a company with the score computed from each one.'],
  // evidence-and-reply-tools
  get_evidence_changes: ['low', 'read_only', 'Compares the two most recent successful scans of a company signal by signal.'],
  // evidence-and-reply-tools
  get_stale_companies: ['low', 'read_only', 'Lists companies whose evidence is stale, unreachable or missing, and why.'],
  // reporting-and-task-tools
  get_pipeline_metrics: ['low', 'read_only', 'Reads stage conversion, time in stage and win rate from the pipeline’s own history.'],
  // reporting-and-task-tools
  get_company_timeline: ['low', 'read_only', 'Reads everything that happened to one company, newest first, from the records that hold it.'],
  // reporting-and-task-tools
  get_compliance_summary: ['low', 'read_only', 'Reads the consent, suppression, refusal, disclosure and freshness counts the compliance page shows.'],
  // reporting-and-task-tools
  search_crm: ['low', 'read_only', 'Searches companies, people, deals, meetings and proposals by text, within what the caller may see.'],
  // reporting-and-task-tools
  add_note: ['medium', 'writes_internal_state', 'Writes a teammate-style note on a company. It is never evidence and nothing leaves the building.'],
  // reporting-and-task-tools
  create_task: ['medium', 'writes_internal_state', 'Creates a task for a teammate with an optional due date. Nothing is sent.'],
  // reporting-and-task-tools
  list_tasks: ['low', 'read_only', 'Reads open tasks, optionally one person’s or one company’s.'],
} as const satisfies Readonly<Record<string, readonly [Risk, RiskRule, string]>>

export type AgencyToolName = keyof typeof AGENCY_TOOL_RISK

export const AGENCY_TOOL_NAMES = Object.keys(AGENCY_TOOL_RISK) as readonly AgencyToolName[]

/** The fully-qualified MCP names of the agency tools. Derived, never listed. */
export const PERMITTED_TOOLS: ReadonlySet<string> = new Set(
  AGENCY_TOOL_NAMES.map((n) => `mcp__agency__${n}`),
)

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Channels cold outreach may never use (§2.1). Checked on EVERY tool, not just
 * the ones we know about, because the whole point of §6 is that we do not know
 * what tools there will be.
 */
const FORBIDDEN_CHANNELS: ReadonlySet<string> = new Set(['sms', 'voice', 'whatsapp', 'phone', 'call'])

/**
 * Built-ins that must never run here. This duplicates `tools: []` on the SDK
 * options on purpose: that is a configuration, configurations drift, and the
 * SDK's default tool set is baked into a shipped binary rather than declared
 * in its types — so it cannot be proved empty by reading anything. This is the
 * same rule with a test attached.
 *
 * §12: no shell, no raw SQL, no filesystem. `Skill` is here because a skill is
 * arbitrary instructions loaded off disk, and Phase 2 mounts no skills volume.
 */
const FORBIDDEN_BUILTINS: ReadonlySet<string> = new Set([
  'Bash', 'BashOutput', 'KillShell', 'KillBash',
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch',
  'Skill', 'SlashCommand', 'REPL', 'Workflow', 'Artifact',
])

/** The SDK's delegation tools. Named so they classify as delegation rather
 *  than falling through to "unregistered". */
const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

/**
 * The shape `connectors_name_is_a_valid_mcp_server_name` enforces in the
 * database. A server name outside it makes `mcp__<server>__<tool>` ambiguous
 * to parse, which is exactly the situation a gate must not guess its way out
 * of.
 */
const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
/** A tool name may not contain the `__` that separates the three parts. */
const MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export interface ParsedToolName {
  readonly source: 'agency' | 'connector' | 'builtin' | 'delegation' | 'malformed'
  readonly serverName: string | null
  readonly bareName: string
}

/**
 * Split a tool name into its parts. Total: every string yields a verdict and
 * nothing throws, because this runs inside a permission callback where an
 * exception is a hung turn rather than an error.
 */
export function parseToolName(name: string): ParsedToolName {
  if (typeof name !== 'string' || name.length === 0) {
    return { source: 'malformed', serverName: null, bareName: '' }
  }
  if (!name.startsWith('mcp__')) {
    if (DELEGATION_TOOLS.has(name)) return { source: 'delegation', serverName: null, bareName: name }
    return { source: 'builtin', serverName: null, bareName: name }
  }
  // `mcp__<server>__<tool>`. Exactly three parts: a tool name may not contain
  // `__`, so a fourth part is not a nested namespace, it is unparseable.
  const parts = name.slice('mcp__'.length).split('__')
  if (parts.length !== 2) return { source: 'malformed', serverName: null, bareName: '' }
  const server = parts[0] ?? ''
  const bare = parts[1] ?? ''
  if (!MCP_SERVER_NAME.test(server) || !MCP_TOOL_NAME.test(bare)) {
    return { source: 'malformed', serverName: null, bareName: '' }
  }
  return {
    source: server === 'agency' ? 'agency' : 'connector',
    serverName: server,
    bareName: bare,
  }
}

/** Does this input name a channel §2.1 forbids? Checked one level deep, which
 *  is where a `channel` field lives on every shape we define. */
function namesAForbiddenChannel(input: Readonly<Record<string, unknown>>): boolean {
  const value = input['channel']
  return typeof value === 'string' && FORBIDDEN_CHANNELS.has(value.trim().toLowerCase())
}

function verdict(risk: Risk, rule: RiskRule, explain: string, refuse = false): RiskVerdict {
  return { risk, rule, explain, refuse }
}

/**
 * Classify one tool call. See the table in CLAUDE.md §5 for the branch order;
 * it is the order below and each branch has a test.
 */
export function classifyRisk(call: ToolCall): RiskVerdict {
  const parsed = parseToolName(call.toolName)

  // 1. A name we cannot parse is a name we cannot reason about.
  if (parsed.source === 'malformed') {
    return verdict('high', 'malformed_name', 'The tool name could not be parsed.', true)
  }

  // 2. §2.1 and §12: cold voice and SMS must not be reachable through ANY code
  //    path, "including just for testing". Classifying this high would merely
  //    offer it to a human, and a human can say yes.
  if (namesAForbiddenChannel(call.input)) {
    return verdict(
      'high',
      'forbidden_channel',
      'Voice, SMS and WhatsApp are for inbound and recorded opt-in only; cold outreach is email and LinkedIn.',
      true,
    )
  }

  // 3. A built-in that would give the agent a shell, the filesystem or the web.
  if (parsed.source === 'builtin' && FORBIDDEN_BUILTINS.has(parsed.bareName)) {
    return verdict(
      'high',
      'forbidden_tool',
      `${parsed.bareName} is not available to this agent.`,
      true,
    )
  }

  // 4. Delegation. Medium, not low: a subagent is a fan-out of everything
  //    below, and it is the one place a budget runs away. Not refused —
  //    §7 is built on it.
  if (parsed.source === 'delegation') {
    return verdict('medium', 'delegation', 'Hands the task to a subagent, which will use tools of its own.')
  }

  // 5 & 6. Our own tools: classified, or refused for not being classified.
  if (parsed.source === 'agency') {
    const row = (AGENCY_TOOL_RISK as Readonly<Record<string, readonly [Risk, RiskRule, string]>>)[
      parsed.bareName
    ]
    if (row) return verdict(row[0], row[1], row[2])
    return verdict(
      'high',
      'unregistered_tool',
      'This agency tool has no risk classification, so it cannot be run.',
      true,
    )
  }

  // 7. A connector added at runtime (§6). Usable, but with a human on every
  //    call: nobody in this codebase has read its tools. Not refused — a
  //    connector that cannot be used is a connector registry that does nothing.
  if (parsed.source === 'connector') {
    return verdict(
      'high',
      'connector_unreviewed',
      `${parsed.serverName ?? 'This connector'} is a third-party server; its tools have not been reviewed.`,
    )
  }

  // 8. A built-in nobody listed. Fails closed.
  return verdict(
    'high',
    'unregistered_tool',
    `${parsed.bareName} is not a tool this agent is allowed to use.`,
    true,
  )
}
