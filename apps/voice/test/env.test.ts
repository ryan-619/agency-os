/**
 * The voice service's environment boundary (PROMPT.md §10).
 *
 * Compose hands the container `VOICE_PUBLIC_URL: ${VOICE_PUBLIC_URL:-}` and
 * `VOICE_ORG_ID: ${VOICE_ORG_ID:-}`, which arrive as the empty string when
 * `.env` does not set them — and a blank URL or uuid stopped the service
 * booting. A blank is unset now, and unset still means what it meant: every
 * webhook is refused.
 */
import { describe, it, expect } from 'vitest'
import { loadEnv, voiceMode } from '../src/env.js'

const BASE = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' } as const
const load = (vars: Record<string, string>) => loadEnv({ ...BASE, ...vars } as NodeJS.ProcessEnv)

describe('a blank optional variable is unset', () => {
  it.each(['VOICE_PUBLIC_URL', 'VOICE_ORG_ID', 'VOICE_HANDOFF_USER_EMAIL', 'LLM_PROVIDER', 'LLM_MODEL'] as const)(
    '%s', (name) => {
      expect(load({ [name]: '' })[name]).toBeUndefined()
    },
  )

  it('falls back to the default Ollama URL', () => {
    expect(load({ OLLAMA_BASE_URL: '' }).OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434')
  })

  /** Blank must not read as configured: with Twilio set and no public URL, nothing is verified. */
  it('keeps the webhooks refused when VOICE_PUBLIC_URL is blank', () => {
    const env = load({ VOICE_PUBLIC_URL: '', TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'token' })
    expect(voiceMode(env)).toBe('disabled')
  })

  it.each([
    ['VOICE_PUBLIC_URL', 'voice.example.com'],
    ['VOICE_ORG_ID', 'not-a-uuid'],
    ['LLM_PROVIDER', 'gemini'],
  ])('still refuses a malformed %s', (name, value) => {
    expect(() => load({ [name]: value })).toThrow(new RegExp(name))
  })
})
