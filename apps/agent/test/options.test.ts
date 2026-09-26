/**
 * The `query()` options.
 *
 * Most of this file is about what is NOT set. The SDK documents three ways
 * `canUseTool` is skipped entirely, PROMPT.md §6 and §7 recommend two of them,
 * and each is one property away. So the options object is asserted key by key,
 * against a frozen list — an SDK upgrade that adds a new permission knob
 * cannot be adopted silently, and a contributor who wants one has to edit the
 * list in the same commit, where a reviewer sees it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  ALLOWED_OPTION_KEYS, FORBIDDEN_TOOLS, buildQueryOptions, childEnv, systemPrompt,
} from '../src/runtime/options.js'

const fixture = () =>
  buildQueryOptions({
    canUseTool: async () => ({ behavior: 'allow' }),
    mcpServers: {},
    agents: {},
    skills: { settingSources: [] },
    hooks: {},
    systemPrompt: 'you are a test',
    cwd: '/tmp/agency',
    abortController: new AbortController(),
    maxTurns: 30,
    maxBudgetUsd: 2,
    env: { ANTHROPIC_API_KEY: 'k' },
  })

describe('the option keyset is frozen', () => {
  it('sets exactly the keys on the allow-list, and nothing else', () => {
    const keys = Object.keys(fixture()).sort()
    const allowed = [...ALLOWED_OPTION_KEYS]
      .filter((k) => !['resume', 'model', 'skills', 'pathToClaudeCodeExecutable'].includes(k))
      .sort()
    expect(keys).toEqual(allowed)
  })

  it('adds resume and model only when they were asked for', () => {
    const withBoth = buildQueryOptions({
      canUseTool: async () => ({ behavior: 'allow' }),
      mcpServers: {},
      agents: {},
      skills: { settingSources: [] },
      hooks: {},
      systemPrompt: 's',
      cwd: '/tmp',
      abortController: new AbortController(),
      maxTurns: 1,
      maxBudgetUsd: 1,
      resume: 'sdk-session-1',
      model: 'claude-sonnet-5',
      env: {},
    })
    expect(withBoth.resume).toBe('sdk-session-1')
    expect(withBoth.model).toBe('claude-sonnet-5')
    expect('resume' in fixture()).toBe(false)
  })
})

describe('the three documented bypasses are closed', () => {
  /**
   * (a) "auto-approves every tool call (except explicit deny rules) before the
   * callback is consulted."
   */
  it('never sets a permission mode that skips the callback', () => {
    const o = fixture()
    expect(o.permissionMode).toBe('default')
    expect(o.allowDangerouslySkipPermissions).toBe(false)
    expect(o.permissionPrompts).toBe('host')
  })

  /**
   * (b) "Bare allowedTools entries auto-approve the whole tool before the
   * callback is consulted." §6 recommends `mcp__apollo__*` and §7 recommends
   * "Agent"; both are bare, and both are refused.
   */
  it('leaves allowedTools empty, including the entries the spec suggests', () => {
    expect(fixture().allowedTools).toEqual([])
  })

  /**
   * (c) "Allow rules from settings files can also shadow the callback but are
   * not visible here." Invisible is the operative word.
   */
  it('loads no settings sources at all', () => {
    expect(fixture().settingSources).toEqual([])
  })

  /**
   * The ONE exception, and the only one there will be.
   *
   * Skills are discovered only with the project source loaded — measured, not
   * assumed (see skills.test.ts for the numbers). So `inspectSkillsRoot`
   * decides, and it says `['project']` only after proving the skills volume
   * contains no settings file, no agents, no commands, no hooks. Anything
   * else setting this array is the bug these tests exist to catch.
   */
  it('takes the project source only when the skills volume asked for it', () => {
    const withSkills = buildQueryOptions({
      canUseTool: async () => ({ behavior: 'allow' }),
      mcpServers: {},
      agents: {},
      skills: { settingSources: ['project'], skills: 'all' },
      hooks: {},
      systemPrompt: 's',
      cwd: '/tmp',
      abortController: new AbortController(),
      maxTurns: 1,
      maxBudgetUsd: 1,
      env: {},
    })
    expect(withSkills.settingSources).toEqual(['project'])
    expect(withSkills.skills).toBe('all')
    // And it still buys no allowance anywhere else. The SDK says of `skills`:
    // "This is the single place to turn skills on; you do not need to add
    // 'Skill' to allowedTools yourself" — so §6's suggestion to add it costs a
    // bypass and buys nothing.
    expect(withSkills.allowedTools).toEqual([])
    expect(withSkills.permissionMode).toBe('default')
  })

  it('omits `skills` entirely when they are off, which is not the same as empty', () => {
    // The SDK: an absent `skills` means "no SDK auto-configuration — the CLI's
    // own defaults still apply", which it says is NOT skills off. With no
    // project setting source there is nothing for those defaults to find.
    expect('skills' in fixture()).toBe(false)
  })

  /**
   * The policy tier, above configuration — which drifts. Exactly two keys
   * survive the SDK's restrictive-only filter, and both matter.
   */
  it('locks all three at the managed-settings tier as well', () => {
    const managed = fixture().managedSettings as Record<string, unknown>
    expect(managed['allowManagedPermissionRulesOnly']).toBe(true)
    expect((managed['permissions'] as Record<string, unknown>)['disableBypassPermissionsMode']).toBe('disable')
    // Silently dropped by the filter, so setting it would read as protection
    // that is not there.
    expect((managed['permissions'] as Record<string, unknown>)['defaultMode']).toBeUndefined()
  })

  it('sets a gate at all', () => {
    expect(typeof fixture().canUseTool).toBe('function')
  })
})

