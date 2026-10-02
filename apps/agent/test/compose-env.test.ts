/**
 * Does every container get the variables its app reads — and boot on them?
 *
 * Compose reads `.env` ONLY to fill the `${…}` in docker-compose.yml. There
 * is no `env_file`, and `.dockerignore` excludes `.env`, so a variable the
 * compose file does not name never reaches a container, whatever `.env`
 * holds. The file told operators to "set them in .env", and every optional
 * feature — one-click unsubscribe, the Slack notices, the Resend inbound
 * path, the crons, connector credentials from the web UI — stayed off under
 * compose while the operator believed it configured.
 *
 * So each app's optional variables must be NAMED in its service block, as
 * `NAME: ${NAME:-}`; and because that hands the container a blank for every
 * variable `.env` does not set, each app must boot on the blanks. Both are
 * checked here against the files, the way `packages/db/test/deployment.test.ts`
 * checks the required ones: by reading the compose file and the schemas, and
 * by running each process's own loadEnv over what compose would hand it.
 * Nothing here starts Docker.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { loadEnv as loadAgentEnv } from '../src/env.js'
import { loadEnv as loadVoiceEnv } from '../../voice/src/env.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')
const compose = read('docker-compose.yml')

/** Every `KEY: value` under one compose service's `environment:` block, the value as written. */
function serviceEnv(service: string): Map<string, string> {
  const start = compose.indexOf(`\n  ${service}:\n`)
  expect(start, `docker-compose.yml has no service "${service}"`).toBeGreaterThan(-1)
  const rest = compose.slice(start + 1)
  const end = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/)
  const block = end === -1 ? rest : rest.slice(0, end)
  const envStart = block.indexOf('\n    environment:')
  if (envStart === -1) return new Map()
  const envBlock = block.slice(envStart + 1).split(/\n {4}[a-z]/)[0] ?? ''
  const out = new Map<string, string>()
  for (const line of envBlock.split('\n')) {
    const m = /^\s{6}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line)
    if (!m?.[1]) continue
    const raw = (m[2] ?? '').trim()
    out.set(m[1], raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
  }
  return out
}

/** Compose's interpolation, for the three forms this file uses: `${X}`, `${X:-default}`, `${X:?message}`. */
function interpolate(value: string, dotenv: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::([-?])([^}]*))?\}/g, (_all, name: string, op?: string, arg?: string) => {
    const set = dotenv[name]
    if (set !== undefined && set !== '') return set
    if (op === '-') return arg ?? ''
    if (op === '?') throw new Error(`compose refuses to start without ${name}`)
    return ''
  })
}

/** What one container's environment would be, given this `.env`. */
function containerEnv(service: string, dotenv: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of serviceEnv(service)) out[name] = interpolate(value, dotenv)
  return out
}

/**
 * The variables a zod env schema declares, read from the source (not imported:
 * importing runs it). `z\b`, not `z\.`: an entry written across lines puts
 * nothing after the `z` on its first one.
 */
function declared(path: string): string[] {
  const source = read(path)
  const body = source.slice(source.indexOf('z.object({'))
  return [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*z\b/gm)].map((m) => m[1] ?? '')
}

/** The two secrets compose refuses to start without, and the seed's owner. Nothing else is set. */
const MINIMAL_DOTENV = {
  AUTH_SECRET: 'a'.repeat(44),
  AGENT_INTERNAL_TOKEN: 'b'.repeat(44),
  SEED_OWNER_EMAIL: 'owner@example.com',
}

/** `cp .env.example .env`, with every commented `# NAME=` line uncommented and the two secrets filled in. */
function exampleDotenv(): Record<string, string> {
  const text = read('.env.example')
    .split('\n')
    .map((line) => (/^#\s*[A-Z][A-Z0-9_]*=\s*$/.test(line.trim()) ? line.trim().replace(/^#\s*/, '') : line))
    .join('\n')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parseEnv(text))) if (v !== undefined) out[k] = v
  return { ...out, ...MINIMAL_DOTENV }
}

