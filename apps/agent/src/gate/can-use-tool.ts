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
 *
 * A tool an owner turned off in Settings → Connectors is refused BEFORE
 * classification, and before anything that could raise a card: nobody is
 * asked, because a person approving it is the thing the owner switched off.
 * It is a refusal added on top of `high`, never an allow — there is no branch
 * in this file that a disabled list can reach and come out allowed.
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { type ChatEventBody, classifyRisk, runsWithoutApproval } from '@agency/core'
import { canonicalJson, connectorToolsIsDisabled, connectorToolsMatch, type ApprovalRow } from '@agency/db'
import { fingerprint, type AuthorisationLedger } from './ledger.js'
import type { ApprovalWaiter } from './waiter.js'

const allow = (): PermissionResult => ({ behavior: 'allow' })
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

/**
 * What the model is told about a tool an owner turned off. One sentence for
 * both rings, so whichever refuses it the model hears the same thing.
 *
 * "Disabled in Settings", not "disabled by an owner": for a catalog server
 * nobody has reviewed yet the catalog turned it off, and the model repeats
 * this to a person who may know that nobody did.
 */
export function disabledToolMessage(toolName: string): string {
  return (
    `${toolName} is disabled in Settings → Connectors, so it was refused without asking anyone. ` +
    'Do not try a variation; tell the user an owner can turn it on there.'
  )
}