describe('the agent has no shell, no filesystem and no web', () => {
  it('enables no built-in tools', () => {
    expect(fixture().tools).toEqual([])
  })

  it('denies the dangerous ones by name as well, since the default set cannot be read from the types', () => {
    const denied = fixture().disallowedTools ?? []
    for (const t of ['Bash', 'Read', 'Write', 'WebFetch', 'Skill']) {
      expect(denied, t).toContain(t)
    }
    expect(denied).toEqual([...FORBIDDEN_TOOLS])
  })

  it('accepts only the MCP servers it was handed', () => {
    expect(fixture().strictMcpConfig).toBe(true)
  })

  /**
   * §7's subagents arrived in Phase 3, built against a frozen key whitelist
   * (see agents.test.ts) — `AgentDefinition` carries its own `permissionMode`,
   * so a mapper that spread a database row would open the gate from inside a
   * settings form.
   *
   * The rest stay unset. Each is a way to reach the model or the tool set
   * around the options this file asserts, and none has a reason to be here.
   */
  it('passes the subagents it was handed, and sets nothing else', () => {
    const o = fixture() as Record<string, unknown>
    expect(o['agents']).toEqual({})
    for (const key of [
      'skills',
      'plugins',
      'toolAliases',
      'permissionPromptToolName',
      'extraArgs',
      'settings',
    ]) {
      expect(o[key], key).toBeUndefined()
    }
  })
})

