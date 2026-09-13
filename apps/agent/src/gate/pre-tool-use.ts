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
 */
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { classifyRisk } from '@agency/core'

export interface HookDeps {
  readonly audit: (action: string, detail: Record<string, unknown>) => Promise<void>
  readonly log: { error: (msg: string, fields?: Record<string, unknown>) => void }
}

/** Seconds. The hook does no I/O beyond one audit insert. */
export const HOOK_TIMEOUT_SECONDS = 10

export function makePreToolUse(deps: HookDeps) {
  return async (input: unknown): Promise<SyncHookJSONOutput> => {
    try {
      const h = input as PreToolUseHookInput
      if (h?.hook_event_name !== 'PreToolUse') return {}

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
      const h = input as { hook_event_name?: string; tool_name?: string; tool_use_id?: string }
      if (h?.hook_event_name !== 'PostToolUse') return {}
      // Deliberately no result body. §10: never log full message bodies — a
      // tool result can carry a company's evidence, and this row is kept
      // forever.
      await deps.audit('agent.tool_post', {
        toolName: h.tool_name ?? null,
        toolUseId: h.tool_use_id ?? null,
      })
      return {}
    } catch (err) {
      deps.log.error('PostToolUse hook failed', {
        error: err instanceof Error ? err.name : 'UnknownError',
      })
      return {}
    }
  }
}