describe('compose names every optional variable an app reads', () => {
  /**
   * Not passed on purpose, each for a stated reason — the compose file says
   * which. Anything else the worker reads and compose does not pass is a
   * feature that cannot be switched on under compose.
   */
  const AGENT_NOT_PASSED = new Set([
    'AGENT_USE_LOCAL_LOGIN', // development only; refused under NODE_ENV=production
    'CLAUDE_CODE_PATH', // a path on a developer's machine, meaningless inside the image
    'APPROVAL_POLL_MS', // tuning knobs: the image uses the schema's defaults
    'APPROVAL_SWEEP_MS',
  ])
  const WEB_NOT_PASSED = new Set([
    'VERCEL_ENV', // set by the platform, never by hand; unset is what the cron routes expect here
  ])
  const VOICE_NOT_PASSED = new Set([
    'VOICE_MODEL', // declared and read by nothing: the scripted policy is the whole conversation (CLAUDE.md, Voice)
  ])

  it.each(declared('apps/agent/src/env.ts').filter((n) => !AGENT_NOT_PASSED.has(n)))('the agent receives %s', (name) => {
    expect(serviceEnv('agent').has(name)).toBe(true)
  })

  it.each(declared('apps/web/src/lib/env.ts').filter((n) => !WEB_NOT_PASSED.has(n)))('the web app receives %s', (name) => {
    expect(serviceEnv('web').has(name)).toBe(true)
  })

  /**
   * The voice service's summary model (§5.5) could not be switched on under
   * compose at all: none of its LLM_* reached the container, so every call
   * got the deterministic summary whatever .env said.
   */
  it.each(declared('apps/voice/src/env.ts').filter((n) => !VOICE_NOT_PASSED.has(n)))('the voice service receives %s', (name) => {
    expect(serviceEnv('voice').has(name)).toBe(true)
  })

  /** The variables the review found missing, named, so the lists above cannot pass vacuously. */
  it.each([
    ['web', 'CRON_SECRET'], ['web', 'SLACK_WEBHOOK_URL'], ['web', 'UNSUBSCRIBE_SECRET'],
    ['web', 'RESEND_WEBHOOK_SECRET'], ['web', 'RESEND_API_KEY'], ['web', 'INBOUND_WEBHOOK_SECRET'],
    ['web', 'SECRETS_KEY'],
    ['agent', 'UNSUBSCRIBE_SECRET'], ['agent', 'WEB_PUBLIC_URL'], ['agent', 'OUTREACH_BOUNCE_PAUSE_PCT'],
    ['agent', 'SLACK_WEBHOOK_URL'],
    ['agent', 'DOVESOFT_API_KEY'], ['agent', 'DOVESOFT_ENTITY_ID'], ['agent', 'DOVESOFT_BASE_URL'],
    ['voice', 'LLM_PROVIDER'], ['voice', 'LLM_MODEL'], ['voice', 'OLLAMA_BASE_URL'], ['voice', 'OLLAMA_IS_LOCAL'],
    ['voice', 'LLM_ALLOW_REMOTE_LEAD_DATA'], ['voice', 'OPENAI_API_KEY'], ['voice', 'ANTHROPIC_API_KEY'],
    ['voice', 'VOICE_HANDOFF_USER_EMAIL'],
  ])('%s receives %s', (service, name) => {
    expect(serviceEnv(service).has(name)).toBe(true)
  })

  /** A schema variable skipped here must still be one the schema declares — or the reason is stale. */
  it('lists only variables the schemas still declare as deliberately not passed', () => {
    // Not vacuous: the multi-line entries are read too.
    expect(declared('apps/agent/src/env.ts')).toEqual(expect.arrayContaining(['AGENT_USE_LOCAL_LOGIN', 'IMAP_SECURE', 'LLM_ALLOW_REMOTE_LEAD_DATA']))
    expect(declared('apps/web/src/lib/env.ts')).toEqual(expect.arrayContaining(['DATABASE_URL', 'AUTH_URL', 'AUTH_TRUST_HOST']))
    expect(declared('apps/voice/src/env.ts')).toEqual(expect.arrayContaining(['VOICE_PUBLIC_URL', 'OLLAMA_IS_LOCAL', 'LLM_ALLOW_REMOTE_LEAD_DATA']))
    const agent = new Set(declared('apps/agent/src/env.ts'))
    const web = new Set(declared('apps/web/src/lib/env.ts'))
    const voice = new Set(declared('apps/voice/src/env.ts'))
    for (const name of AGENT_NOT_PASSED) expect(agent.has(name), name).toBe(true)
    for (const name of WEB_NOT_PASSED) expect(web.has(name), name).toBe(true)
    for (const name of VOICE_NOT_PASSED) expect(voice.has(name), name).toBe(true)
  })

  /** VOICE_MODEL's reason holds only while nothing in the service reads it. */
  it('passes no VOICE_MODEL because nothing in apps/voice reads it', () => {
    expect(serviceEnv('voice').has('VOICE_MODEL')).toBe(false)
    const readers = readdirSync(resolve(root, 'apps/voice/src')).filter((f) => f.endsWith('.ts') && f !== 'env.ts')
    expect(readers.length).toBeGreaterThan(3)
    for (const file of readers) expect(read(`apps/voice/src/${file}`), file).not.toContain('VOICE_MODEL')
  })

  /** The one-shot tasks need a connection string and nothing else. */
  it('still imposes nothing on the migrate task', () => {
    expect([...serviceEnv('migrate').keys()]).toEqual(['DATABASE_URL'])
  })
})

