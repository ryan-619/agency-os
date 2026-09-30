/**
 * The worker's environment boundary: a BLANK value is unset (§10).
 *
 * `.env.example` documents every optional variable as `NAME=`, and compose
 * hands the container `${NAME:-}` — both are the empty string. Before this,
 * the worker refused to boot on a blank `LLM_PROVIDER=`, `UNSUBSCRIBE_SECRET=`
 * or `WEB_PUBLIC_URL=`, and read a blank `OUTREACH_BOUNCE_PAUSE_PCT=` as 0, so
 * the first bounce paused a campaign. The web app already read a blank as
 * unset; these pin that the worker now agrees, for every variable it has.
 *
 * `loadEnv` takes its source as an argument, so no case touches process.env.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env.js'

/** The smallest environment that validates. */
const BASE: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AGENT_INTERNAL_TOKEN: 't'.repeat(32),
}
const REQUIRED = Object.keys(BASE)

/**
 * Every variable the schema names, read from the source rather than listed
 * here, so a variable added next year is covered without anybody remembering
 * this file exists.
 */
const source = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8')
const NAMES = [...source.slice(source.indexOf('z.object({')).matchAll(/^ {2}([A-Z][A-Z0-9_]*): z\b/gm)].map(
  (m) => m[1] as string,
)
const OPTIONAL = NAMES.filter((n) => !REQUIRED.includes(n))

const load = (vars: Record<string, string>) => loadEnv({ ...BASE, ...vars }) as unknown as Record<string, unknown>

/** The message a refused environment throws. Fails the test if it did not throw. */
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
    expect(NAMES).toEqual(expect.arrayContaining([...REQUIRED, 'LLM_PROVIDER', 'UNSUBSCRIBE_SECRET', 'WEB_PUBLIC_URL', 'OUTREACH_BOUNCE_PAUSE_PCT']))
    expect(OPTIONAL.length).toBeGreaterThan(40)
  })
})

describe('a blank value is unset', () => {
  it.each(OPTIONAL)('%s: blank or whitespace parses exactly as absent', (name) => {
    const absent = load({})[name]
    expect(load({ [name]: '' })[name]).toEqual(absent)
    expect(load({ [name]: '   ' })[name]).toEqual(absent)
  })

  /** The four the example file had to comment out, and the one that went quietly wrong. */
  it('LLM_PROVIDER, UNSUBSCRIBE_SECRET and WEB_PUBLIC_URL blank boot, as undefined', () => {
    const env = loadEnv({ ...BASE, LLM_PROVIDER: '', UNSUBSCRIBE_SECRET: '', WEB_PUBLIC_URL: '' })
    expect(env.LLM_PROVIDER).toBeUndefined()
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(env.WEB_PUBLIC_URL).toBeUndefined()
  })

  it('OUTREACH_BOUNCE_PAUSE_PCT blank takes its default of 5, not 0', () => {
    expect(loadEnv({ ...BASE, OUTREACH_BOUNCE_PAUSE_PCT: '' }).OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
    // An explicit zero is still somebody's choice, and still honoured.
    expect(loadEnv({ ...BASE, OUTREACH_BOUNCE_PAUSE_PCT: '0' }).OUTREACH_BOUNCE_PAUSE_PCT).toBe(0)
  })

  it('IMAP_SECURE blank is the secure default, as absent is — not plaintext', () => {
    expect(loadEnv({ ...BASE, IMAP_SECURE: '' }).IMAP_SECURE).toBe(true)
    expect(loadEnv({ ...BASE, IMAP_SECURE: 'false' }).IMAP_SECURE).toBe(false)
  })

  it('LLM_MODEL blank reaches the provider as no model, never as a model called ""', () => {
    expect(loadEnv({ ...BASE, LLM_MODEL: '' }).LLM_MODEL).toBeUndefined()
  })

  it.each(REQUIRED)('%s blank is still refused, and named', (name) => {
    expect(refusal({ [name]: '' })).toContain(name)
  })
})

describe('a present value is still held to its shape', () => {
  it('accepts well-formed values', () => {
    const env = loadEnv({
      ...BASE,
      LLM_PROVIDER: 'ollama',
      UNSUBSCRIBE_SECRET: 'u'.repeat(32),
      WEB_PUBLIC_URL: 'https://agency.example',
      OUTREACH_BOUNCE_PAUSE_PCT: '12.5',
    })
    expect(env.LLM_PROVIDER).toBe('ollama')
    expect(env.UNSUBSCRIBE_SECRET).toBe('u'.repeat(32))
    expect(env.WEB_PUBLIC_URL).toBe('https://agency.example')
    expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(12.5)
  })

  /**
   * Each value carries a marker the message must not contain. A startup
   * error lands in every log that catches it, and some of these are
   * credentials (§2.3).
   */
  it.each([
    ['LLM_PROVIDER', 'gemini-SENTINEL'],
    ['UNSUBSCRIBE_SECRET', 'short-SENTINEL'],
    ['WEB_PUBLIC_URL', 'SENTINEL.example/unsubscribe'],
    ['OUTREACH_BOUNCE_PAUSE_PCT', 'SENTINEL'],
    ['OUTREACH_BOUNCE_PAUSE_PCT', '150'],
    ['OLLAMA_BASE_URL', 'SENTINEL ollama host'],
    ['LOG_LEVEL', 'SENTINEL'],
    ['AGENT_PORT', 'SENTINEL'],
  ])('refuses %s=%s, naming the variable and never the value', (name, value) => {
    const message = refusal({ [name]: value })
    expect(message).toContain(name)
    expect(message).not.toContain(value)
  })
})
