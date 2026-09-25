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
import { and, eq } from 'drizzle-orm'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { parseIcpDefinition, type ChatEventBody, type Principal } from '@agency/core'
import {
  activeIcpProfile, appendAudit, enabledAgentDefs, ensureApproval, expireApproval, readApproval,
  schema, type AgencyDb, type ApprovalRow,
} from '@agency/db'
import type { ToolContext } from '@agency/tools'
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
}

export interface TurnRuntime {
  readonly turnId: string
  readonly options: Options
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
    audit,
    emit: args.emit,
    markGated: () => {},
    halted: deps.halt.halted,
    log: deps.log,
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
  })

  const hookDeps = { audit, log: deps.log }

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
  const [connectors, agentRows] = await Promise.all([
    buildMcpServers(deps.db, args.orgId, deps.secretsKey, deps.log),
    enabledAgentDefs(deps.db, args.orgId),
  ])
  const subagents = buildAgents(agentRows, deps.log)
  if (Object.keys(connectors.servers).length > 0 || Object.keys(subagents.agents).length > 0) {
    deps.log.info('runtime assembled from the database', {
      // Names and transports only. A connector URL can carry a token in a
      // query string despite every instruction not to put one there (§2.3).
      connectors: describeServers(connectors.servers),
      subagents: Object.keys(subagents.agents),
      ...(connectors.skipped.length > 0 ? { skippedConnectors: connectors.skipped } : {}),
      ...(subagents.skipped.length > 0 ? { skippedSubagents: subagents.skipped } : {}),
    })
  }

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
    // The in-process agency server always, plus whatever is registered and
    // enabled. `agency` is spread LAST so a connector named "agency" cannot
    // displace the app's own tools — the unique index on (org_id, name) does
    // not know that name is taken.
    mcpServers: { ...connectors.servers, agency: mcpServer },
    agents: subagents.agents,
    skills: deps.skills,
    hooks: {
      PreToolUse: [{ hooks: [makePreToolUse(hookDeps)], timeout: HOOK_TIMEOUT_SECONDS }],
      PostToolUse: [{ hooks: [makePostToolUse(hookDeps)], timeout: HOOK_TIMEOUT_SECONDS }],
    },
    systemPrompt: systemPrompt(args.orgName, icpLabel),
    cwd: deps.cwd,
    abortController: abort,
    maxTurns: deps.maxTurns,
    maxBudgetUsd: deps.maxBudgetUsd,
    env: childEnv(deps.credential),
    ...(args.resume ? { resume: args.resume } : {}),
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.claudeCodePath ? { pathToClaudeCodeExecutable: deps.claudeCodePath } : {}),
  })

  return { turnId, options, abort }
}

/**
 * Who is asking, resolved from the database rather than from the request.
 *
 * The web app authenticates the person and names them in the body; this reads
 * the conversation and checks it actually belongs to them. So the worst a
 * forged body can do is address a thread that already exists and already
 * belongs to the user it claims.
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
    .where(and(eq(schema.chatSessions.id, chatSessionId), eq(schema.chatSessions.userId, userId)))
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
