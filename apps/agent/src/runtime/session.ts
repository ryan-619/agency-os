/**
 * Assembling one turn's worth of runtime.
 *
 * Everything a turn needs — the gate, the ledger, the tool context, the MCP
 * server — is built PER TURN and thrown away after, and that is not an
 * accident of style. The ledger authorises specific calls in a specific turn,
 * the gate closes over that turn's session and approval rows, and the tool
 * context carries the org of the person whose chat this is. Sharing any of
 * them between turns would mean a grant issued for one conversation could
 * authorise a call in another.
 *
 * The one thing that is NOT per-turn is the bypass halt. If a tool ever runs
 * without a grant, the runtime has learned that its own gate is not being
 * consulted — and that is a statement about the process, not about the turn.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import { parseIcpDefinition, type ChatEventBody, type Draft, type Principal } from '@agency/core'
import {
  activeIcpProfile, appendAudit, enabledAgentDefs, ensureApproval, expireApproval, readApproval,
  readPlaybook, schema, type AgencyDb, type ApprovalRow,
} from '@agency/db'
import type { OpsContext, PageSpeedClient, PlacesClient, ToolContext } from '@agency/tools'
import { makeCanUseTool } from '../gate/can-use-tool.js'
import { createLedger } from '../gate/ledger.js'
import { makePostToolUse, makePreToolUse, HOOK_TIMEOUT_SECONDS } from '../gate/pre-tool-use.js'
import { abortableSleep, createApprovalWaiter } from '../gate/waiter.js'
import { createAgencyMcpServer, makeInputParser } from '../mcp/agency.js'
import { buildAgents } from './agents.js'
import { buildMcpServers, describeServers } from './connectors.js'
import { buildQueryOptions, childEnv, type AgentCredential, systemPrompt } from './options.js'
import type { Logger } from '../logger.js'

export interface RuntimeHalt {
  readonly halted: () => boolean
  /** Latched. A runtime that has seen an ungated call does not recover. */
  readonly halt: (reason: string) => void
}

export function createHalt(log: Logger): RuntimeHalt {
  let halted = false
  return {
    halted: () => halted,
    halt: (reason) => {
      if (halted) return
      halted = true
      // Deliberately not recoverable and deliberately loud. The gate being
      // bypassed is the one condition where continuing to serve turns is
      // worse than refusing them.
      log.error('HALTED: a tool ran that the approval gate never authorised', { reason })
    },
  }
}

export interface SessionDeps {
  readonly db: AgencyDb
  readonly log: Logger
  readonly halt: RuntimeHalt
  /** How the SDK subprocess authenticates — a key we hold, or the developer's own login. */
  readonly credential: AgentCredential
  /** Where the Claude Code binary is, when it is not on PATH. */
  readonly claudeCodePath?: string | undefined
  readonly model?: string | undefined
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  /**
   * The master key for third-party credentials, or null when SECRETS_KEY is
   * unset. Null means a connector that needs one is skipped with a reason
   * rather than connecting unauthenticated.
   */
  readonly secretsKey: Buffer | null
  /** Decided once at boot by `inspectSkillsRoot`; see runtime/skills.ts. */
  readonly skills: { settingSources: readonly 'project'[]; skills?: 'all' }
  readonly approvalTtlMs: number
  readonly approvalPollMs: number
  /**
   * The turn's own wall clock, used to clamp every approval this turn raises.
   *
   * The boot check that `AGENT_TURN_TIMEOUT_MINUTES > APPROVAL_TTL_MINUTES` is
   * necessary and NOT sufficient: the two clocks start at different moments.
   * An approval raised ten minutes into a 35-minute turn with a 30-minute TTL
   * would expire at minute 40, leaving five minutes in which a person sees a
   * live card, counting down, for a turn that is already gone.
   */
  readonly turnTimeoutMs: number
  readonly cwd: string
  readonly now: () => Date
  /**
   * The worker's view of itself — its health, its recent warnings and errors,
   * the scanner bound to the nightly rescan's timeouts — for the ops tools
   * (packages/tools/src/ops.ts). Built once by `startWorker` and handed to
   * every turn's tool context. Optional: a turn without it runs every tool,
   * and the ops tools say the worker's own view is not available.
   */
  readonly ops?: OpsContext | undefined
  /**
   * The worker's model polishing an opener (`refineDraft`), handed to every
   * turn's tool context when a model is configured (LLM_PROVIDER). Absent,
   * enrolment drafts keep the template.
   */
  readonly refineOpener?: ((draft: Draft, signal: AbortSignal) => Promise<Draft>) | undefined
  /**
   * Agency tools the SDK cannot describe to the model, decided once at boot
   * (`agencyToolsToOmit`) and left out of every turn's server — because one
   * such tool in the server takes every other tool's listing down with it.
   */
  readonly omitTools?: ReadonlySet<string> | undefined
  /** Google Maps search for `find_businesses`, built once at boot; absent without a key. */
  readonly places?: PlacesClient | undefined
  /** Google PageSpeed for `audit_website`, built once at boot. */
  readonly pagespeed?: PageSpeedClient | undefined
}

