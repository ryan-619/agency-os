/**
 * Build the configured provider, or null (§5.5).
 *
 * Shared because both `apps/voice` and `apps/agent` need the same decision
 * and it is the kind of thing that drifts: one of them learns about a new
 * provider, the other keeps a copy that does not, and the difference only
 * shows up as "summaries work but reply triage does not".
 *
 * Null is a COMPLETE configuration, not a failure. Every caller of this seam
 * has a deterministic answer already; a provider only improves on it.
 */
import type { LlmProvider } from '@agency/core'
import { anthropicProvider, ollamaProvider, openaiProvider } from './providers.js'

export interface ProviderSettings {
  readonly provider?: 'ollama' | 'openai' | 'anthropic' | undefined
  readonly model?: string | undefined
  readonly ollamaBaseUrl?: string | undefined
  /** Declared, never inferred from the URL — see providers.ts. */
  readonly ollamaIsLocal?: boolean | undefined
  readonly openaiApiKey?: string | undefined
  readonly anthropicApiKey?: string | undefined
}

export function providerFrom(
  settings: ProviderSettings,
  onMisconfigured?: (provider: string) => void,
): LlmProvider | null {
  if (settings.provider === 'ollama') {
    return ollamaProvider({
      baseUrl: settings.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
      model: settings.model ?? 'llama3',
      local: settings.ollamaIsLocal ?? true,
    })
  }
  if (settings.provider === 'openai' && settings.openaiApiKey) {
    return openaiProvider({ apiKey: settings.openaiApiKey, model: settings.model ?? 'gpt-4o-mini' })
  }
  if (settings.provider === 'anthropic' && settings.anthropicApiKey) {
    return anthropicProvider({
      apiKey: settings.anthropicApiKey,
      model: settings.model ?? 'claude-haiku-4-5',
    })
  }
  // Named but unusable — a provider with no credential is a configuration
  // somebody meant to finish, and silence would leave them wondering why the
  // deterministic answer is all they ever see.
  if (settings.provider) onMisconfigured?.(settings.provider)
  return null
}
