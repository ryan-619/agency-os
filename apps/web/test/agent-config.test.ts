/**
 * The one reading of AGENT_URL and AGENT_INTERNAL_TOKEN.
 *
 * On 2026-10-02 a deploy picked up a malformed chat value, `env()` threw, and
 * every page answered 500 — the one-click unsubscribe and the inbound
 * webhooks, a STOP included — while /api/health blamed the database (review
 * round 15). The two variables are read loosely by `env()` now and judged
 * here: a value that cannot be used turns chat OFF, by name, and nothing else.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_TOKEN_MIN_LENGTH, agentConfigFrom, agentMisconfiguredSentence } from '../src/lib/agent-config'

const TOKEN = 'f'.repeat(64)

describe('agentConfigFrom', () => {
  it('is configured with an absolute http(s) address and a whole token, and drops a trailing slash', () => {
    expect(agentConfigFrom({ AGENT_URL: 'https://calm-otter-42.ngrok-free.app', AGENT_INTERNAL_TOKEN: TOKEN })).toEqual({
      state: 'configured',
      url: 'https://calm-otter-42.ngrok-free.app',
      token: TOKEN,
    })
    expect(agentConfigFrom({ AGENT_URL: 'https://calm-otter-42.ngrok-free.app//', AGENT_INTERNAL_TOKEN: TOKEN })).toMatchObject({
      state: 'configured',
      url: 'https://calm-otter-42.ngrok-free.app',
    })
    // compose's in-cluster name, over plain http
    expect(agentConfigFrom({ AGENT_URL: 'http://agent:3002', AGENT_INTERNAL_TOKEN: TOKEN }).state).toBe('configured')
  })

  it('trims what a dashboard paste leaves around a value', () => {
    expect(agentConfigFrom({ AGENT_URL: ' https://x.ngrok-free.app\n', AGENT_INTERNAL_TOKEN: `${TOKEN}\n` })).toEqual({
      state: 'configured',
      url: 'https://x.ngrok-free.app',
      token: TOKEN,
    })
  })

  it('is not configured when either is missing or blank — an absence, not a fault', () => {
    expect(agentConfigFrom({})).toEqual({ state: 'not_configured' })
    expect(agentConfigFrom({ AGENT_URL: 'https://x.ngrok-free.app' })).toEqual({ state: 'not_configured' })
    expect(agentConfigFrom({ AGENT_INTERNAL_TOKEN: TOKEN })).toEqual({ state: 'not_configured' })
    expect(agentConfigFrom({ AGENT_URL: '  ', AGENT_INTERNAL_TOKEN: '' })).toEqual({ state: 'not_configured' })
  })

  it.each([
    ['a bare domain, the 2026-10-02 shape', 'calm-otter-42.ngrok-free.app'],
    ['a scheme that is not http', 'ftp://calm-otter-42.ngrok-free.app'],
    ['an address carrying credentials', 'https://user:pass@calm-otter-42.ngrok-free.app'],
    ['not a URL at all', 'https//calm-otter'],
  ])('names AGENT_URL for %s', (_label, url) => {
    expect(agentConfigFrom({ AGENT_URL: url, AGENT_INTERNAL_TOKEN: TOKEN })).toEqual({
      state: 'misconfigured',
      variables: ['AGENT_URL'],
    })
  })

  it('names a token shorter than the worker accepts, and both when both are wrong', () => {
    const short = 't'.repeat(AGENT_TOKEN_MIN_LENGTH - 1)
    expect(agentConfigFrom({ AGENT_URL: 'https://x.ngrok-free.app', AGENT_INTERNAL_TOKEN: short })).toEqual({
      state: 'misconfigured',
      variables: ['AGENT_INTERNAL_TOKEN'],
    })
    expect(agentConfigFrom({ AGENT_URL: 'x.ngrok-free.app', AGENT_INTERNAL_TOKEN: short })).toEqual({
      state: 'misconfigured',
      variables: ['AGENT_URL', 'AGENT_INTERNAL_TOKEN'],
    })
    // A malformed value is named even while its partner is missing.
    expect(agentConfigFrom({ AGENT_URL: 'x.ngrok-free.app' })).toEqual({ state: 'misconfigured', variables: ['AGENT_URL'] })
  })
})

describe('agentMisconfiguredSentence', () => {
  it('names the variable and the shape it needs, and says chat alone is off', () => {
    const s = agentMisconfiguredSentence(['AGENT_URL'])
    expect(s).toContain('AGENT_URL is set here but is not a full http(s) address')
    expect(s).toContain('https://')
    expect(s).toContain('So chat is off.')
    expect(s).toContain('everything else here works without it')
    expect(agentMisconfiguredSentence(['AGENT_INTERNAL_TOKEN'])).toContain(
      `AGENT_INTERNAL_TOKEN is set here but is shorter than ${AGENT_TOKEN_MIN_LENGTH} characters`,
    )
  })

  it('takes names only — it has no way to print a value', () => {
    expect(agentMisconfiguredSentence.length).toBe(1)
    const both = agentMisconfiguredSentence(['AGENT_URL', 'AGENT_INTERNAL_TOKEN'])
    expect(both).toContain('AGENT_URL')
    expect(both).toContain('AGENT_INTERNAL_TOKEN')
  })
})

describe('every reader goes through it', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

  it('the worker client reads neither variable raw', () => {
    const agent = src('lib/agent.ts')
    expect(agent).toContain('agentConfigFrom(env())')
    expect(agent).not.toMatch(/e\.AGENT_URL|e\.AGENT_INTERNAL_TOKEN/)
  })

  it('the deployment flags read through it', () => {
    const facts = src('lib/deployment-facts.ts')
    expect(facts).toContain('agentConfigFrom(e)')
    expect(facts).not.toMatch(/Boolean\(e\.AGENT_URL/)
  })

  it('env() holds neither to a schema that can throw for the whole app', () => {
    const env = src('lib/env.ts')
    expect(env).toMatch(/AGENT_URL: z\.preprocess\(blankIsUnset, z\.string\(\)\.optional\(\)\)/)
    expect(env).toMatch(/AGENT_INTERNAL_TOKEN: z\.preprocess\(blankIsUnset, z\.string\(\)\.optional\(\)\)/)
  })

  /**
   * The health route checks the error by NAME, so a test holds the name the
   * route looks for equal to the one env() throws.
   */
  it('/api/health tells an environment that does not parse from a database that is down', () => {
    const route = src('app/api/health/route.ts')
    expect(route).toContain("err.name === 'InvalidEnvironmentError'")
    expect(route).toContain("config: 'invalid'")
    expect(route).toContain("database: 'not_checked'")
    expect(src('lib/env.ts')).toContain("override readonly name = 'InvalidEnvironmentError'")
  })

  it('the one-click unsubscribe reads env() inside a try, and says an opt-out was lost', () => {
    const route = src('app/api/unsubscribe/[token]/route.ts')
    const at = route.indexOf('secret = env().UNSUBSCRIBE_SECRET')
    expect(at).toBeGreaterThan(-1)
    expect(route.slice(Math.max(0, at - 80), at)).toContain('try {')
    expect(route).toContain('OPT-OUT NOT RECORDED — the web app’s environment does not parse')
  })
})
