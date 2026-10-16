/**
 * The backstop hook (PROMPT.md §5.4's audit requirement, and the SDK's own
 * advice about its bypasses).
 *
 * Where `canUseTool` is the gate, this is the thing that makes sure the gate
 * is consulted at all. The SDK names it explicitly, twice, in the warnings it
 * emits when a bypass is configured: *"To gate every tool call, use a
 * PreToolUse hook instead."* Hooks also fire inside subagents — `agent_type`
 * is documented as *"present when the hook fires from within a subagent"* — so
 * this covers delegated work, which is most of the work once §7's agents
 * exist.
 *
 * **It must return immediately.** `HookCallbackMatcher.timeout` is documented
 * as *"Timeout in seconds for all hooks in this matcher"*, so awaiting a
 * human's decision here — a wait measured in minutes — would time the hook
 * out. The SDK then denies the pending call "with a retry notice", the model
 * retries under a new tool_use_id, and a second approval card appears for one
 * human intent. This hook therefore decides from what it already knows and
 * never waits for anything.
 *
 * The two hooks AFTER a call (2026-10-13) are where the worker sees what a
 * tool answered before the model does, for the main thread and helpers
 * alike. PostToolUse hands the answer to the conversation's ledger — what
 * this conversation has shown the agent (chat/ledger.ts) — and both it and
 * PostToolUseFailure read a connector's answer for a refusal
 * (gate/connector-watch.ts). Neither waits on the database: what they write
 * runs behind their answer.
 */