/** The earlier of the approval's own TTL and the turn's wall clock. */
function approvalDeadline(deps: Pick<GateDeps, 'now' | 'ttlMs' | 'turnDeadline'>): Date {
  const ttl = deps.now().getTime() + deps.ttlMs
  return new Date(Math.min(ttl, deps.turnDeadline.getTime()))
}

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
  /**
   * When this TURN is killed by its own wall clock.
   *
   * An approval may never outlive the turn it gates. `AGENT_TURN_TIMEOUT_
   * MINUTES > APPROVAL_TTL_MINUTES` is checked at boot and is NOT sufficient,
   * because the two clocks start at different moments: the turn's at the
   * question, the approval's whenever the model gets round to asking. An
   * approval raised ten minutes into a 35-minute turn with a 30-minute TTL
   * expires at minute 40 — so for five minutes a person is looking at a live
   * card, with a countdown, for a turn that no longer exists. Clamping here is
   * what makes the card's own words true.
   */
  readonly turnDeadline: Date
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
  /**
   * The connector calls this turn refuses outright (`BuildResult.disabledTools`),
   * read fresh with the rest of the runtime. Checked before classification.
   */
  readonly disabledTools: ReadonlySet<string>
  /**
   * Read-only research servers an owner let run without a card
   * (`BuildResult.readsWithoutCard`, 2026-10-07): `mcp__<name>__*` entries.
   * Asked AFTER `disabledTools` and after the unattended check, so neither a
   * tool an owner turned off nor a turn nobody is watching ever reaches it.
   */
  readonly readsWithoutCard?: ReadonlySet<string>
  readonly audit: (action: string, detail: Record<string, unknown>) => Promise<void>
  readonly emit: (event: ChatEventBody) => void
  /** Marks a tool_use_id as having passed the gate, so a bypass is detectable. */
  readonly markGated: (toolUseId: string) => void
  /** True once the runtime has stopped trusting itself; see the bypass detector. */
  readonly halted: () => boolean
  /**
   * A turn nobody is watching — the morning brief. It may only read and scan:
   * anything above the low tier, an internal write included, is declined at
   * once with no card, because a card there waits for a person who is not
   * coming and a write there has nobody to catch a mistake.
   */
  readonly unattended?: boolean
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

      // --- turned off by an owner: refused before anyone is asked ------------
      // Before `classifyRisk`, so it holds whatever tier the classifier would
      // have given, and before `ensureApproval`, so no card is ever raised.
      if (connectorToolsIsDisabled(deps.disabledTools, toolName)) {
        await deps.audit('agent.tool_disabled', { toolName, toolUseId: options.toolUseID })
        return deny(disabledToolMessage(toolName))
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

      // --- unattended: reads and scans only ----------------------------------
      // The morning brief runs with nobody watching. A card there waits for a
      // person who is not coming; and an internal write — a note, a pause, a
      // suppression, which is never undone — would be made on the model's
      // reading of what it read, which includes the words of inbound replies,
      // with nobody to catch a mistake or a reply written to steer it. So it
      // may only read and scan (the low tier), everything else is declined at
      // once with no card, and the model is told to list it for a person.
      if (deps.unattended && verdict.risk !== 'low') {
        await deps.audit('agent.tool_unattended', {
          toolName, toolUseId: options.toolUseID, risk: verdict.risk, rule: verdict.rule,
        })
        return deny(
          `${toolName} would change the agency's records or needs a person, and this is an unattended run ` +
            'that may only read and scan. Do not try it another way: list it in your summary as a next step ' +
            'for a person.',
        )
      }

      // --- a read-only research server an owner let run without a card -------
      // Only a connector the catalog marks read-only (Exa, Firecrawl, Tavily,
      // Jina, the documentation servers), only while an owner's switch is on,
      // and never past `disabledTools` or in an unattended turn — both asked
      // above. Granted and audited exactly as an agency read is.
      if (
        verdict.rule === 'connector_unreviewed' &&
        deps.readsWithoutCard !== undefined &&
        connectorToolsMatch(deps.readsWithoutCard, toolName)
      ) {
        deps.ledger.grant(fp)
        deps.markGated(options.toolUseID)
        await deps.audit('agent.tool_allow', {
          toolName, toolUseId: options.toolUseID, risk: verdict.risk, rule: 'connector_read',
        })
        return allow()
      }

      // --- runs at once: reads, derived writes, and internal writes ----------
      // `runsWithoutApproval` in packages/core is the one place this line is
      // drawn, and it is drawn by RULE: internal writes run at once (operator
      // decision, 2026-10-06); anything that reaches a person outside, lifts a
      // pause, comes from a third-party connector or delegates keeps its card.
      // The ledger grant and the audit row are exactly what a low call gets,
      // so an internal write is still recorded and still single-use.
      if (runsWithoutApproval(verdict)) {
        deps.ledger.grant(fp)
        deps.markGated(options.toolUseID)
        await deps.audit('agent.tool_allow', {
          toolName, toolUseId: options.toolUseID, risk: verdict.risk, rule: verdict.rule,
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

      // --- everything else: a person decides ---------------------------------
      const approval = await deps.ensureApproval({
        toolUseId: options.toolUseID,
        toolName,
        payload: input,
        payloadSha256: fp,
        risk: verdict.risk,
        expiresAt: approvalDeadline(deps),
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

      // ONLY for an outcome that actually happened. `aborted` and
      // `unavailable` both leave the row pending: the first because the turn
      // was stopped, the second because the database could not be read. Both
      // used to be reported as `expired`, which put "expired" on a card whose
      // row was still live and still decidable — a person could then approve
      // something the screen had already written off.
      if (decision.status !== 'aborted' && decision.status !== 'unavailable') {
        emit({
          kind: 'approval_resolved',
          approvalId: approval.id,
          toolUseId: options.toolUseID,
          status: decision.status,
          decidedByEmail: null,
          reason: decision.reason ?? null,
        })
      }

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

        case 'expired': {
          await deps.audit('approval.expired', { approvalId: approval.id, toolName })
          // The window the person actually SAW, which is the TTL clamped by
          // the turn's wall clock — not the configured TTL.
          const windowMin = Math.max(
            1,
            Math.round((approval.expiresAt.getTime() - approval.createdAt.getTime()) / 60_000),
          )
          return deny(
            `No one approved this within ${windowMin} minutes, so it expired. ` +
              'Nothing was done. Ask the user to try again when someone is available to approve it.',
          )
        }

        case 'aborted':
          return deny('The turn was stopped before anyone decided. Nothing was done.')

        case 'unavailable':
          // The gate could not find out. The row is STILL PENDING and a person
          // may still be looking at it — so nothing here claims an outcome.
          // The turn's `finally` closes it out and emits the resolution, which
          // is the one place that knows the request is really dead.
          return deny(
            'The approval system could not be reached, so nobody was able to decide this. ' +
              'Nothing was done. Tell the user the request could not be confirmed, and stop.',
          )
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