describe('the child environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /**
   * §2.3: no credential in an agent's context window. `env` REPLACES the
   * subprocess environment rather than extending it, so the child gets the API
   * key and nothing else — in particular not DATABASE_URL, which would be one
   * Bash('env') away if a future change re-enabled a shell.
   */
  it('carries the API key and not the database credentials', () => {
    const env = childEnv({ kind: 'api_key', apiKey: 'sk-ant-test' })
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-test')
    expect(Object.keys(env)).not.toContain('DATABASE_URL')
    expect(Object.keys(env)).not.toContain('AUTH_SECRET')
    expect(Object.keys(env)).not.toContain('SMTP_PASSWORD')
  })

  it('bounds a subagent fan-out', () => {
    const env = childEnv({ kind: 'api_key', apiKey: 'k' })
    expect(env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS']).toBeDefined()
    expect(env['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']).toBeDefined()
  })

  it('is passed to the query, so the subprocess inherits nothing by default', () => {
    expect(fixture().env).toEqual({ ANTHROPIC_API_KEY: 'k' })  // the fixture passes this env verbatim
  })

  /**
   * The developer's own Claude Code login (§13). The variable is ABSENT, not
   * empty, and that distinction decides the outcome: the SDK takes the first
   * credential source that MATCHES, so an empty ANTHROPIC_API_KEY is a match
   * that then fails to authenticate — surfacing as a bad key rather than as a
   * variable that should not have been set at all.
   */
  /**
   * An ORGANISATION-scoped key authenticates and is then refused on every
   * request — `/v1/messages` included — with "This API key is not scoped to a
   * workspace". It comes back as a 400, not a 401, so it does not read as a
   * credential problem: the key looks broken when it is only unscoped. The
   * child env is built from scratch, so the header's variable has to be named
   * here or it is stripped, which is the USER bug's shape exactly.
   */
  it('passes the workspace id as a custom HEADER, not as ANTHROPIC_WORKSPACE_ID', () => {
    const env = childEnv({ kind: 'api_key', apiKey: 'sk-ant-x', workspaceId: 'wrkspc_1' })
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('anthropic-workspace-id: wrkspc_1')
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-x')
    /**
     * The SDK DOES read ANTHROPIC_WORKSPACE_ID, which is exactly the trap:
     * it belongs to the Workload Identity Federation path, beside
     * ANTHROPIC_FEDERATION_RULE_ID, and an `x-api-key` request ignores it.
     * Setting it looks like a fix and changes nothing — measured, by running
     * the CLI both ways.
     */
    expect(Object.keys(env)).not.toContain('ANTHROPIC_WORKSPACE_ID')
  })

  /** A workspace-scoped key needs none of this, so the variable stays absent. */
  it('sends no custom header when the key is workspace-scoped already', () => {
    const env = childEnv({ kind: 'api_key', apiKey: 'sk-ant-x' })
    expect(Object.keys(env)).not.toContain('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('sets no API key at all under a local login, rather than an empty one', () => {
    // Stubbed rather than read from the runner: a container running as root
    // often has no USER at all, and the pass-through is what is under test.
    vi.stubEnv('USER', 'agency-test-user')
    const env = childEnv({ kind: 'local_login' })
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY')
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    // Still everything the CLI needs to find its own session, and no more.
    expect(env['HOME']).toBeDefined()
    // The keychain lookup is BY USERNAME, so a child without USER reports
    // itself logged out — and the turn then fails with "Anthropic rejected
    // the API key", about a key it never sent. A username is not a
    // credential; omitting it cost an afternoon.
    expect(env['USER']).toBe('agency-test-user')
    expect(Object.keys(env)).not.toContain('DATABASE_URL')
  })
})

describe('the system prompt', () => {
  const prompt = systemPrompt('Agency', 'Security-gap SaaS (US/EU)')

  /**
   * Not the claude_code preset: it describes a coding agent's tools, and
   * `tools: []` has just removed every one of them. Telling the model about
   * tools it does not have is how it spends a turn trying to read a file.
   */
  it('is a plain string, not the coding preset', () => {
    expect(typeof fixture().systemPrompt).toBe('string')
  })

  it('restates the rules the model can break in front of a customer', () => {
    expect(prompt).toMatch(/never state a security finding you have not read/i)
    expect(prompt).toMatch(/absence means UNKNOWN/i)
    expect(prompt).toMatch(/stale/i)
    expect(prompt).toMatch(/email and LinkedIn only/i)
    expect(prompt).toMatch(/never as a security test/i)
  })

  it('names the active ICP so the model uses the team’s weighting, not its own', () => {
    expect(prompt).toContain('Security-gap SaaS (US/EU)')
    expect(prompt).toContain('get_icp')
  })

  /**
   * A tool that reliably returns nothing teaches the model a false shape of
   * the business (§12). The prompt redirects the phrase instead.
   */
  it('says plainly that deal stages do not exist yet', () => {
    expect(prompt).toMatch(/deal stages.*do not exist yet/is)
    expect(prompt).toContain('search_companies')
  })

  it('says so rather than inventing a profile when none is configured', () => {
    const none = systemPrompt('Agency', null)
    expect(none).toMatch(/No ideal-customer profile is configured/i)
    expect(none).not.toContain('get_icp before judging fit')
  })
})
