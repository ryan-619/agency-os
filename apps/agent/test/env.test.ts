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
  it.each([
    'UNSUBSCRIBE_SECRET', 'WEB_PUBLIC_URL', 'LLM_PROVIDER', 'LLM_MODEL', 'AGENT_MODEL', 'SLACK_WEBHOOK_URL',
    'DOVESOFT_API_KEY', 'DOVESOFT_ENTITY_ID',
  ] as const)(
    '%s', (name) => {
      expect(load({ [name]: '' })[name]).toBeUndefined()
      expect(load({ [name]: '   ' })[name]).toBeUndefined()
    },
  )

  /** A blank read as a value: the Ollama URL failed `url()`, and the model was named `''`. */
  it('falls back to the default Ollama URL', () => {
    expect(load({ OLLAMA_BASE_URL: '' }).OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434')
  })

  /** DoveSoft's own API, blank or absent. */
  it('falls back to DoveSoft’s own API', () => {
    expect(load({}).DOVESOFT_BASE_URL).toBe('https://api.dovesoft.io')
    expect(load({ DOVESOFT_BASE_URL: '' }).DOVESOFT_BASE_URL).toBe('https://api.dovesoft.io')
    expect(load({ DOVESOFT_BASE_URL: '  ' }).DOVESOFT_BASE_URL).toBe('https://api.dovesoft.io')
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
    ['SLACK_WEBHOOK_URL', 'not a url'],
    ['DOVESOFT_API_KEY', 'short'],
    ['DOVESOFT_ENTITY_ID', 'PE-1101234567'],
    ['DOVESOFT_ENTITY_ID', '1101 2345'],
    ['DOVESOFT_BASE_URL', 'not a url'],
    ['DOVESOFT_BASE_URL', 'ftp://api.dovesoft.io'],
    ['DOVESOFT_BASE_URL', 'https://user:hunter2-secret@api.dovesoft.io'],
    ['DOVESOFT_BASE_URL', 'https://api.dovesoft.io/?key=leaked-in-a-query'],
    ['DOVESOFT_BASE_URL', 'https://api.dovesoft.io/#fragment-secret'],
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
      SLACK_WEBHOOK_URL: '',
      DOVESOFT_API_KEY: '',
      DOVESOFT_ENTITY_ID: '',
      DOVESOFT_BASE_URL: '',
    })
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(env.WEB_PUBLIC_URL).toBeUndefined()
    expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
    // SMS is off, and the default API passes the production rule below.
    expect(env.DOVESOFT_API_KEY).toBeUndefined()
    expect(env.DOVESOFT_ENTITY_ID).toBeUndefined()
    expect(env.DOVESOFT_BASE_URL).toBe('https://api.dovesoft.io')
  })
})

/**
 * The SMS API key is sent, as a header, to whatever DOVESOFT_BASE_URL names.
 * In production that is https on a public host or the worker does not boot;
 * in development it may be a local stand-in. A refusal names the variable
 * and never the value.
 */
describe('DoveSoft', () => {
  it('reads the key and the entity id as given', () => {
    const env = load({ DOVESOFT_API_KEY: 'dsk-0123456789', DOVESOFT_ENTITY_ID: '1101234567890123456' })
    expect(env.DOVESOFT_API_KEY).toBe('dsk-0123456789')
    expect(env.DOVESOFT_ENTITY_ID).toBe('1101234567890123456')
  })

  it.each([
    ['https://api.dovesoft.io'],
    ['https://api.dovesoft.io/'],
    ['https://gateway.dovesoft.example.com/v2'],
  ])('accepts %s in production', (url) => {
    expect(load({ NODE_ENV: 'production', DOVESOFT_BASE_URL: url }).DOVESOFT_BASE_URL).toBe(url)
  })

  it.each([
    ['plain http', 'http://api.dovesoft.io'],
    ['loopback', 'https://localhost:8443'],
    ['an IPv4 literal', 'https://169.254.169.254'],
    ['an IPv6 literal', 'https://[::1]:8443'],
    ['a compose service name', 'https://dovesoft-mock:8443'],
    ['an internal suffix', 'https://sms.internal'],
  ])('refuses %s in production, naming the variable and never the value', (_why, url) => {
    let message = ''
    try {
      load({ NODE_ENV: 'production', DOVESOFT_BASE_URL: url })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/DOVESOFT_BASE_URL/)
    expect(message).not.toContain(url)
  })

  it('accepts a local stand-in in development', () => {
    expect(load({ NODE_ENV: 'development', DOVESOFT_BASE_URL: 'http://localhost:4010' }).DOVESOFT_BASE_URL).toBe(
      'http://localhost:4010',
    )
  })

  it('never puts the key in the refusal of a malformed one', () => {
    let message = ''
    try {
      load({ DOVESOFT_API_KEY: 'k3y!' })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/DOVESOFT_API_KEY/)
    expect(message).not.toContain('k3y!')
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
 * The worker's half of the opt-out alarm posts to whatever this names, so the
 * host is pinned exactly as the web app pins it: a value pointing at the cloud
 * metadata endpoint would carry every alarm there. The URL is the credential,
 * so a refusal names the variable and never the value.
 */
describe('SLACK_WEBHOOK_URL', () => {
  it('accepts a Slack incoming webhook', () => {
    const url = 'https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXXXXXXXXXX'
    expect(load({ SLACK_WEBHOOK_URL: url }).SLACK_WEBHOOK_URL).toBe(url)
  })

  it('is unset when absent — no alarm, not a failed one', () => {
    expect(load({}).SLACK_WEBHOOK_URL).toBeUndefined()
  })

  it.each([
    ['plain http', 'http://hooks.slack.com/services/T0000/B0000/secret-token-1'],
    ['the metadata endpoint', 'https://169.254.169.254/services/T0000/B0000/secret-token-2'],
    ['a look-alike host', 'https://hooks.slack.com.evil.example/services/secret-token-3'],
    ['another Slack host', 'https://slack.com/services/T0000/B0000/secret-token-4'],
  ])('refuses %s, naming the variable and never the value', (_why, url) => {
    let message = ''
    try {
      load({ SLACK_WEBHOOK_URL: url })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/SLACK_WEBHOOK_URL/)
    expect(message).not.toContain('secret-token')
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
