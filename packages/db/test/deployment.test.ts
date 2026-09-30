/**
 * Can the documented stack actually boot?
 *
 * `docker compose up --build -d` is the first command in CLAUDE.md and the
 * promise Phase 0 makes. It was broken for the whole of Phase 2 and nothing
 * noticed, because nothing here runs Docker: the worker requires
 * `AGENT_INTERNAL_TOKEN` (32 characters minimum, `loadEnv` refuses without it)
 * and no compose service set it, so the `agent` container died on boot; and
 * the `web` service was never given `AGENT_URL`, so even a healthy worker was
 * invisible to the app.
 *
 * Neither is catchable by a typechecker or by any test that imports code. Both
 * are catchable by reading the env schema and the compose file and comparing
 * them, which is what this does. It is a lint with assertions, and it lives in
 * the test suite because that is what runs.
 *
 * It deliberately does NOT start Docker. The check is "every variable the apps
 * require is supplied and documented", not "the image works" — that needs a
 * machine with Docker and belongs in CI.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { loadEnv as loadAgentEnv } from '../../../apps/agent/src/env.js'
import { loadEnv as loadVoiceEnv, voiceMode } from '../../../apps/voice/src/env.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

const compose = read('docker-compose.yml')
const envExample = read('.env.example')
const agentEnvSource = read('apps/agent/src/env.ts')
const webEnvSource = read('apps/web/src/lib/env.ts')

/** The two secrets `.env.example` leaves for the operator to generate. */
const SECRETS = { AUTH_SECRET: 'a'.repeat(44), AGENT_INTERNAL_TOKEN: 'b'.repeat(44) }

/**
 * The variables a zod env schema REQUIRES — no `.default(...)` and no
 * `.optional()` on the line. Read from the source because no schema object is
 * exported, and the web app's is reachable only through a memoised `env()`
 * that reads this process's own environment — which would assert about the
 * machine instead of the repo. (The worker's and the voice service's
 * `loadEnv` take their source as an argument, which is how the boot checks
 * at the end of this file call them.)
 */
function requiredVars(source: string): string[] {
  const body = source.slice(source.indexOf('z.object({'))
  const names: string[] = []
  for (const line of body.split('\n')) {
    const m = /^\s{2}([A-Z][A-Z0-9_]*):\s*z\./.exec(line)
    if (!m?.[1]) continue
    if (line.includes('.default(') || line.includes('.optional()')) continue
    names.push(m[1])
  }
  return names
}

/** Every `KEY: value` under one compose service's `environment:` block, value as written. */
function serviceEnvEntries(service: string): Map<string, string> {
  const start = compose.indexOf(`\n  ${service}:\n`)
  expect(start, `docker-compose.yml has no service "${service}"`).toBeGreaterThan(-1)
  const rest = compose.slice(start + 1)
  const end = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/)
  const block = end === -1 ? rest : rest.slice(0, end)
  const envStart = block.indexOf('\n    environment:')
  if (envStart === -1) return new Map()
  const envBlock = block.slice(envStart + 1).split(/\n {4}[a-z]/)[0] ?? ''
  const entries = new Map<string, string>()
  for (const line of envBlock.split('\n')) {
    const m = /^\s{6}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line)
    if (m?.[1]) entries.set(m[1], (m[2] ?? '').replace(/^"(.*)"$/, '$1'))
  }
  return entries
}

/** Every `KEY:` under one compose service's `environment:` block. */
function serviceEnv(service: string): Set<string> {
  return new Set(serviceEnvEntries(service).keys())
}

/**
 * What compose would hand a service's container, given the variables its
 * `.env` holds: `${X:-default}` and `${X:?message}` resolved the way compose
 * resolves them, the colon meaning "unset OR empty". A `:?` that would fire
 * throws, because compose would refuse to start rather than start the service.
 */
function renderServiceEnv(service: string, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, raw] of serviceEnvEntries(service)) {
    out[name] = raw.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)([-?])([^}]*))?\}/g,
      (_all, v: string, colon: string | undefined, op: string | undefined, arg: string | undefined) => {
        const value = vars[v]
        const missing = colon ? value === undefined || value === '' : value === undefined
        if (op === '-') return missing ? (arg ?? '') : (value as string)
        if (op === '?' && missing) throw new Error(`compose refuses to start: ${v} — ${arg}`)
        return value ?? ''
      },
    )
  }
  return out
}

const documented = new Set(
  envExample
    .split('\n')
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n)),
)

