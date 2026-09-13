/**
 * The approval gate (PROMPT.md §2.4, §5.4).
 *
 * One rule governs this whole file: **it always returns a decision.** Never
 * `null`, never `undefined`, never a thrown exception escaping to the SDK.
 * From `sdk.d.ts`, verbatim:
 *
 *   "Return `null` ONLY after the consumer has already sent the
 *    control_response out-of-band … Fail-closed: an accidental null means no
 *    control_response is sent and the tool stays blocked indefinitely —
 *    permission prompts have no park deadline."
 *
 * Returning a null from the catch block below would be the single worst line
 * in this phase: the turn hangs forever, with no timeout, no error, and
 * nothing for an operator to see. It is indistinguishable from the model
 * thinking. `gate.test.ts` asserts every path settles, and a source test scans
 * this file for the literal with comments stripped.
 *
 * Note also that `classifyRisk` is called INSIDE the try. It is a pure
 * function that should not throw, which is exactly why forgetting to guard it
 * is easy — and a throw from there would escape the fail-closed catch.
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { classifyRisk, type ChatEventBody } from '@agency/core'
import { canonicalJson, type ApprovalRow } from '@agency/db'
import { fingerprint, type AuthorisationLedger } from './ledger.js'
import type { ApprovalWaiter } from './waiter.js'

const allow = (): PermissionResult => ({ behavior: 'allow' })
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

export interface ParsedInput {
  readonly ok: boolean
  readonly value?: unknown
  readonly message?: string
}

export interface GateDeps {
  readonly orgId: string
  readonly chatSessionId: string
  readonly turnId: string
  readonly ttlMs: number
  readonly now: () => Date
  /** Validate against the tool's own zod shape. Unknown tools parse as ok. */
  readonly parseToolInput: (toolName: string, input: Record<string, unknown>) => ParsedInput
  readonly ensureApproval: (req: {
    toolUseId: string
    toolName: string
    payload: Record<string, unknown>
    payloadSha256: string
    risk: 'low' | 'medium' | 'high'
    expiresAt: Date
  }) => Promise<ApprovalRow>
  readonly waiter: ApprovalWaiter
  readonly ledger: AuthorisationLedger
  readonly audit: (action: string, detail: Record<string, unknown>) => Promise<void>
  readonly emit: (event: ChatEventBody) => void
  /** Marks a tool_use_id as having passed the gate, so a bypass is detectable. */
  readonly markGated: (toolUseId: string) => void
  /** True once the runtime has stopped trusting itself; see the bypass detector. */
  readonly halted: () => boolean
  readonly log: {
    warn: (msg: string, fields?: Record<string, unknown>) => void
    error: (msg: string, fields?: Record<string, unknown>) => void
  }
}