describe('every service boots on what compose hands it', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  /** The web app memoises its env() and reads process.env, so it is loaded fresh over a stubbed one. */
  async function bootWeb(vars: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
    vi.resetModules()
    for (const name of declared('apps/web/src/lib/env.ts')) vi.stubEnv(name, undefined)
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
    const path = resolve(root, 'apps/web/src/lib/env.ts')
    const mod = (await import(path)) as { env: () => Record<string, unknown> }
    return mod.env()
  }

  describe.each([
    ['an .env holding only the two secrets', MINIMAL_DOTENV],
    ['cp .env.example .env', exampleDotenv()],
  ])('with %s', (_name, dotenv) => {
    it('boots the worker, with every feature behind a blank off', () => {
      const env = loadAgentEnv(containerEnv('agent', dotenv) as NodeJS.ProcessEnv)
      expect(env.NODE_ENV).toBe('production')
      expect(env.UNSUBSCRIBE_SECRET).toBeUndefined()
      expect(env.WEB_PUBLIC_URL).toBeUndefined()
      expect(env.LLM_PROVIDER).toBeUndefined()
      expect(env.SLACK_WEBHOOK_URL).toBeUndefined()
      // A blank threshold is the default, never 0 — which would pause a campaign on its first bounce.
      expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
      // SMS off, and DoveSoft's own API: the production rule passes on the default.
      expect(env.DOVESOFT_API_KEY).toBeUndefined()
      expect(env.DOVESOFT_ENTITY_ID).toBeUndefined()
      expect(env.DOVESOFT_BASE_URL).toBe('https://api.dovesoft.io')
    })

    it('boots the voice service, with the summary model off and lead data kept local', () => {
      const env = loadVoiceEnv(containerEnv('voice', dotenv) as NodeJS.ProcessEnv)
      expect(env.VOICE_PUBLIC_URL).toBeUndefined()
      expect(env.VOICE_ORG_ID).toBeUndefined()
      expect(env.VOICE_HANDOFF_USER_EMAIL).toBeUndefined()
      expect(env.LLM_PROVIDER).toBeUndefined()
      expect(env.LLM_MODEL).toBeUndefined()
      expect(env.OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434')
      // A blank is the default in both directions: declared local, and no consent to send lead data away.
      expect(env.OLLAMA_IS_LOCAL).toBe(true)
      expect(env.LLM_ALLOW_REMOTE_LEAD_DATA).toBe(false)
      expect(env.OPENAI_API_KEY || undefined).toBeUndefined()
      expect(env.ANTHROPIC_API_KEY || undefined).toBeUndefined()
    })

    it('boots the web app, with every feature behind a blank off', async () => {
      const env = await bootWeb(containerEnv('web', dotenv))
      for (const name of ['CRON_SECRET', 'SLACK_WEBHOOK_URL', 'UNSUBSCRIBE_SECRET', 'RESEND_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INBOUND_WEBHOOK_SECRET']) {
        expect(env[name], name).toBeUndefined()
      }
      expect(env['RESCAN_BATCH_SIZE']).toBe(6)
    })
  })

  /** And a value set in .env now arrives: the whole point of the wiring. */
  it('delivers a configured value to both halves that need it', async () => {
    const secret = 'u'.repeat(40)
    const slack = 'https://hooks.slack.com/services/T0000/B0000/XXXXXXXX'
    const dotenv = {
      ...MINIMAL_DOTENV, UNSUBSCRIBE_SECRET: secret, WEB_PUBLIC_URL: 'https://agency.example.com', CRON_SECRET: 'c'.repeat(40),
      SLACK_WEBHOOK_URL: slack,
    }
    const agent = loadAgentEnv(containerEnv('agent', dotenv) as NodeJS.ProcessEnv)
    expect(agent.UNSUBSCRIBE_SECRET).toBe(secret)
    expect(agent.WEB_PUBLIC_URL).toBe('https://agency.example.com')
    expect(agent.SLACK_WEBHOOK_URL).toBe(slack)
    const web = await bootWeb(containerEnv('web', dotenv))
    expect(web['SLACK_WEBHOOK_URL']).toBe(slack)
    expect(web['UNSUBSCRIBE_SECRET']).toBe(secret)
    expect(web['CRON_SECRET']).toBe('c'.repeat(40))
  })

  /** SMS, configured in .env, reaches the worker — the only process that sends. */
  it('delivers the DoveSoft configuration to the worker', () => {
    const dotenv = {
      ...MINIMAL_DOTENV, DOVESOFT_API_KEY: 'dsk-0123456789', DOVESOFT_ENTITY_ID: '1101234567890123456',
      DOVESOFT_BASE_URL: 'https://gateway.dovesoft.example.com',
    }
    const agent = loadAgentEnv(containerEnv('agent', dotenv) as NodeJS.ProcessEnv)
    expect(agent.DOVESOFT_API_KEY).toBe('dsk-0123456789')
    expect(agent.DOVESOFT_ENTITY_ID).toBe('1101234567890123456')
    expect(agent.DOVESOFT_BASE_URL).toBe('https://gateway.dovesoft.example.com')
  })

  /** The summary model, configured once in .env, reaches the voice container — and the worker's triage, which reads the same names. */
  it('delivers the summary model to the voice service', () => {
    const dotenv = {
      ...MINIMAL_DOTENV, LLM_PROVIDER: 'ollama', LLM_MODEL: 'llama3.1', OLLAMA_BASE_URL: 'http://ollama:11434', OLLAMA_IS_LOCAL: 'false',
      LLM_ALLOW_REMOTE_LEAD_DATA: 'true', VOICE_HANDOFF_USER_EMAIL: 'owner@example.com',
    }
    const voice = loadVoiceEnv(containerEnv('voice', dotenv) as NodeJS.ProcessEnv)
    expect(voice.LLM_PROVIDER).toBe('ollama')
    expect(voice.LLM_MODEL).toBe('llama3.1')
    expect(voice.OLLAMA_BASE_URL).toBe('http://ollama:11434')
    expect(voice.OLLAMA_IS_LOCAL).toBe(false)
    expect(voice.LLM_ALLOW_REMOTE_LEAD_DATA).toBe(true)
    expect(voice.VOICE_HANDOFF_USER_EMAIL).toBe('owner@example.com')
    const agent = loadAgentEnv(containerEnv('agent', dotenv) as NodeJS.ProcessEnv)
    expect(agent.LLM_PROVIDER).toBe('ollama')
  })

  it('still refuses to start without the two secrets', () => {
    expect(() => containerEnv('agent', {})).toThrow(/AGENT_INTERNAL_TOKEN/)
    expect(() => containerEnv('web', { AGENT_INTERNAL_TOKEN: 'b'.repeat(44) })).toThrow(/AUTH_SECRET/)
  })
})
