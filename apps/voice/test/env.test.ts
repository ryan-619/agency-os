/**
 * The voice service's environment boundary (PROMPT.md §10).
 *
 * Compose hands the container `VOICE_PUBLIC_URL: ${VOICE_PUBLIC_URL:-}` and
 * `VOICE_ORG_ID: ${VOICE_ORG_ID:-}`, which arrive as the empty string when
 * `.env` does not set them — and a blank URL or uuid stopped the service
 * booting. A blank is unset now, and unset still means what it meant: every
 * webhook is refused.
 */
import { readFileSync } from 'node:fs'
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

/**
 * EVERY variable but DATABASE_URL reads a blank as unset, not only the ones
 * whose blank used to refuse: a blank `VOICE_MODEL=` or `VOICE_LANGUAGE=`
 * was the model or the language `''`. Names are read from the schema's
 * source, so a variable added later is covered too.
 */
describe('every variable but the required one', () => {
  const REQUIRED = Object.keys(BASE)
  const source = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8')
  const NAMES = [...source.slice(source.indexOf('z.object({')).matchAll(/^ {2}([A-Z][A-Z0-9_]*): z\b/gm)].map(
    (m) => m[1] as string,
  )
  const OPTIONAL = NAMES.filter((n) => !REQUIRED.includes(n))
  const read = (vars: Record<string, string>) => load(vars) as unknown as Record<string, unknown>

  it('is read from the schema, and is not vacuous', () => {
    expect(NAMES).toEqual(expect.arrayContaining([...REQUIRED, 'VOICE_PUBLIC_URL', 'VOICE_MODEL', 'VOICE_PORT']))
    expect(OPTIONAL.length).toBeGreaterThan(20)
  })

  it.each(OPTIONAL)('%s: blank or whitespace parses exactly as absent', (name) => {
    const absent = read({})[name]
    expect(read({ [name]: '' })[name]).toEqual(absent)
    expect(read({ [name]: '   ' })[name]).toEqual(absent)
  })

  it('DATABASE_URL blank is still refused, and named', () => {
    expect(() => load({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
  })
})