export function makeCanUseTool(deps: GateDeps): CanUseTool {
  /**
   * Telling the browser is best-effort; deciding is not.
   *
   * A closed SSE stream, a browser that went away, a serialisation failure —
   * none of those may turn into a thrown permission callback. The turn is
   * still running and the model is still waiting for an answer.
   */
  const emit = (event: ChatEventBody): void => {
    try {
      deps.emit(event)
    } catch (err) {
      deps.log.warn('could not emit a chat event', {
        kind: event.kind,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }

  return async (toolName, input, options): Promise<PermissionResult> => {
    try {
      if (deps.halted()) {
        return deny(
          'The agent runtime has stopped accepting tool calls because it detected a call it ' +
            'never authorised. Tell the user and stop.',
        )
      }

      const verdict = classifyRisk({ toolName, input, agentId: options.agentID ?? null })

      // --- refused outright: no human may approve this ----------------------
      if (verdict.refuse) {
        await deps.audit('agent.tool_refused', {
          toolName, toolUseId: options.toolUseID, risk: verdict.risk, rule: verdict.rule,
        })
        return deny(
          `${toolName} is not available in Agency OS (${verdict.explain}) ` +
            'Do not try a variation of it; tell the user why and stop.',
        )
      }

      const parsed = deps.parseToolInput(toolName, input)
      if (!parsed.ok) {
        return deny(`${toolName} was called with invalid arguments: ${parsed.message ?? 'unknown problem'}`)
      }
      const fp = fingerprint(deps.turnId, toolName, canonicalJson(parsed.value))

      // --- low: reads and derived, append-only writes (§5.4) -----------------
      if (verdict.risk === 'low') {
        deps.ledger.grant(fp)
        deps.markGated(options.toolUseID)
        await deps.audit('agent.tool_allow', {
          toolName, toolUseId: options.toolUseID, risk: 'low', rule: verdict.rule,
        })
        // No `updatedInput`: the value the handler receives has to be the one
        // the fingerprint was taken over, or the ledger check fails on a call
        // that was genuinely authorised.
        //
        // No `updatedPermissions`, and `options.suggestions` is ignored on
        // purpose: an "always allow" writes a durable allow RULE, which is the
        // bypass this gate exists to prevent, added by the gate itself.
        return allow()
      }

      // --- medium and high: a person decides --------------------------------
      const approval = await deps.ensureApproval({
        toolUseId: options.toolUseID,
        toolName,
        payload: input,
        payloadSha256: fp,
        risk: verdict.risk,
        expiresAt: new Date(deps.now().getTime() + deps.ttlMs),
      })

      // Already answered: a redelivery, a retry, or a very fast human. The row
      // carries the decision, so nobody is asked twice for one intent.
      if (approval.status !== 'pending') {
        emit({
          kind: 'approval_resolved',
          approvalId: approval.id,
          toolUseId: options.toolUseID,
          status: approval.status === 'approved' ? 'approved' : approval.status === 'denied' ? 'denied' : 'expired',
          decidedByEmail: null,
          reason: approval.decidedReason,
        })
        if (approval.status !== 'approved') {
          return deny(
            `This request was already ${approval.status}. Nothing was done. Do not retry it.`,
          )
        }
        deps.ledger.grant(fp)
        deps.markGated(options.toolUseID)
        return allow()
      }

      emit({
        kind: 'approval_requested',
        approvalId: approval.id,
        toolUseId: options.toolUseID,
        toolName,
        payload: input,
        risk: verdict.risk,
        explain: verdict.explain,
        expiresAt: approval.expiresAt.toISOString(),
      })
      await deps.audit('approval.requested', {
        approvalId: approval.id, toolName, risk: verdict.risk, toolUseId: options.toolUseID,
      })

      const decision = await deps.waiter.await(approval.id, {
        signal: options.signal,
        deadline: approval.expiresAt,
      })

      emit({
        kind: 'approval_resolved',
        approvalId: approval.id,
        toolUseId: options.toolUseID,
        status: decision.status === 'aborted' ? 'expired' : decision.status,
        decidedByEmail: null,
        reason: decision.reason ?? null,
      })

      switch (decision.status) {
        case 'approved':
          await deps.audit('approval.approved', {
            approvalId: approval.id, decidedBy: decision.decidedBy, toolName,
          })
          deps.ledger.grant(fp)
          deps.markGated(options.toolUseID)
          return allow()

        case 'denied':
          await deps.audit('approval.denied', {
            approvalId: approval.id, decidedBy: decision.decidedBy, toolName,
          })
          // Deliberately no `interrupt: true`. A denial is a fact for the
          // model to report back, not a reason to kill the turn — the person
          // who denied it is sitting in the chat waiting to hear what happened.
          return deny(
            `A human denied this${decision.reason ? `: ${decision.reason}` : ''}. ` +
              'Do not retry it. Report the denial to the user.',
          )

        case 'expired':
          await deps.audit('approval.expired', { approvalId: approval.id, toolName })
          return deny(
            `No one approved this within ${Math.round(deps.ttlMs / 60_000)} minutes, so it expired. ` +
              'Nothing was done. Ask the user to try again when someone is available to approve it.',
          )

        case 'aborted':
          return deny('The turn was stopped before anyone decided. Nothing was done.')
      }
    } catch (err) {
      // The only correct behaviour is a deny. See the note at the top of the
      // file: a null here hangs the turn forever, and so does a throw that
      // escapes — so even the logging in this block is guarded.
      try {
        deps.log.error('approval gate failed closed', {
          toolName,
          toolUseId: options.toolUseID,
          error: err instanceof Error ? err.name : 'UnknownError',
        })
      } catch {
        // A logger that throws must not become a hung turn.
      }
      emit({
        kind: 'error',
        code: 'gate_failed',
        retryable: false,
        message: `The approval gate failed while checking ${toolName}. The call was refused.`,
      })
      return deny(
        'The approval system is unavailable, so this could not be approved by a human. ' +
          'Nothing was done. Tell the user the system could not confirm the action, and stop.',
      )
    }
  }
}
