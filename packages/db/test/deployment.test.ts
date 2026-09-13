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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

const compose = read('docker-compose.yml')
const envExample = read('.env.example')
const agentEnvSource = read('apps/agent/src/env.ts')
const webEnvSource = read('apps/web/src/lib/env.ts')

/**
 * The variables a zod env schema REQUIRES — no `.default(...)` and no
 * `.optional()` on the line. Read from the source rather than by importing the
 * module, because importing it runs `loadEnv` against this process's own
 * environment and would assert about the machine instead of the repo.
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

/** Every `KEY:` under one compose service's `environment:` block. */
function serviceEnv(service: string): Set<string> {
  const start = compose.indexOf(`\n  ${service}:\n`)
  expect(start, `docker-compose.yml has no service "${service}"`).toBeGreaterThan(-1)
  const rest = compose.slice(start + 1)
  const end = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/)
  const block = end === -1 ? rest : rest.slice(0, end)
  const envStart = block.indexOf('\n    environment:')
  if (envStart === -1) return new Set()
  const envBlock = block.slice(envStart + 1).split(/\n {4}[a-z]/)[0] ?? ''
  return new Set(
    envBlock
      .split('\n')
      .map((l) => /^\s{6}([A-Z][A-Z0-9_]*):/.exec(l)?.[1])
      .filter((n): n is string => Boolean(n)),
  )
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
