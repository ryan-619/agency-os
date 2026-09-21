/**
 * The model seam's behaviour (PROMPT.md §5.5).
 *
 * `decideLlmCall` is tested pure in packages/core. What is tested here is
 * that `attemptLlm` HONOURS it, and — more importantly — that every way a
 * model call can go wrong ends with the product saying what it said before
 * anybody configured a model. A model is an improvement, never a
 * prerequisite; these are the tests that keep that true.
 */
import { describe, it, expect, vi } from 'vitest'
import type { LlmProvider, LlmRequest } from '@agency/core'
import { attemptLlm, attemptText } from '../src/attempt.js'
import { LlmProviderError, anthropicProvider, fakeProvider, ollamaProvider, openaiProvider } from '../src/providers.js'

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  task: 'summarise_call',
  system: 'Summarise the call.',
  prompt: 'The caller said they had a security questionnaire last quarter.',
  ...over,
})

describe('attemptLlm', () => {
  it('uses the model when a local provider is configured', async () => {
    const provider = fakeProvider('They mentioned a questionnaire.')
    const out = await attemptText({ provider, request: request(), fallback: 'the deterministic summary' })
    expect(out).toMatchObject({ value: 'They mentioned a questionnaire.', usedModel: true, provider: 'fake' })
    expect(provider.seen).toHaveLength(1)
  })

  /** §5.5's rule, enforced at the seam rather than in each caller. */
  it('refuses a remote provider for lead data, and the product carries on', async () => {
    const provider = fakeProvider('should never be asked', { name: 'openai', local: false })
    const onRefused = vi.fn()
    const out = await attemptText({ provider, request: request(), fallback: 'the deterministic summary', onRefused })

    expect(out).toMatchObject({ value: 'the deterministic summary', usedModel: false, why: 'lead_data_offsite' })
    // The point: it was never called at all.
    expect(provider.seen).toEqual([])
    expect(onRefused).toHaveBeenCalledWith('lead_data_offsite', expect.stringMatching(/openai/))
  })

  it('allows the remote provider once the operator has said so', async () => {
    const provider = fakeProvider('fine', { name: 'openai', local: false })
    const out = await attemptText({
      provider, request: request(), fallback: 'fallback', allowRemoteForLeadData: true,
    })
    expect(out.usedModel).toBe(true)
    expect(provider.seen).toHaveLength(1)
  })

  it('falls back when nothing is configured, without calling that an error', async () => {
    const out = await attemptText({ provider: null, request: request(), fallback: 'the deterministic summary' })
    expect(out).toMatchObject({ value: 'the deterministic summary', usedModel: false, why: 'no_provider' })
  })

  it('falls back when the task is switched off', async () => {
    const out = await attemptText({
      provider: fakeProvider('x'), request: request(), fallback: 'fallback', taskEnabled: false,
    })
    expect(out.why).toBe('task_disabled')
  })

  describe('when the model misbehaves', () => {
    const boom: LlmProvider = {
      name: 'ollama', model: 'llama3', local: true,
      complete: () => Promise.reject(new LlmProviderError('ollama', null, 'ollama unreachable (TypeError)')),
    }

    it('falls back when the provider is unreachable', async () => {
      const onFailed = vi.fn()
      const out = await attemptText({ provider: boom, request: request(), fallback: 'the deterministic summary', onFailed })
      expect(out).toMatchObject({ value: 'the deterministic summary', usedModel: false, why: 'provider_failed' })
      expect(onFailed).toHaveBeenCalled()
    })

    it('falls back when the model answers with nothing at all', async () => {
      const out = await attemptText({ provider: fakeProvider('   '), request: request(), fallback: 'fallback' })
      expect(out).toMatchObject({ value: 'fallback', usedModel: false, why: 'provider_failed' })
    })

    /** A model answering in a shape the product cannot use is a failed call. */
    it('falls back when parsing the answer throws', async () => {
      const out = await attemptLlm<{ score: number }>({
        provider: fakeProvider('not json at all'),
        request: request({ task: 'classify_reply' }),
        fallback: { score: 0 },
        parse: (text) => JSON.parse(text) as { score: number },
      })
      expect(out).toMatchObject({ value: { score: 0 }, usedModel: false, why: 'provider_failed' })
    })
  })

  /** The one task whose material names nobody. */
  it('sends the agency’s own copy to a remote model without ceremony', async () => {
    const provider = fakeProvider('tightened', { name: 'openai', local: false })
    const out = await attemptText({
      provider,
      request: request({ task: 'polish_copy', prompt: 'We review your public surface from the outside.' }),
      fallback: 'the original',
    })
    expect(out.usedModel).toBe(true)
  })
})

describe('the HTTP providers', () => {
  // Typed with fetch's own parameters so `mock.calls[0]` carries the URL and
  // the init — an argless mock types them as an empty tuple.
  const ok = (body: unknown) =>
    vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

  it('speaks ollama’s /api/chat and reports it as local', async () => {
    const fetchSpy = ok({ message: { content: 'a summary' }, prompt_eval_count: 12, eval_count: 5 })
    vi.stubGlobal('fetch', fetchSpy)
    const p = ollamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'llama3' })
    expect(p.local).toBe(true)
    const res = await p.complete(request())
    expect(res).toMatchObject({ text: 'a summary', provider: 'ollama', model: 'llama3', inputTokens: 12, outputTokens: 5 })
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://127.0.0.1:11434/api/chat')
    vi.unstubAllGlobals()
  })

  /**
   * Declared, not inferred. An Ollama on somebody else's box is not local,
   * and guessing from the hostname would silently disable §5.5's rule for
   * exactly the deployment that needs it.
   */
  it('lets an ollama endpoint be declared NOT local', () => {
    expect(ollamaProvider({ baseUrl: 'https://ollama.somebody-else.net', model: 'llama3', local: false }).local).toBe(false)
  })

  it('speaks openai’s chat completions and is never local', async () => {
    const fetchSpy = ok({ choices: [{ message: { content: 'an answer' } }], usage: { prompt_tokens: 9, completion_tokens: 3 } })
    vi.stubGlobal('fetch', fetchSpy)
    const p = openaiProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini' })
    expect(p.local).toBe(false)
    expect((await p.complete(request())).text).toBe('an answer')
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer sk-test' }) })
    vi.unstubAllGlobals()
  })

  it('speaks anthropic’s messages API and always sends max_tokens', async () => {
    const fetchSpy = ok({ content: [{ type: 'text', text: 'an answer' }], usage: { input_tokens: 7, output_tokens: 2 } })
    vi.stubGlobal('fetch', fetchSpy)
    const p = anthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-haiku-4-5-20251001' })
    expect((await p.complete(request())).text).toBe('an answer')
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)) as { max_tokens: number }
    // Required by that API, unlike the other two — omitting it is a 400.
    expect(body.max_tokens).toBeGreaterThan(0)
    vi.unstubAllGlobals()
  })

  /** A provider's error body quotes the request back; only the status travels. */
  it('reports a failure by status and never carries the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('the prompt was: secrets', { status: 429 })))
    const p = openaiProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini' })
    await expect(p.complete(request())).rejects.toThrow(/openai answered 429/)
    await expect(p.complete(request())).rejects.not.toThrow(/secrets/)
    vi.unstubAllGlobals()
  })

  it('refuses a prompt far larger than any real job', async () => {
    const p = ollamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'llama3' })
    await expect(p.complete(request({ prompt: 'x'.repeat(100_001) }))).rejects.toThrow(/ceiling/)
  })
})
