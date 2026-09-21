/**
 * The only way a consumer is meant to call a model (PROMPT.md §5.5).
 *
 * Every single-shot job in this product already has a deterministic answer
 * — the extractive call summary, the scored findings, the templated draft.
 * The model is an improvement on that answer, never a prerequisite for it.
 * So the signature takes the fallback as a REQUIRED argument: a caller that
 * cannot produce one without the model has misunderstood what this seam is
 * for, and cannot compile.
 *
 * That shape is what makes the failure modes boring. A refused call, an
 * unreachable Ollama, a provider returning nonsense — all of them end the
 * same way the product behaved before anybody configured a model, and the
 * caller learns which happened from `why` rather than from an exception.
 */
import {
  decideLlmCall, leadDataFor,
  type LlmAttempt, type LlmProvider, type LlmRequest, type LlmTask,
} from '@agency/core'

export interface AttemptOptions<T> {
  /** Null when nothing is configured — a normal state, not an error. */
  readonly provider: LlmProvider | null
  readonly request: LlmRequest
  /** What the product says when the model does not answer. Required. */
  readonly fallback: T
  /** Turn the model's text into the caller's shape. Throwing here is a rejection. */
  readonly parse: (text: string) => T
  readonly taskEnabled?: boolean
  readonly allowRemoteForLeadData?: boolean
  /** Escalate sensitivity for a task not normally considered to carry lead data. */
  readonly carriesLeadData?: boolean
  readonly signal?: AbortSignal
  /** Never given the prompt — see providers.ts. */
  readonly onRefused?: (code: string, reason: string) => void
  readonly onFailed?: (error: string) => void
}

export async function attemptLlm<T>(options: AttemptOptions<T>): Promise<LlmAttempt<T>> {
  const { provider, request, fallback, parse } = options
  const decision = decideLlmCall({
    task: request.task,
    providerName: provider?.name ?? null,
    providerIsLocal: provider?.local ?? false,
    taskEnabled: options.taskEnabled ?? true,
    carriesLeadData: leadDataFor(request.task, options.carriesLeadData),
    allowRemoteForLeadData: options.allowRemoteForLeadData ?? false,
    promptLength: request.prompt.trim().length,
  })

  if (!decision.allowed) {
    options.onRefused?.(decision.code, decision.reason)
    return { value: fallback, usedModel: false, why: decision.code }
  }

  try {
    const answered = await provider!.complete(request, options.signal)
    const text = answered.text.trim()
    if (!text) {
      options.onFailed?.('the model returned nothing')
      return { value: fallback, usedModel: false, why: 'provider_failed', provider: provider!.name }
    }
    // Parsing is the caller's, and a parse failure is the model having
    // answered in a shape the product cannot use — which is a failure of
    // the call, not of the product.
    return { value: parse(text), usedModel: true, provider: provider!.name }
  } catch (err) {
    options.onFailed?.(err instanceof Error ? `${err.name}` : 'UnknownError')
    return { value: fallback, usedModel: false, why: 'provider_failed', provider: provider!.name }
  }
}

/** The common case: the model's text IS the answer. */
export function attemptText(
  options: Omit<AttemptOptions<string>, 'parse'>,
): Promise<LlmAttempt<string>> {
  return attemptLlm<string>({ ...options, parse: (text) => text })
}

export type { LlmTask }