describe('the agent worker can boot in the documented stack', () => {
  const required = requiredVars(agentEnvSource)

  it('reads more than one required variable, so the parser is not vacuous', () => {
    expect(required).toContain('DATABASE_URL')
    expect(required).toContain('AGENT_INTERNAL_TOKEN')
  })

  it.each(requiredVars(agentEnvSource))('compose gives the agent %s', (name) => {
    expect(serviceEnv('agent').has(name)).toBe(true)
  })

  it.each(requiredVars(agentEnvSource))('.env.example documents %s', (name) => {
    expect(documented.has(name)).toBe(true)
  })

  /**
   * Each compose service is its own network namespace, so a worker bound to
   * loopback is reachable from nothing but itself — and it says nothing about
   * it in any log. The `web` container's calls are simply refused.
   */
  it('binds the internal API to something the web container can reach', () => {
    expect(serviceEnv('agent').has('AGENT_BIND')).toBe(true)
    expect(compose).toMatch(/AGENT_BIND:\s*0\.0\.0\.0/)
  })

  /**
   * ...which is only acceptable because the port is not published. An
   * unauthenticated-at-the-network-layer endpoint that starts agent turns must
   * not be on the host interface.
   */
  it('does not publish the internal API port to the host', () => {
    const agentBlock = compose.slice(compose.indexOf('\n  agent:\n'))
    const ports = (/ports:\n((?:\s+#.*\n|\s+- .*\n)+)/.exec(agentBlock)?.[1] ?? '')
      .split('\n')
      .filter((l) => l.trim().startsWith('- '))
      .join('\n')
    expect(ports.length, 'the agent publishes no ports at all').toBeGreaterThan(0)
    expect(ports).not.toMatch(/3002/)
  })
})

describe('the web app can reach the agent worker', () => {
  it('is given the worker address and the shared token', () => {
    const web = serviceEnv('web')
    expect(web.has('AGENT_URL')).toBe(true)
    expect(web.has('AGENT_INTERNAL_TOKEN')).toBe(true)
  })

  /**
   * The worker serves health on AGENT_PORT and the internal API on
   * AGENT_PORT + 1. Pointing AGENT_URL at the health port gives a 404 on every
   * turn, which surfaces as "the agent could not start" with nothing saying
   * why.
   */
  it('points at the API port, not the health port', () => {
    expect(compose).toMatch(/AGENT_URL:\s*\$\{AGENT_URL:-http:\/\/agent:3002\}/)
    expect(envExample).toMatch(/AGENT_URL=http:\/\/127\.0\.0\.1:3002/)
  })

  it('uses the same token variable in both services, so they agree by construction', () => {
    const uses = compose.match(/AGENT_INTERNAL_TOKEN: "\$\{AGENT_INTERNAL_TOKEN:\?/g) ?? []
    expect(uses.length).toBe(2)
  })

  it.each(requiredVars(webEnvSource))('.env.example documents the web app’s %s', (name) => {
    expect(documented.has(name)).toBe(true)
  })
})

describe('the skills volume', () => {
  /**
   * A skill is instructions the agent follows on every later turn. A writable
   * mount would let anything that reaches the worker rewrite them — which is
   * a prompt-injection surface with no expiry and no audit trail.
   */
  it('is mounted read-only', () => {
    const agentBlock = compose.slice(compose.indexOf('\n  agent:\n'))
    const mount = /- \.\/skills:[^\n]*/.exec(agentBlock)?.[0] ?? ''
    expect(mount, 'the agent has no skills mount').not.toBe('')
    expect(mount).toMatch(/:ro\s*$/)
  })

  it('is what AGENT_SKILLS_DIR points at', () => {
    expect(compose).toMatch(/AGENT_SKILLS_DIR:\s*\/app\/skills/)
    expect(compose).toMatch(/- \.\/skills:\/app\/skills:ro/)
  })

  /**
   * Unset means no skills AND no project setting source, which is the safe
   * default. Requiring it would make `docker compose up` fail on a stack that
   * has no skills — and would push people to set it to something arbitrary.
   */
  it('is optional, and documented', () => {
    expect(documented.has('AGENT_SKILLS_DIR')).toBe(true)
    expect(compose).not.toMatch(/AGENT_SKILLS_DIR:\s*"?\$\{AGENT_SKILLS_DIR:\?/)
  })
})

describe('what compose refuses to start without', () => {
  /**
   * `${VAR:?message}` makes compose fail with that message instead of starting
   * a container that will die on boot. Every variable with no safe default
   * belongs in this form — a stack that half-starts is harder to diagnose than
   * one that refuses.
   */
  it.each(['AUTH_SECRET', 'AGENT_INTERNAL_TOKEN', 'SEED_OWNER_EMAIL'])(
    'fails loudly when %s is unset',
    (name) => {
      expect(compose).toMatch(new RegExp(`\\$\\{${name}:\\?`))
    },
  )

  /**
   * The one-off tasks run the db CLI, which needs only a connection string.
   * Requiring the agent's variables there would make `docker compose run --rm
   * migrate` fail on a stack that has no agent configured yet.
   */
  it('does not impose the agent’s variables on the migrate task', () => {
    expect(serviceEnv('migrate')).toEqual(new Set(['DATABASE_URL']))
  })
})

/**
 * `cp .env.example .env` is the first step in CLAUDE.md, and the example
 * documents every optional variable as a blank `NAME=`. The worker and the
 * voice service used to refuse to boot on five of those blanks — a URL, a
 * uuid, an enum and a length-checked secret — so the lines were commented
 * out of the example instead. Now a blank is unset in all three processes,
 * the lines are back, and this parses the file exactly as `node --env-file`
 * does and runs each process's own schema over it, so it cannot regress
 * without somebody seeing it. The web app's half is in apps/web/test/env.test.ts.
 */
describe('a copied .env.example boots the worker and the voice service', () => {
  const copied = { ...parseEnv(envExample), ...SECRETS } as NodeJS.ProcessEnv

  it('documents the variables that used to have to be commented out, as blank lines', () => {
    for (const name of ['LLM_PROVIDER', 'UNSUBSCRIBE_SECRET', 'WEB_PUBLIC_URL', 'VOICE_PUBLIC_URL', 'VOICE_ORG_ID']) {
      expect(envExample).toMatch(new RegExp(`^${name}=$`, 'm'))
    }
  })

  it('leaves exactly the two secrets blank that nothing can default', () => {
    const parsed = parseEnv(envExample)
    expect(parsed['AUTH_SECRET']).toBe('')
    expect(parsed['AGENT_INTERNAL_TOKEN']).toBe('')
  })

  it('the worker', () => {
    const env = loadAgentEnv(copied)
    expect(env.LLM_PROVIDER).toBeUndefined()
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(env.WEB_PUBLIC_URL).toBeUndefined()
    expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
  })

  it('the voice service', () => {
    const env = loadVoiceEnv(copied)
    expect(env.VOICE_PUBLIC_URL).toBeUndefined()
    expect(env.VOICE_ORG_ID).toBeUndefined()
    expect(voiceMode(env)).toBe('disabled')
  })
})

/**
 * Compose hands each container `${NAME:-}` — an EMPTY STRING — for every
 * optional variable nobody set. That is how the voice container came to
 * refuse to boot unless VOICE_PUBLIC_URL and VOICE_ORG_ID were both set,
 * while this file's comment said an unset URL made it boot and refuse
 * webhooks. Rendered the way compose renders it, from a copied .env and from
 * nothing at all.
 */
describe('the environment compose hands each container boots it', () => {
  const cases = [
    ['a copied .env.example', { ...parseEnv(envExample), ...SECRETS }],
    ['nothing configured but the two secrets', { ...SECRETS }],
  ] as const

  it.each(cases)('the worker, from %s', (_name, vars) => {
    const env = loadAgentEnv(renderServiceEnv('agent', vars))
    expect(env.AGENT_BIND).toBe('0.0.0.0')
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(env.WEB_PUBLIC_URL).toBeUndefined()
    expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
  })

  it.each(cases)('the voice service, from %s', (_name, vars) => {
    const rendered = renderServiceEnv('voice', vars)
    // The two that used to stop it — present, and blank.
    expect(rendered['VOICE_PUBLIC_URL']).toBe('')
    expect(rendered['VOICE_ORG_ID']).toBe('')
    const env = loadVoiceEnv(rendered)
    expect(env.VOICE_PUBLIC_URL).toBeUndefined()
    expect(voiceMode(env)).toBe('disabled')
  })

  it('refuses to render without the secrets, as compose does', () => {
    expect(() => renderServiceEnv('agent', {})).toThrow(/AGENT_INTERNAL_TOKEN/)
  })

  it('carries a value set in .env through to the container', () => {
    const url = 'https://agency.example'
    const env = loadAgentEnv(renderServiceEnv('agent', { ...SECRETS, WEB_PUBLIC_URL: url, OUTREACH_BOUNCE_PAUSE_PCT: '12' }))
    expect(env.WEB_PUBLIC_URL).toBe(url)
    expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(12)
  })
})

/**
 * The web block now wires its optional variables as `${NAME:-}`, because
 * compose has no `env_file:` and a variable it does not name never reaches
 * the container. That is only safe for a variable the web schema reads as
 * unset when blank — through `blankIsUnset`, or a plain optional string. A
 * `${AGENT_URL:-}` (a url) or `${RESCAN_BATCH_SIZE:-}` (coerced to 0, below
 * its minimum of 1) would stop the web container booting.
 */
describe('every empty default in the web block is one the web app reads as unset', () => {
  const emptyDefaults = [...serviceEnvEntries('web')].filter(([, v]) => /^\$\{[A-Z0-9_]+:-\}$/.test(v)).map(([k]) => k)

  it('finds the optional variables, so the check is not vacuous', () => {
    expect(emptyDefaults).toEqual(expect.arrayContaining(['CRON_SECRET', 'SLACK_WEBHOOK_URL', 'UNSUBSCRIBE_SECRET']))
  })

  it.each(emptyDefaults)('%s', (name) => {
    const line = webEnvSource.split('\n').find((l) => l.startsWith(`  ${name}: `)) ?? ''
    expect(line, `apps/web/src/lib/env.ts has no one-line entry for ${name}`).not.toBe('')
    expect(line.includes('blankIsUnset') || line.trim() === `${name}: z.string().optional(),`).toBe(true)
  })
})
