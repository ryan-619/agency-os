/**
 * The worker's environment boundary (PROMPT.md §10).
 *
 * Two things are pinned here. A BLANK optional variable is unset — `node
 * --env-file` reads `NAME=` as the empty string, and so does compose's
 * `NAME: ${NAME:-}` for a variable nobody set — so a copied `.env.example`
 * or a compose file that passes every optional variable must not stop the
 * worker booting over a feature nobody has turned on. And the one-click
 * unsubscribe origin must be one a recipient can reach, in production.
 *
 * `.env.example` itself is replayed by `env-example.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { loadEnv } from '../src/env.js'

/** The smallest environment that validates. */
const BASE = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AGENT_INTERNAL_TOKEN: 't'.repeat(32),
} as const

const load = (vars: Record<string, string>) => loadEnv({ ...BASE, ...vars } as NodeJS.ProcessEnv)

describe('a blank optional variable is unset', () => {
  it.each(['UNSUBSCRIBE_SECRET', 'WEB_PUBLIC_URL', 'LLM_PROVIDER', 'LLM_MODEL', 'AGENT_MODEL'] as const)(
    '%s', (name) => {
      expect(load({ [name]: '' })[name]).toBeUndefined()
      expect(load({ [name]: '   ' })[name]).toBeUndefined()
    },
  )

  /** A blank read as a value: the Ollama URL failed `url()`, and the model was named `''`. */
  it('falls back to the default Ollama URL', () => {
    expect(load({ OLLAMA_BASE_URL: '' }).OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434')
  })

  /**
   * `z.coerce.number()` reads `''` as 0, and 0 passes `min(0)` — so a blank
   * threshold paused every campaign on its first bounce. `.env.example` had
   * to warn against leaving it blank; now a blank is the default.
   */
  it('reads a blank bounce threshold as the default, never as 0', () => {
    expect(load({ OUTREACH_BOUNCE_PAUSE_PCT: '' }).OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
    expect(load({ OUTREACH_BOUNCE_PAUSE_PCT: '0' }).OUTREACH_BOUNCE_PAUSE_PCT).toBe(0)
  })

  /** Blank is unset; a present value is still held to its shape, and named without it. */
  it.each([
    ['UNSUBSCRIBE_SECRET', 'too-short-to-sign-anything'],
    ['WEB_PUBLIC_URL', 'not a url'],
    ['LLM_PROVIDER', 'gemini'],
    ['OUTREACH_BOUNCE_PAUSE_PCT', '101'],
  ])('still refuses a malformed %s', (name, value) => {
    expect(() => load({ [name]: value })).toThrow(new RegExp(name))
    try {
      load({ [name]: value })
    } catch (e) {
      expect(e instanceof Error ? e.message : String(e)).not.toContain(value)
    }
  })

  /** What compose hands a production worker when .env sets none of them. */
  it('boots in production with every optional variable blank', () => {
    const env = load({
      NODE_ENV: 'production',
      UNSUBSCRIBE_SECRET: '',
      WEB_PUBLIC_URL: '',
      OUTREACH_BOUNCE_PAUSE_PCT: '',
      LLM_PROVIDER: '',
      LLM_MODEL: '',
      OLLAMA_BASE_URL: '',
      AGENT_MODEL: '',
    })
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(env.WEB_PUBLIC_URL).toBeUndefined()
    expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
  })
})

/**
 * RFC 8058 one-click needs an HTTPS URI a recipient can reach. A header built
 * on `http://localhost:3000` or `http://web:3000` validates as a URL, and is a
 * button that does nothing for the person who pressed it to be left alone.
 */
describe('WEB_PUBLIC_URL in production', () => {
  const production = (url: string) => load({ NODE_ENV: 'production', WEB_PUBLIC_URL: url })

  it.each([
    ['https://myagencyos.in'],
    ['https://agency-os-tau-murex.vercel.app'],
    ['https://app.agency.example.com:8443/'],
  ])('accepts %s', (url) => {
    expect(production(url).WEB_PUBLIC_URL).toBe(url)
  })

  it.each([
    ['plain http', 'http://myagencyos.in'],
    ['loopback', 'https://localhost:3000'],
    ['the compose service name', 'https://web:3000'],
    ['an IPv4 literal', 'https://10.0.0.7'],
    ['an IPv6 literal', 'https://[::1]:3000'],
    ['an internal suffix', 'https://agency.internal'],
    ['a reserved suffix', 'https://agency.test'],
    ['plain http to the compose service', 'http://web:3000'],
  ])('refuses %s, naming the variable and never the value', (_why, url) => {
    let message = ''
    try {
      production(url)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/WEB_PUBLIC_URL/)
    expect(message).not.toContain(url)
  })

  /** A developer's only recipient is themselves, on their own machine. */
  it('still accepts http://localhost in development', () => {
    expect(load({ NODE_ENV: 'development', WEB_PUBLIC_URL: 'http://localhost:3000' }).WEB_PUBLIC_URL).toBe(
      'http://localhost:3000',
    )
  })
})

/**
 * Not only the variables whose blank used to refuse: EVERY one but the two
 * required ones reads a blank as unset. A blank `IMAP_SECURE=` read as
 * `false` — plaintext — where an absent one reads as `true`, and a blank
 * numeric default coerced to 0 and was refused at boot.
 *
 * The names are read from the schema's source rather than listed here, so a
 * variable added next year is covered without anybody remembering this test.
 */
describe('every variable but the required ones', () => {
  const REQUIRED = Object.keys(BASE)
  const source = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8')
  const NAMES = [...source.slice(source.indexOf('z.object({')).matchAll(/^ {2}([A-Z][A-Z0-9_]*): z\b/gm)].map(
    (m) => m[1] as string,
  )
  const OPTIONAL = NAMES.filter((n) => !REQUIRED.includes(n))
  const read = (vars: Record<string, string>) => load(vars) as unknown as Record<string, unknown>

  it('is read from the schema, and is not vacuous', () => {
    expect(NAMES).toEqual(expect.arrayContaining([...REQUIRED, 'IMAP_SECURE', 'AGENT_PORT', 'OUTREACH_BOUNCE_PAUSE_PCT']))
    expect(OPTIONAL.length).toBeGreaterThan(40)
  })

  it.each(OPTIONAL)('%s: blank or whitespace parses exactly as absent', (name) => {
    const absent = read({})[name]
    expect(read({ [name]: '' })[name]).toEqual(absent)
    expect(read({ [name]: '   ' })[name]).toEqual(absent)
  })

  it('IMAP_SECURE blank is the secure default, as absent is — not plaintext', () => {
    expect(load({ IMAP_SECURE: '' }).IMAP_SECURE).toBe(true)
    expect(load({ IMAP_SECURE: 'false' }).IMAP_SECURE).toBe(false)
  })

  it.each(REQUIRED)('%s blank is still refused, and named', (name) => {
    expect(() => load({ [name]: '' })).toThrow(new RegExp(name))
  })
})