import type {
  PostToolUseFailureHookInput, PostToolUseHookInput, PreToolUseHookInput, SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk'
import { classifyRisk, connectorResultFailure } from '@agency/core'
import { connectorToolsIsDisabled } from '@agency/db'
import { toolResponseText, type SessionLedger } from '../chat/ledger.js'
import { disabledToolMessage } from './can-use-tool.js'
import { connectorRefusalSentence, connectorServerOf, type ConnectorWatch } from './connector-watch.js'

export interface HookDeps {
  readonly audit: (action: string, detail: Record<string, unknown>) => Promise<void>
  readonly log: { error: (msg: string, fields?: Record<string, unknown>) => void }
  /**
   * The connector calls an owner turned off — the same set `canUseTool` is
   * handed. Denied here too, because a deny from this hook holds even where
   * a bare allowedTools entry or a settings rule would have settled the call
   * before `canUseTool` was consulted.
   */
  readonly disabledTools: ReadonlySet<string>
  /**
   * What this conversation has shown the agent. Every tool result is handed
   * to it, with the call's own input, before the model reads the result; the
   * ledger decides what counts. Absent, nothing is recorded.
   */
  readonly ledger?: SessionLedger | undefined
  /** This turn's watch on connectors that refuse; the same one `canUseTool` asks. */
  readonly connectors?: ConnectorWatch | undefined
}

/** A connector's answer is read this far for a refusal: an error says what it is at its start. */
const CONNECTOR_ANSWER_READ = 8_000

/** The class of an error, for a log line: never its message, which can quote a tool's answer. */
const errorClass = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError')

/** A log line that cannot throw out of a hook: a hook that throws must never reach the CLI. */
function quietly(write: () => void): void {
  try {
    write()
  } catch {
    // Nothing left to tell.
  }
}

/** Seconds. The hook does no I/O beyond one audit insert. */
export const HOOK_TIMEOUT_SECONDS = 10

export function makePreToolUse(deps: HookDeps) {
  return async (input: unknown): Promise<SyncHookJSONOutput> => {
    try {
      const h = input as PreToolUseHookInput
      if (h?.hook_event_name !== 'PreToolUse') return {}

      // Turned off in Settings → Connectors: denied before classification,
      // and without waiting for anything — there is nobody to ask. The audit
      // is recorded best-effort: the refusal must not depend on it, and if
      // it throws past this, the catch below declines and canUseTool, which
      // checks the same set, refuses instead.
      if (connectorToolsIsDisabled(deps.disabledTools, h.tool_name)) {
        await deps
          .audit('agent.tool_disabled', {
            toolName: h.tool_name,
            toolUseId: h.tool_use_id,
            agentId: h.agent_id ?? null,
            agentType: h.agent_type ?? null,
          })
          .catch(() => {})
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: disabledToolMessage(h.tool_name),
          },
        }
      }

      const verdict = classifyRisk({
        toolName: h.tool_name,
        input: (h.tool_input ?? {}) as Record<string, unknown>,
        agentId: h.agent_id ?? null,
      })

      // §5.4: "Approval decides; the audit log remembers." Every tool call,
      // including ones the gate will refuse and ones a subagent made.
      await deps.audit('agent.tool_pre', {
        toolName: h.tool_name,
        toolUseId: h.tool_use_id,
        risk: verdict.risk,
        rule: verdict.rule,
        agentId: h.agent_id ?? null,
        agentType: h.agent_type ?? null,
      })

      if (verdict.refuse) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${h.tool_name} is not available in Agency OS: ${verdict.explain}`,
          },
        }
      }

      // The whole point of this hook. 'ask' FORCES the permission prompt —
      // that is, canUseTool — even where a bare allowedTools entry or a
      // settings allow rule would otherwise have auto-approved the call before
      // the callback was consulted. Silence would only decline to ADD an
      // allow; 'ask' overrides one that is already there.
      if (verdict.risk !== 'low') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: verdict.explain,
          },
        }
      }

      // Low risk: fall through to canUseTool, which allows in microseconds.
      // Returning 'allow' here would SETTLE the permission and skip the
      // callback — and §2.4 says the gate is canUseTool. Deciding here would
      // quietly move the gate into a hook that cannot wait for a person.
      return {}
    } catch (err) {
      // A hook that throws must not take the turn down, and must not silently
      // become an allow either. An empty object declines to decide, leaving
      // canUseTool — which is fail-closed — to answer.
      deps.log.error('PreToolUse hook failed', {
        error: err instanceof Error ? err.name : 'UnknownError',
      })
      return {}
    }
  }
}

export function makePostToolUse(deps: HookDeps) {
  return async (input: unknown): Promise<SyncHookJSONOutput> => {
    try {
      const h = input as Partial<PostToolUseHookInput> | null
      if (h?.hook_event_name !== 'PostToolUse') return {}
      const toolName = typeof h.tool_name === 'string' ? h.tool_name : null

      // A connector refusing IN BAND — jina's "Error: Search failed …
      // Unauthorized", tavily's {"error":…,"status":429} — which the CLI
      // reports as a success. The model is told in our words, never the
      // server's.
      const server = connectorServerOf(toolName)
      const refusal =
        server === null ? null : connectorResultFailure(toolResponseText(h.tool_response, CONNECTOR_ANSWER_READ), false, server)

      // What this conversation has shown the agent: the answer, with the
      // call's own input stripped out of it, before the model reads it — and
      // never a refusal, which shows nothing true (a signup link, the
      // server's own words), as PostToolUseFailure never adds an error. A
      // ledger that throws costs the ledger this answer, never the call.
      if (toolName !== null && refusal === null && deps.ledger) {
        try {
          deps.ledger.addToolResult(toolName, h.tool_response, h.tool_input)
        } catch (err) {
          quietly(() => deps.log.error('could not note a tool result in the conversation’s ledger', { error: errorClass(err) }))
        }
      }

      let context: string | null = null
      if (server !== null && deps.connectors) {
        if (refusal !== null) {
          deps.connectors.fail(server, refusal)
          context = connectorRefusalSentence(server, refusal)
        } else {
          deps.connectors.ok(server)
        }
      }

      // Deliberately no result body. §10: never log full message bodies — a
      // tool result can carry a company's evidence, and this row is kept
      // forever. Not waited for, and unable to cost the model the sentence
      // above: nothing here depends on it.
      try {
        void deps
          .audit('agent.tool_post', {
            toolName: toolName ?? null,
            toolUseId: h.tool_use_id ?? null,
          })
          .catch((err: unknown) => quietly(() => deps.log.error('PostToolUse audit failed', { error: errorClass(err) })))
      } catch (err) {
        quietly(() => deps.log.error('PostToolUse audit failed', { error: errorClass(err) }))
      }

      return context === null ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }
    } catch (err) {
      quietly(() => deps.log.error('PostToolUse hook failed', { error: errorClass(err) }))
      return {}
    }
  }
}

/**
 * A tool call that FAILED (2026-10-13) — an MCP result flagged as an error,
 * which the CLI turns into this event rather than PostToolUse: jina's "HTTP
 * 401: Unauthorized", firecrawl's "Anonymous keyless access is unavailable
 * for this request". Only a connector's failure is read, and only for a
 * refusal of its own; anything else — a page the connector could not fetch,
 * an interrupted call, the agency's own tools — is left as the CLI reported
 * it. A failure is never added to the ledger: an error shows nothing true.
 */
export function makePostToolUseFailure(deps: HookDeps) {
  return async (input: unknown): Promise<SyncHookJSONOutput> => {
    try {
      const h = input as Partial<PostToolUseFailureHookInput> | null
      if (h?.hook_event_name !== 'PostToolUseFailure') return {}
      if (h.is_interrupt === true || !deps.connectors) return {}
      const server = connectorServerOf(h.tool_name)
      if (server === null) return {}
      const text = typeof h.error === 'string' ? h.error : toolResponseText(h.error, CONNECTOR_ANSWER_READ)
      const kind = connectorResultFailure(text.slice(0, CONNECTOR_ANSWER_READ), true, server)
      if (kind === null) return {}
      deps.connectors.fail(server, kind)
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure',
          additionalContext: connectorRefusalSentence(server, kind),
        },
      }
    } catch (err) {
      quietly(() => deps.log.error('PostToolUseFailure hook failed', { error: errorClass(err) }))
      return {}
    }
  }
}
