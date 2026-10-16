/**
 * The seam for non-agentic model calls (PROMPT.md §5.5).
 *
 * "Scoring, classification, summarising a transcript, drafting one email
 * body — these are single-shot calls with no tool use. Put them behind
 * `packages/core/llm/provider.ts` with implementations for Anthropic,
 * OpenAI, and a local Ollama endpoint. The agency runs Ollama already;
 * local models keep lead data on their hardware, which is the point."
 *
 * That last clause is a RULE, not a rationale, and this file is where it
 * lives. Everything else here is the interface the implementations satisfy.
 *
 * ## Why the implementations are not in this file
 *
 * §5.5 names this path, and `packages/core` may perform no I/O — a
 * constraint `packages/core/test/no-io.test.ts` enforces by reading the
 * source. So the interface, the task vocabulary and the decision live here,
 * where they can be tested without a network; the three HTTP clients live
 * in `packages/llm`, which is allowed to make requests. The file §5.5 asks
 * for exists and contains what its name says. Flagged in CLAUDE.md §4
 * rather than hidden (§13).
 *
 * ## The rule
 *
 * A single-shot call ships a prompt to whatever is configured. For most of
 * this product that prompt contains a named human being — what they said on
 * a call, the address they replied from, the company somebody is about to
 * be pitched. Sending that to a third-party API is a disclosure of personal
 * data to a processor the agency has not necessarily contracted with, and
 * §2.3's concern ("no credential in an agent's context window") has an
 * obvious sibling: no LEAD in a third party's logs by accident.
 *
 * So the default is inverted from the usual one. A task carrying lead data
 * goes to a LOCAL provider, and reaching a remote one requires the operator
 * to have said so explicitly. `decideLlmCall` is the only place that
 * decides, for the same reason `decideSend` is: a caller cannot skip a
 * check it does not perform, and cannot reorder checks it does not own.
 */

/** The single-shot jobs this product has. Agentic work is the SDK's, not this. */
export type LlmTask =
  | 'summarise_call'
  | 'classify_reply'
  | 'draft_outreach'
  | 'draft_reply'
  | 'summarise_findings'
  | 'polish_copy'

/**
 * Whether a task's prompt inherently carries somebody's personal data.
 *
 * Nearly all of them do, and that is the honest answer rather than a
 * decorative distinction: this is a product about real companies and the
 * people who work at them. `polish_copy` is the exception that makes the
 * flag mean something — the agency's own template wording, with no prospect
 * named in it, is the agency's to send wherever it likes.
 */
export const TASK_CARRIES_LEAD_DATA: Readonly<Record<LlmTask, boolean>> = {
  summarise_call: true,
  classify_reply: true,
  draft_outreach: true,
  /** A reply's own words and the person's name: lead data in every line (0026). */
  draft_reply: true,
  summarise_findings: true,
  polish_copy: false,
}

export interface LlmRequest {
  readonly task: LlmTask
  /** The instruction. The agency's words, never a prospect's. */
  readonly system: string
  /** The material. This is what may or may not be allowed to leave. */
  readonly prompt: string
  readonly maxTokens?: number
  readonly temperature?: number
}

export interface LlmResponse {
  readonly text: string
  readonly provider: string
  readonly model: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface LlmProvider {
  readonly name: string
  /**
   * Does the data stay on hardware the agency controls?
   *
   * Declared by the implementation rather than guessed from a hostname: an
   * Ollama pointed at somebody else's server is not local, and only the
   * thing constructing it knows that.
   */
  readonly local: boolean
  readonly model: string
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>
}

export type LlmRefusalCode =
  | 'no_provider'
  | 'task_disabled'
  | 'lead_data_offsite'
  | 'nothing_to_send'

export interface LlmFacts {
  readonly task: LlmTask
  /** Null when nothing is configured for this task. */
  readonly providerName: string | null
  readonly providerIsLocal: boolean
  /** False turns one task off without unconfiguring the provider. */
  readonly taskEnabled: boolean
  /**
   * Does THIS prompt carry lead data? Defaults to the task's own answer;
   * a caller may say true for a task normally considered safe, never the
   * reverse — see `leadDataFor`.
   */
  readonly carriesLeadData: boolean
  /**
   * The operator has accepted that this task's material may go to a
   * third-party model. Off unless somebody turned it on.
   */
  readonly allowRemoteForLeadData: boolean
  /** Length of the material, so an empty call is refused before it is paid for. */
  readonly promptLength: number
}

export type LlmDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: LlmRefusalCode; readonly reason: string }

/**
 * A caller may escalate a task's sensitivity but never downgrade it.
 *
 * `polish_copy` on text that happens to quote a prospect is lead data, and
 * the caller is the only one who knows. The reverse — declaring a call
 * transcript safe — is not on offer.
 */
export function leadDataFor(task: LlmTask, callerSaysCarries?: boolean): boolean {
  return TASK_CARRIES_LEAD_DATA[task] || callerSaysCarries === true
}

/**
 * May this call be made, and to whom?
 *
 * The order matters and the tests assert it: a refusal code is what
 * somebody reads in a log six months later, and "no provider" and "not
 * allowed offsite" call for completely different actions.
 */
export function decideLlmCall(facts: LlmFacts): LlmDecision {
  if (!facts.providerName) {
    return {
      allowed: false,
      code: 'no_provider',
      reason: `No model is configured for ${facts.task}. Configure one, or leave the deterministic fallback in place.`,
    }
  }
  if (!facts.taskEnabled) {
    return {
      allowed: false,
      code: 'task_disabled',
      reason: `${facts.task} is switched off.`,
    }
  }
  if (facts.promptLength <= 0) {
    return {
      allowed: false,
      code: 'nothing_to_send',
      reason: 'There is nothing to send — an empty prompt is a bug, not a request.',
    }
  }
  // THE rule (§5.5). Last, so the more specific problems are reported first,
  // and inverted from the usual default: remote is the exception.
  if (facts.carriesLeadData && !facts.providerIsLocal && !facts.allowRemoteForLeadData) {
    return {
      allowed: false,
      code: 'lead_data_offsite',
      reason:
        `${facts.task} carries somebody's personal data and ${facts.providerName} is not on the agency's ` +
        `hardware. Point the task at a local model, or accept sending leads to ${facts.providerName} ` +
        `deliberately.`,
    }
  }
  return { allowed: true }
}

/**
 * What a caller does with a refusal.
 *
 * Every consumer of this seam already has a deterministic answer — the
 * extractive call summary, the scored findings, the templated draft — so a
 * refused or failed model call is never an error the user sees. It is the
 * product doing what it did before anybody configured a model. `fallback`
 * is that answer, and it is required, which is the point: a caller that
 * cannot work without the model has no business using this interface.
 */
export interface LlmAttempt<T> {
  readonly value: T
  readonly usedModel: boolean
  readonly why?: LlmRefusalCode | 'provider_failed'
  readonly provider?: string
}
