/**
 * The three single-shot model clients §5.5 asks for.
 *
 * They are here rather than in `packages/core` because they make HTTP
 * requests and core may not (see `packages/core/src/llm/provider.ts` for
 * the interface and the rule, and CLAUDE.md §4 for why the split).
 *
 * Deliberately thin, and deliberately dependency-free: each is one `fetch`
 * against a documented JSON endpoint, and a vendor SDK would drag a whole
 * client surface in for a single call. No streaming — §5.5's list is
 * "scoring, classification, summarising a transcript, drafting one email
 * body", all of which are a request and an answer.
 *
 * ## Two rules every implementation keeps
 *
 * **The prompt is never logged.** It is the material the §5.5 rule exists
 * to protect; putting it in a log line moves it somewhere else that has to
 * be protected, and `redact()` cannot help because the lead data is the
 * VALUE, not a sensitive-looking key.
 *
 * **The credential is read at the point of use** and never stored on the
 * object beyond what the request needs (§2.3). Errors carry the status
 * code, never the response body, which providers fill with echoes of the
 * request.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from '@agency/core'

/** Anything longer than this is a bug in the caller, not a big job. */
const MAX_PROMPT_CHARS = 100_000
const DEFAULT_TIMEOUT_MS = 30_000

export class LlmProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'LlmProviderError'
  }
}

/** One place for the timeout, the size guard and the error shape. */
async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      // The status and nothing else. A provider's error body quotes the
      // request back, which is the one thing that must not spread.
      throw new LlmProviderError(provider, res.status, `${provider} answered ${res.status}`)
    }
    return (await res.json()) as unknown
  } catch (err) {
    if (err instanceof LlmProviderError) throw err
    const name = err instanceof Error ? err.name : 'UnknownError'
    throw new LlmProviderError(provider, null, name === 'AbortError' ? `${provider} timed out` : `${provider} unreachable (${name})`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function guard(request: LlmRequest): void {
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw new LlmProviderError('caller', null, `prompt is ${request.prompt.length} characters; the ceiling is ${MAX_PROMPT_CHARS}`)
  }
}

export interface OllamaOptions {
  /** e.g. http://127.0.0.1:11434 */
  readonly baseUrl: string
  readonly model: string
  readonly timeoutMs?: number
  /**
   * Whether this endpoint is on hardware the agency controls.
   *
   * Declared, not inferred. An Ollama URL pointing at a rented box in
   * somebody else's datacentre is not local, and only whoever configured it
   * knows — guessing from "is the hostname loopback" would quietly turn the
   * §5.5 rule off for the exact deployment that needs it.
   */
  readonly local?: boolean
}

/**
 * Ollama — the one §5.5 actually recommends, because the data stays put.
 *
 * `/api/chat` with `stream: false`.
 */
export function ollamaProvider(options: OllamaOptions): LlmProvider {
  return {
    name: 'ollama',
    model: options.model,
    local: options.local ?? true,
    async complete(request, signal) {
      guard(request)
      const json = (await postJson(
        'ollama',
        new URL('/api/chat', options.baseUrl).toString(),
        {},
        {
          model: options.model,
          stream: false,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          options: {
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
          },
        },
        signal,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }

      const text = json.message?.content
      if (typeof text !== 'string') throw new LlmProviderError('ollama', null, 'ollama returned no message content')
      return {
        text,
        provider: 'ollama',
        model: options.model,
        inputTokens: json.prompt_eval_count,
        outputTokens: json.eval_count,
      }
    },
  }
}

export interface RemoteOptions {
  readonly apiKey: string
  readonly model: string
  readonly baseUrl?: string
  readonly timeoutMs?: number
}

/** OpenAI-compatible `/v1/chat/completions`. Not local, and says so. */
export function openaiProvider(options: RemoteOptions): LlmProvider {
  return {
    name: 'openai',
    model: options.model,
    local: false,
    async complete(request, signal) {
      guard(request)
      const json = (await postJson(
        'openai',
        new URL('/v1/chat/completions', options.baseUrl ?? 'https://api.openai.com').toString(),
        { authorization: `Bearer ${options.apiKey}` },
        {
          model: options.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        signal,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }

      const text = json.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new LlmProviderError('openai', null, 'openai returned no message content')
      return {
        text,
        provider: 'openai',
        model: options.model,
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      }
    },
  }
}

/**
 * Anthropic's `/v1/messages`.
 *
 * Note what this is NOT: the agentic chat. That is the Agent SDK in
 * `apps/agent`, and §5.5 is explicit that the seam must not blur them —
 * "label the agentic chat as Claude, because it is". This is a single-shot
 * call that happens to use the same vendor.
 */
export function anthropicProvider(options: RemoteOptions): LlmProvider {
  return {
    name: 'anthropic',
    model: options.model,
    local: false,
    async complete(request, signal) {
      guard(request)
      const json = (await postJson(
        'anthropic',
        new URL('/v1/messages', options.baseUrl ?? 'https://api.anthropic.com').toString(),
        { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: options.model,
          // Required by the API, unlike the other two.
          max_tokens: request.maxTokens ?? 1024,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        signal,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )) as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }

      const text = json.content?.find((b) => b.type === 'text')?.text
      if (typeof text !== 'string') throw new LlmProviderError('anthropic', null, 'anthropic returned no text block')
      return {
        text,
        provider: 'anthropic',
        model: options.model,
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
      }
    },
  }
}

/**
 * A provider that answers without a network.
 *
 * For tests, and for proving a consumer's fallback path: `answer` may
 * throw, which is how "the model was down" is exercised without unplugging
 * anything.
 */
export function fakeProvider(
  answer: string | ((request: LlmRequest) => string),
  over: { readonly name?: string; readonly local?: boolean; readonly model?: string } = {},
): LlmProvider & { readonly seen: LlmRequest[] } {
  const seen: LlmRequest[] = []
  return {
    name: over.name ?? 'fake',
    model: over.model ?? 'fake-1',
    local: over.local ?? true,
    seen,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      seen.push(request)
      return {
        text: typeof answer === 'function' ? answer(request) : answer,
        provider: over.name ?? 'fake',
        model: over.model ?? 'fake-1',
      }
    },
  }
}
