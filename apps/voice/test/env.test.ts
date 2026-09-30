/**
 * The voice service's environment boundary: a BLANK value is unset (§10).
 *
 * `docker compose --profile voice up` passes `VOICE_PUBLIC_URL: ${VOICE_PUBLIC_URL:-}`
 * and `VOICE_ORG_ID: ${VOICE_ORG_ID:-}` — empty strings when neither is set —
 * and zod refused `''` as a URL and as a uuid. So the configuration this
 * service is documented to boot in, unconfigured and refusing every webhook
 * until A2P 10DLC clears, did not boot at all. These pin that it now does,
 * and that a present value is still held to its shape.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadEnv, voiceMode } from '../src/env.js'

const BASE: Record<string, string> = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' }
const REQUIRED = Object.keys(BASE)

/** Read from the source, so a variable added later is covered too. */
const source = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8')
const NAMES = [...source.slice(source.indexOf('z.object({')).matchAll(/^ {2}([A-Z][A-Z0-9_]*): z\b/gm)].map(
  (m) => m[1] as string,
)
const OPTIONAL = NAMES.filter((n) => !REQUIRED.includes(n))

const load = (vars: Record<string, string>) => loadEnv({ ...BASE, ...vars }) as unknown as Record<string, unknown>

function refusal(vars: Record<string, string>): string {
  try {
    loadEnv({ ...BASE, ...vars })
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return expect.unreachable('expected the environment to be refused')
}

describe('the list of variables', () => {
  it('is read from the schema, and is not vacuous', () => {
    expect(NAMES).toEqual(expect.arrayContaining([...REQUIRED, 'VOICE_PUBLIC_URL', 'VOICE_ORG_ID', 'LLM_PROVIDER']))
    expect(OPTIONAL.length).toBeGreaterThan(20)
  })
})

describe('a blank value is unset', () => {
  it.each(OPTIONAL)('%s: blank or whitespace parses exactly as absent', (name) => {
    const absent = load({})[name]
    expect(load({ [name]: '' })[name]).toEqual(absent)
    expect(load({ [name]: '   ' })[name]).toEqual(absent)
  })

  /** Exactly what compose hands the container when nothing is configured. */
  it('boots on the blanks compose passes, and reports itself disabled', () => {
    const env = loadEnv({
      ...BASE,
      VOICE_PUBLIC_URL: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_FROM_NUMBER: '',
      VOICE_ORG_ID: '',
      TASKROUTER_WORKFLOW_SID: '',
      VOICE_HANDOFF_NUMBER: '',
      VOICE_TTS_PROVIDER: '',
      VOICE_TTS_VOICE: '',
      LLM_PROVIDER: '',
    })
    expect(env.VOICE_PUBLIC_URL).toBeUndefined()
    expect(env.VOICE_ORG_ID).toBeUndefined()
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined()
    expect(env.LLM_PROVIDER).toBeUndefined()
    expect(voiceMode(env)).toBe('disabled')
  })

  it.each(REQUIRED)('%s blank is still refused, and named', (name) => {
    expect(refusal({ [name]: '' })).toContain(name)
  })
})

describe('a present value is still held to its shape', () => {
  it('accepts well-formed values', () => {
    const env = loadEnv({
      ...BASE,
      VOICE_PUBLIC_URL: 'https://voice.example.com',
      VOICE_ORG_ID: '00000000-0000-4000-8000-000000000000',
      LLM_PROVIDER: 'ollama',
    })
    expect(env.VOICE_PUBLIC_URL).toBe('https://voice.example.com')
    expect(env.VOICE_ORG_ID).toBe('00000000-0000-4000-8000-000000000000')
    expect(env.LLM_PROVIDER).toBe('ollama')
  })

  it.each([
    ['VOICE_PUBLIC_URL', 'SENTINEL.example.com'],
    ['VOICE_ORG_ID', 'not-a-uuid-SENTINEL'],
    ['VOICE_HANDOFF_USER_EMAIL', 'SENTINEL-at-example'],
    ['LLM_PROVIDER', 'gemini-SENTINEL'],
    ['VOICE_MAX_CALL_SECONDS', 'SENTINEL'],
  ])('refuses %s=%s, naming the variable and never the value (§2.3)', (name, value) => {
    const message = refusal({ [name]: value })
    expect(message).toContain(name)
    expect(message).not.toContain(value)
  })
})