export interface TurnRuntime {
  readonly turnId: string
  /** Carries the in-process `agency` server and no connector (`buildQueryOptions`). */
  readonly options: Options
  /**
   * What the turn hands the CLI over its control channel before the prompt
   * (`runtime/open-query.ts`): every connector this turn has, with its
   * credential, and `agency` again — the same instance — because the hand-over
   * REPLACES the dynamic set and an in-process server missing from it is
   * disconnected. Empty when there are no connectors, and the turn runs
   * exactly as it did before connectors moved off the argv.
   */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>
  readonly abort: AbortController
}

/**
 * Build the options for one turn.
 *
 * `emit` is handed in rather than returned because the gate needs to push
 * approval cards into the same stream the turn is writing, and the turn does
 * not exist yet at this point.
 */
export async function buildTurnRuntime(
  deps: SessionDeps,
  args: {
    readonly orgId: string
    readonly orgName: string
    readonly chatSessionId: string
    readonly principal: Principal
    readonly resume: string | null
    readonly emit: (event: ChatEventBody) => void
    /**
     * Nobody is watching this turn — the morning brief. The gate declines,
     * at once and with no card, anything that would need a person.
     */
    readonly unattended?: boolean
  },
): Promise<TurnRuntime> {
  const turnId = randomUUID()
  const abort = new AbortController()
  const ledger = createLedger()
  const parseToolInput = makeInputParser()

  const audit = async (action: string, detail: Record<string, unknown>): Promise<void> => {
    try {
      await appendAudit(deps.db, {
        orgId: args.orgId,
        actor: 'agent',
        action,
        subjectType: 'chat_session',
        subjectId: args.chatSessionId,
        detail: { ...detail, turnId },
      })
    } catch (err) {
      // §5.4 says the audit log remembers, but a failed insert must not stop
      // the action it was recording — nor roll it back.
      deps.log.warn('audit write failed', {
        action,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }

  const waiter = createApprovalWaiter({
    read: (id) => readApproval(deps.db, args.orgId, id) as Promise<ApprovalRow | null>,
    expire: (id) => expireApproval(deps.db, args.orgId, id),
    now: deps.now,
    sleep: abortableSleep,
    pollMs: deps.approvalPollMs,
    readRetries: 5,
    log: deps.log,
  })

  /**
   * §6 and §7's promise, kept literally: read on every turn, never cached.
   *
   * "The owner adds an MCP server through the UI and the agent uses one of its
   * tools in the very next chat message, with no restart." A cache with any
   * TTL at all breaks that in a way nobody can debug from the outside — the
   * connector works, the row is right, and the agent cannot see it.
   *
   * Both builders SKIP a row they cannot use rather than throwing: one broken
   * connector must not take the whole chat down.
   */
  const [connectors, agentRows, playbook] = await Promise.all([
    buildMcpServers(deps.db, args.orgId, deps.secretsKey, deps.log),
    enabledAgentDefs(deps.db, args.orgId),
    // The agency's own words (Settings → Assistant), read fresh like the
    // rest. A read that fails costs the turn its playbook, never the turn.
    readPlaybook(deps.db, args.orgId).catch((err: unknown) => {
      deps.log.warn('could not read the playbook; this turn runs without it', {
        error: err instanceof Error ? err.name : 'UnknownError',
      })
      return ''
    }),
  ])
  const subagents = buildAgents(agentRows, deps.log, playbook)
  if (Object.keys(connectors.servers).length > 0 || Object.keys(subagents.agents).length > 0) {
    deps.log.info('runtime assembled from the database', {
      // Names and transports only. A connector URL can carry a token in a
      // query string despite every instruction not to put one there (§2.3).
      connectors: describeServers(connectors.servers),
      subagents: Object.keys(subagents.agents),
      ...(connectors.skipped.length > 0 ? { skippedConnectors: connectors.skipped } : {}),
      // Tool NAMES — what the gate will refuse this turn, and nothing else.
      ...(connectors.disabledTools.size > 0 ? { disabledTools: [...connectors.disabledTools] } : {}),
      ...(connectors.readsWithoutCard.size > 0 ? { readsWithoutCard: [...connectors.readsWithoutCard] } : {}),
      ...(subagents.skipped.length > 0 ? { skippedSubagents: subagents.skipped } : {}),
    })
  }

  const canUseTool = makeCanUseTool({
    orgId: args.orgId,
    chatSessionId: args.chatSessionId,
    turnId,
    ttlMs: deps.approvalTtlMs,
    turnDeadline: new Date(deps.now().getTime() + deps.turnTimeoutMs),
    now: deps.now,
    parseToolInput,
    ensureApproval: (req) =>
      ensureApproval(deps.db, {
        orgId: args.orgId,
        chatSessionId: args.chatSessionId,
        turnId,
        ...req,
      }),
    waiter,
    ledger,
    // Read with the connectors, on this turn: a tool an owner turns off is
    // refused from the very next message, the same promise §6 makes for a
    // server that is turned on.
    disabledTools: connectors.disabledTools,
    readsWithoutCard: connectors.readsWithoutCard,
    audit,
    emit: args.emit,
    markGated: () => {},
    halted: deps.halt.halted,
    log: deps.log,
    unattended: args.unattended === true,
  })

  const toolContext = (): ToolContext => ({
    db: deps.db,
    // From the signed-in person's session, never from the model. There is no
    // argument on any tool that could reach another org.
    orgId: args.orgId,
    principal: args.principal,
    turnId,
    now: deps.now,
    audit,
    // The worker's own view, the same object for every turn; never the model's to supply.
    ...(deps.ops ? { ops: deps.ops } : {}),
    // The worker's model for openers, when one is configured; the template stands otherwise.
    ...(deps.refineOpener ? { refineOpener: deps.refineOpener } : {}),
    // Google, the same clients for every turn; never the model's to supply.
    ...(deps.places ? { places: deps.places } : {}),
    ...(deps.pagespeed ? { pagespeed: deps.pagespeed } : {}),
  })

  const mcpServer = createAgencyMcpServer({
    context: toolContext,
    ledger,
    turnId: () => turnId,
    onBypass: (toolName) => {
      deps.halt.halt(`${toolName} ran without a grant`)
      args.emit({
        kind: 'error',
        code: 'bypass_detected',
        retryable: false,
        message:
          'A tool ran that the approval gate never authorised. The agent has been stopped. ' +
          'Tell an owner before using chat again.',
      })
    },
    log: deps.log,
    omit: deps.omitTools,
  })

  // The same set both rings refuse: the hook denies first, and canUseTool
  // denies again if the hook was ever not consulted.
  const hookDeps = { audit, log: deps.log, disabledTools: connectors.disabledTools }

  const icpRow = await activeIcpProfile(deps.db, args.orgId)
  let icpLabel: string | null = null
  if (icpRow) {
    try {
      icpLabel = parseIcpDefinition(icpRow.definition).label
    } catch {
      icpLabel = null
    }
  }

  const options = buildQueryOptions({
    canUseTool,
    // The in-process agency server and nothing else. The SDK writes every
    // server in this option that is not in-process onto the CLI's argv as
    // `--mcp-config <json>`, decrypted credentials included, so the
    // connectors are handed over the control channel instead (below).
    mcpServers: { agency: mcpServer },
    agents: subagents.agents,
    skills: deps.skills,
    hooks: {
      PreToolUse: [{ hooks: [makePreToolUse(hookDeps)], timeout: HOOK_TIMEOUT_SECONDS }],
      PostToolUse: [{ hooks: [makePostToolUse(hookDeps)], timeout: HOOK_TIMEOUT_SECONDS }],
    },
    systemPrompt: systemPrompt(
      args.orgName,
      icpLabel,
      playbook,
      // The research servers an owner let run without a card, by name, so the
      // model knows which searches cost nobody a click (2026-10-07).
      [...connectors.readsWithoutCard].map((entry) => entry.slice('mcp__'.length, -'__*'.length)),
    ),
    cwd: deps.cwd,
    abortController: abort,
    maxTurns: deps.maxTurns,
    maxBudgetUsd: deps.maxBudgetUsd,
    env: childEnv(deps.credential),
    ...(args.resume ? { resume: args.resume } : {}),
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.claudeCodePath ? { pathToClaudeCodeExecutable: deps.claudeCodePath } : {}),
  })

  // Everything registered and enabled, plus the agency server again. `agency`
  // is spread LAST so a connector named "agency" cannot displace the app's own
  // tools — the unique index on (org_id, name) does not know that name is
  // taken, and a row from before 0018's CHECK can still hold it.
  const handedOver = Object.keys(connectors.servers).some((name) => name !== 'agency')
  const mcpServers = handedOver ? { ...connectors.servers, agency: mcpServer } : {}

  return { turnId, options, mcpServers, abort }
}

/**
 * Who is asking, resolved from the database rather than from the request.
 *
 * The web app authenticates the person and names them in the body; this reads
 * the conversation and checks it actually belongs to them. So the worst a
 * forged body can do is address a thread that already exists and already
 * belongs to the user it claims.
 *
 * A REVOKED person resolves to nobody (0018's `users.revoked_at`). The web
 * refuses their session, but the worker is a separate process with its own
 * door and a turn can run for half an hour — so it asks for itself, per
 * turn, from the row, exactly as it already reads the role.
 */
export async function resolvePrincipal(
  db: AgencyDb,
  chatSessionId: string,
  userId: string,
): Promise<{ orgId: string; orgName: string; principal: Principal; sdkSessionId: string | null } | null> {
  const rows = await db
    .select({
      orgId: schema.chatSessions.orgId,
      sdkSessionId: schema.chatSessions.sdkSessionId,
      userId: schema.users.id,
      role: schema.users.role,
      orgName: schema.orgs.name,
    })
    .from(schema.chatSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.chatSessions.userId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.chatSessions.orgId))
    .where(and(
      eq(schema.chatSessions.id, chatSessionId),
      eq(schema.chatSessions.userId, userId),
      isNull(schema.users.revokedAt),
    ))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return {
    orgId: row.orgId,
    orgName: row.orgName,
    sdkSessionId: row.sdkSessionId,
    principal: { id: row.userId, orgId: row.orgId, role: row.role as Principal['role'] },
  }
}
