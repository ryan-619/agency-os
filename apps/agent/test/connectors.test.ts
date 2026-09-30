/**
 * Building `mcpServers` from connector rows (PROMPT.md §6).
 *
 * §6 calls this "the requirement that makes the product what it was asked
 * for". The tests that matter are not "it builds a URL". They are the ones
 * about what a connector must NOT be able to reach:
 *
 *  - the worker's own environment (DATABASE_URL, SECRETS_KEY, the API key);
 *  - the network the worker runs in (the cloud metadata endpoint);
 *  - the `agency` server's name, which its own tools are addressed by;
 *  - the log, or any error message, with a credential in it.
 *
 * The database is faked here on purpose: this file is about the ASSEMBLY, and
 * `packages/db/test/connectors.test.ts` covers the rows against a real engine.
 */
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { encrypt, type ConnectorRow } from '@agency/db'
import {
  buildMcpServers, describeServers, SCRUBBED_FROM_STDIO, STDIO_LAUNCHER,
} from '../src/runtime/connectors.js'
import { childEnv } from '../src/runtime/options.js'

const KEY = randomBytes(32)
const TOKEN = 'sk-apollo-live-9f3a2b7c1d4e'
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

function row(over: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    name: 'apollo',
    kind: 'http',
    enabled: true,
    config: { url: 'https://mcp.apollo.example/v1', headers: {} },
    secretRef: null,
    createdBy: null,
    lastOkAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: null,
    ...over,
  } as ConnectorRow
}

/**
 * The smallest thing that answers the two queries this module makes:
 * `enabledConnectors` (a select) and `revealSecret` (a select with a limit).
 * The first keeps only enabled rows, as its WHERE clause does.
 */
function fakeDb(rows: ConnectorRow[], secret?: { id: string; ciphertext: string }) {
  const chain = (result: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {}
    for (const method of ['from', 'where', 'orderBy', 'limit']) {
      self[method] = () => self
    }
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return self
  }
  return {
    select: (cols?: Record<string, unknown>) =>
      // `revealSecret` selects named columns; `enabledConnectors` selects all.
      chain(cols && 'ciphertext' in cols ? (secret ? [secret] : []) : rows.filter((r) => r.enabled)),
  } as never
}

describe('an http connector', () => {
  it('becomes an mcpServers entry keyed by its name', async () => {
    const { servers } = await buildMcpServers(fakeDb([row()]), 'org-1', KEY, silent)
    expect(servers['apollo']).toEqual({
      type: 'http',
      url: 'https://mcp.apollo.example/v1',
      headers: {},
    })
  })

  it('carries its configured headers', async () => {
    const { servers } = await buildMcpServers(
      fakeDb([row({ config: { url: 'https://a.example/v1', headers: { 'x-tenant': 'acme' } } })]),
      'org-1',
      KEY,
      silent,
    )
    expect(servers['apollo']).toMatchObject({ headers: { 'x-tenant': 'acme' } })
  })

  it('becomes type "sse" when that is the transport', async () => {
    const { servers } = await buildMcpServers(fakeDb([row({ kind: 'sse' })]), 'org-1', KEY, silent)
    expect(servers['apollo']).toMatchObject({ type: 'sse' })
  })
})

describe('a credential', () => {
  const withSecret = () => ({
    rows: [row({ secretRef: '22222222-2222-4222-8222-222222222222' })],
    secret: { ciphertext: encrypt(TOKEN, KEY), keyVersion: 1 },
  })

  it('is decrypted at the moment of use and put in the Authorization header', async () => {
    const { rows, secret } = withSecret()
    const { servers } = await buildMcpServers(fakeDb(rows, secret as never), 'org-1', KEY, silent)
    expect(servers['apollo']).toMatchObject({ headers: { authorization: `Bearer ${TOKEN}` } })
  })

  /**
   * Where the credential goes is a NAME on the row (`secretHeader`,
   * `secretPrefix`), never a value. The three shapes the catalog's presets
   * use: a vendor header with no scheme, and Sentry's own scheme on the
   * standard header — which its server keeps apart from `Bearer`, reserved
   * there for OAuth tokens.
   */
  it.each([
    ['x-api-key with no prefix', { secretHeader: 'x-api-key', secretPrefix: '' }, 'x-api-key', TOKEN],
    ['a named header defaults to no prefix', { secretHeader: 'close-api-key' }, 'close-api-key', TOKEN],
    [
      'authorization with the Sentry-Bearer scheme',
      { secretHeader: 'authorization', secretPrefix: 'Sentry-Bearer ' },
      'authorization',
      `Sentry-Bearer ${TOKEN}`,
    ],
  ])('is sent as %s', async (_label, placement, header, value) => {
    const { secret } = withSecret()
    const rows = [
      row({
        secretRef: '22222222-2222-4222-8222-222222222222',
        config: { url: 'https://mcp.hunter.example/mcp', headers: {}, ...placement } as never,
      }),
    ]
    const { servers } = await buildMcpServers(fakeDb(rows, secret as never), 'org-1', KEY, silent)
    const headers = (servers['apollo'] as { headers: Record<string, string> }).headers
    expect(headers).toEqual({ [header]: value })
  })

  it('keeps a preset’s non-secret header beside the one it injects', async () => {
    const { secret } = withSecret()
    const rows = [
      row({
        secretRef: '22222222-2222-4222-8222-222222222222',
        config: {
          url: 'https://mcp.close.example/mcp',
          headers: { 'close-scope': 'mcp.read' },
          secretHeader: 'close-api-key',
          secretPrefix: '',
        } as never,
      }),
    ]
    const { servers } = await buildMcpServers(fakeDb(rows, secret as never), 'org-1', KEY, silent)
    expect((servers['apollo'] as { headers: Record<string, string> }).headers).toEqual({
      'close-scope': 'mcp.read',
      'close-api-key': TOKEN,
    })
  })

  it('sends no header at all when the row names a slot but holds no credential', async () => {
    const { servers } = await buildMcpServers(
      fakeDb([row({ config: { url: 'https://mcp.exa.example/mcp', headers: {}, secretHeader: 'x-api-key' } as never })]),
      'org-1',
      KEY,
      silent,
    )
    expect((servers['apollo'] as { headers: Record<string, string> }).headers).toEqual({})
  })

  /**
   * §2.3: no credential in a log line. A connector's name and transport are
   * safe; a URL is not (someone will paste a token into a query string despite
   * being told not to) and a command line is not.
   */
  it('never reaches the log, even when the build is reported', async () => {
    const lines: unknown[] = []
    const noisy = {
      ...silent,
      info: (m: string, f?: Record<string, unknown>) => lines.push([m, f]),
      warn: (m: string, f?: Record<string, unknown>) => lines.push([m, f]),
      error: (m: string, f?: Record<string, unknown>) => lines.push([m, f]),
    }
    const { secret } = withSecret()
    const ref = '22222222-2222-4222-8222-222222222222'
    // Every placement, plus one row that fails to build — the skip is logged
    // with its reason, and a reason is the likeliest place for a value to leak.
    const rows = [
      row({ name: 'bearer', secretRef: ref }),
      row({
        name: 'named',
        secretRef: ref,
        config: { url: 'https://mcp.hunter.example/mcp', headers: {}, secretHeader: 'x-api-key', secretPrefix: '' } as never,
      }),
      row({
        name: 'env-named',
        kind: 'stdio',
        secretRef: ref,
        config: { command: 'npx', args: ['-y', 'brave'], env: {}, secretEnv: 'BRAVE_API_KEY' } as never,
      }),
      row({ name: 'refused', secretRef: ref, config: { url: 'http://169.254.169.254/', headers: {} } as never }),
    ]
    const { servers } = await buildMcpServers(fakeDb(rows, secret as never), 'org-1', KEY, noisy)
    expect(Object.keys(servers)).toEqual(['bearer', 'named', 'env-named'])
    const dumped = JSON.stringify(lines) + JSON.stringify(describeServers(servers))
    expect(lines.length).toBeGreaterThan(0)
    expect(dumped).not.toContain(TOKEN)
    expect(dumped).not.toContain('sk-apollo')
  })

  it('describes a server by name and transport and nothing else', () => {
    expect(
      describeServers({
        apollo: { type: 'http', url: 'https://a.example?token=secret', headers: {} },
      }),
    ).toEqual(['apollo (http)'])
  })

  /**
   * Not "connect without it". An unauthenticated call to a server expecting a
   * token produces a 401 with nothing pointing at the missing key.
   */
  it('skips the connector, with a reason, when SECRETS_KEY is unset', async () => {
    const { rows, secret } = withSecret()
    const { servers, skipped } = await buildMcpServers(
      fakeDb(rows, secret as never),
      'org-1',
      null,
      silent,
    )
    expect(servers).toEqual({})
    expect(skipped[0]!.why).toMatch(/SECRETS_KEY/)
  })

  it('skips it when the credential cannot be decrypted, and names no detail', async () => {
    const { rows } = withSecret()
    const other = randomBytes(32)
    const { servers, skipped } = await buildMcpServers(
      fakeDb(rows, { ciphertext: encrypt(TOKEN, other), keyVersion: 1 } as never),
      'org-1',
      KEY,
      silent,
    )
    expect(servers).toEqual({})
    expect(skipped[0]!.why).toMatch(/could not be decrypted/)
  })

  it('skips it when the credential row has gone', async () => {
    const { rows } = withSecret()
    const { servers, skipped } = await buildMcpServers(fakeDb(rows), 'org-1', KEY, silent)
    expect(servers).toEqual({})
    expect(skipped[0]!.why).toMatch(/missing/)
  })
})

describe('a stdio connector', () => {
  const stdio = (config: unknown) => row({ kind: 'stdio', name: 'local-tools', config: config as never })

  it('becomes a command and its arguments', async () => {
    const { servers } = await buildMcpServers(
      fakeDb([stdio({ command: 'npx', args: ['-y', 'some-mcp-server'], env: {} })]),
      'org-1',
      KEY,
      silent,
    )
    // Through the launcher, which removes what the CLI adds (below) and then
    // execs exactly the command and arguments the row names, after `--`.
    expect(servers['local-tools']).toEqual({
      type: 'stdio',
      command: STDIO_LAUNCHER,
      args: [...SCRUBBED_FROM_STDIO.flatMap((n) => ['-u', n]), '--', 'npx', '-y', 'some-mcp-server'],
      env: {},
    })
  })

  /**
   * THE test for this transport. A stdio connector is a process an owner
   * chose through a web form. Inheriting the worker's environment would hand
   * it ANTHROPIC_API_KEY, DATABASE_URL and SECRETS_KEY — every credential the
   * product has — and `process.env` is one forgotten spread away.
   */
  it('inherits nothing from the worker’s own environment', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:hunter2@db/agency')
    vi.stubEnv('SECRETS_KEY', KEY.toString('base64'))
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-never-appear')
    const { servers } = await buildMcpServers(
      fakeDb([stdio({ command: 'npx', args: [], env: { LANG: 'C' } })]),
      'org-1',
      KEY,
      silent,
    )
    const env = (servers['local-tools'] as { env: Record<string, string> }).env
    expect(env).toEqual({ LANG: 'C' })
    expect(JSON.stringify(env)).not.toContain('hunter2')
    expect(JSON.stringify(env)).not.toContain('sk-ant-')
    vi.unstubAllEnvs()
  })

  it('passes its credential as MCP_SECRET rather than on a command line', async () => {
    const { servers } = await buildMcpServers(
      fakeDb(
        [
          row({
            kind: 'stdio',
            name: 'local-tools',
            secretRef: '22222222-2222-4222-8222-222222222222',
            config: { command: 'npx', args: [], env: {} } as never,
          }),
        ],
        { ciphertext: encrypt(TOKEN, KEY), keyVersion: 1 } as never,
      ),
      'org-1',
      KEY,
      silent,
    )
    const built = servers['local-tools'] as { args: string[]; env: Record<string, string> }
    expect(built.env).toEqual({ MCP_SECRET: TOKEN })
    // A command line is visible in `ps` to anyone on the host.
    expect(built.args.join(' ')).not.toContain(TOKEN)
  })

  /**
   * Most public stdio servers read a fixed variable (`BRAVE_API_KEY`,
   * `SNYK_TOKEN`), so the row names it. Still exactly `config.env` plus ONE
   * key: the name moves, nothing is added.
   */
  it('passes its credential under the variable the row names instead', async () => {
    const { servers } = await buildMcpServers(
      fakeDb(
        [
          row({
            kind: 'stdio',
            name: 'brave',
            secretRef: '22222222-2222-4222-8222-222222222222',
            config: { command: 'npx', args: ['-y', 'brave'], env: { LANG: 'C' }, secretEnv: 'BRAVE_API_KEY' } as never,
          }),
        ],
        { ciphertext: encrypt(TOKEN, KEY), keyVersion: 1 } as never,
      ),
      'org-1',
      KEY,
      silent,
    )
    const built = servers['brave'] as { args: string[]; env: Record<string, string> }
    expect(built.env).toEqual({ LANG: 'C', BRAVE_API_KEY: TOKEN })
    expect(built.args.join(' ')).not.toContain(TOKEN)
  })
})

/**
 * What the child actually RECEIVES, as opposed to what this module emits.
 *
 * The test above ("inherits nothing") checks the object this module builds,
 * and it was passing while every stdio connector was being handed the
 * worker's ANTHROPIC_API_KEY: the CLI spawns a stdio server with
 * `{ ...its own environment, ...CLAUDE_* markers, ...server.env }` — read out
 * of the installed binary — and its own environment is `childEnv()`. So this
 * spawns a real child the way the CLI does and reads its environment back.
 */
describe('a stdio child launched the way the CLI launches it', () => {
  const CANARY = 'sk-ant-api03-worker-key-canary'
  const PRINT_ENV = 'process.stdout.write(JSON.stringify(process.env))'

  /** `childEnv()` on the api_key path, with nothing undefined in it. */
  const cliEnv = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(childEnv({ kind: 'api_key', apiKey: CANARY, workspaceId: 'ws-canary' })).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    )

  const launch = (command: string, args: readonly string[], env: Record<string, string>) => {
    const out = spawnSync(command, [...args], {
      encoding: 'utf8',
      env: { ...cliEnv(), CLAUDE_PROJECT_DIR: '/tmp', CLAUDECODE: '1', ...env },
    })
    expect(out.status).toBe(0)
    return { raw: out.stdout, env: JSON.parse(out.stdout) as Record<string, string> }
  }

  it('does not receive the key that bills the agency, and does receive its own', async () => {
    const config = { command: process.execPath, args: ['-e', PRINT_ENV], env: {}, secretEnv: 'BRAVE_API_KEY' }
    const { servers } = await buildMcpServers(
      fakeDb(
        [row({ kind: 'stdio', name: 'brave', secretRef: '22222222-2222-4222-8222-222222222222', config: config as never })],
        { ciphertext: encrypt(TOKEN, KEY), keyVersion: 1 } as never,
      ),
      'org-1',
      KEY,
      silent,
    )
    const built = servers['brave'] as { command: string; args: string[]; env: Record<string, string> }

    // The control: without the launcher the same child gets the key. If this
    // ever stops being true the CLI changed, and the assertion after it would
    // be passing for a reason nobody chose.
    const bare = launch(config.command, config.args, built.env)
    expect(bare.env['ANTHROPIC_API_KEY']).toBe(CANARY)

    const scrubbed = launch(built.command, built.args, built.env)
    expect(scrubbed.raw).not.toContain(CANARY)
    expect(scrubbed.raw).not.toContain('ws-canary')
    for (const name of SCRUBBED_FROM_STDIO) expect(scrubbed.env).not.toHaveProperty(name)
    expect(scrubbed.env['BRAVE_API_KEY']).toBe(TOKEN)
    // Still a working environment: the launcher removes, it does not replace.
    expect(scrubbed.env['PATH']).toBe(process.env['PATH'])
  })

  /**
   * The list above is only as good as its coverage of `childEnv()`. Every
   * name that function can emit is either scrubbed or on this short list of
   * things a connector may see; a name added to it later fails here until
   * somebody decides which.
   */
  it('scrubs everything childEnv() can emit that a connector has no business seeing', () => {
    const MAY_SEE = [
      'PATH',
      'HOME',
      'USER',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
      'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
    ]
    const emitted = [
      ...Object.keys(childEnv({ kind: 'api_key', apiKey: CANARY, workspaceId: 'ws' })),
      ...Object.keys(childEnv({ kind: 'local_login' })),
    ]
    for (const name of emitted) {
      expect(SCRUBBED_FROM_STDIO.includes(name) || MAY_SEE.includes(name), name).toBe(true)
    }
    expect(emitted).toContain('ANTHROPIC_API_KEY')
  })

  it('refuses a command the launcher would read as an assignment', async () => {
    const { servers, skipped } = await buildMcpServers(
      fakeDb([row({ kind: 'stdio', name: 'odd', config: { command: 'A=B', args: [], env: {} } as never })]),
      'org-1',
      KEY,
      silent,
    )
    expect(servers).toEqual({})
    expect(skipped[0]!.why).toMatch(/"="/)
  })

  it('refuses an environment that sets a variable the launcher would remove', async () => {
    const { servers, skipped } = await buildMcpServers(
      fakeDb([
        row({
          kind: 'stdio',
          name: 'odd',
          config: { command: 'npx', args: [], env: { ANTHROPIC_CUSTOM_HEADERS: 'x-a: b' } } as never,
        }),
      ]),
      'org-1',
      KEY,
      silent,
    )
    expect(servers).toEqual({})
    expect(skipped[0]!.why).toMatch(/ANTHROPIC_CUSTOM_HEADERS, which belongs to the worker/)
  })
})

describe('a connector it refuses to build', () => {
  /**
   * The scanner refuses these hosts for the same reason, and this one is
   * worse: the worker would send the connector's CREDENTIAL to whatever
   * answered. Re-checked at BUILD time, not only when the row was written — a
   * row can predate the rule.
   */
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/mcp',
    'http://127.0.0.1/mcp',
    'http://10.0.0.5/mcp',
    'http://redis/mcp',
    'https://vault.internal/mcp',
    'https://db.local/mcp',
  ])('refuses %s, which points inside the worker’s own network', async (url) => {
    const { servers, skipped } = await buildMcpServers(
      fakeDb([row({ config: { url, headers: {} } as never })]),
      'org-1',
      KEY,
      silent,
    )
    expect(servers).toEqual({})
    expect(skipped[0]!.why).toMatch(/inside the network/)
  })

  it.each([
    ['no url at all', { headers: {} }],
    ['a url that is not one', { url: 'not a url' }],
    ['no command', { command: '' }],
  ])('skips one with %s rather than throwing', async (_label, config) => {
    const { servers, skipped } = await buildMcpServers(
      fakeDb([row({ config: config as never })]),
      'org-1',
      KEY,
      silent,
    )
    expect(servers).toEqual({})
    expect(skipped).toHaveLength(1)
  })

  /**
   * One broken connector must not take the whole chat down. The agent keeps
   * the tools that work, and Settings is where the broken one gets fixed.
   */
  it('keeps the good ones when one is broken', async () => {
    const { servers, skipped } = await buildMcpServers(
      fakeDb([
        row({ name: 'broken', config: {} as never }),
        row({ name: 'good', id: '33333333-3333-4333-8333-333333333333' }),
      ]),
      'org-1',
      KEY,
      silent,
    )
    expect(Object.keys(servers)).toEqual(['good'])
    expect(skipped.map((s) => s.name)).toEqual(['broken'])
  })

  it('builds nothing when nothing is enabled', async () => {
    expect(await buildMcpServers(fakeDb([]), 'org-1', KEY, silent)).toEqual({
      servers: {},
      skipped: [],
      disabledTools: new Set(),
    })
  })
})

/**
 * What the gate is handed to refuse (connector-tool-disable). Names in the
 * form the gate sees them, from the servers this turn will actually have —
 * and never an allow of any kind: nothing here reaches `allowedTools`.
 */
describe('the tools a turn refuses', () => {
  const second = '44444444-4444-4444-8444-444444444444'

  it('is exactly mcp__<name>__<tool> for each tool an owner turned off on an enabled server', async () => {
    const { disabledTools } = await buildMcpServers(
      fakeDb([
        row({ config: { url: 'https://mcp.apollo.example/v1', headers: {}, disabledTools: ['send_email', 'add_to_sequence'] } }),
        row({ id: second, name: 'crm', config: { url: 'https://crm.example/mcp', headers: {}, disabledTools: ['delete_record'] } }),
      ]),
      'org-1',
      KEY,
      silent,
    )
    expect([...disabledTools].sort()).toEqual([
      'mcp__apollo__add_to_sequence',
      'mcp__apollo__send_email',
      'mcp__crm__delete_record',
    ])
  })

  it('is empty for a server nobody turned anything off on', async () => {
    const { disabledTools } = await buildMcpServers(fakeDb([row()]), 'org-1', KEY, silent)
    expect(disabledTools.size).toBe(0)
  })

  /**
   * The catalog's default for a server nobody has reviewed: Zapier's entry is
   * `'*'`, which no tool name can store, so it crosses as the server's `*`.
   */
  it('carries a catalog server’s default until an owner saves a list, and the list after', async () => {
    const zapier = { url: 'https://mcp.zapier.com/api/v1/connect', headers: {} }
    const before = await buildMcpServers(fakeDb([row({ name: 'zaps', config: zapier })]), 'org-1', KEY, silent)
    expect([...before.disabledTools]).toEqual(['mcp__zaps__*'])
    const after = await buildMcpServers(
      fakeDb([row({ name: 'zaps', config: { ...zapier, disabledTools: ['gmail_send_email'] } })]),
      'org-1',
      KEY,
      silent,
    )
    expect([...after.disabledTools]).toEqual(['mcp__zaps__gmail_send_email'])
  })

  it('takes nothing from a disabled row — its tools are not in the turn at all', async () => {
    const { servers, disabledTools } = await buildMcpServers(
      fakeDb([row({ enabled: false, config: { url: 'https://a.example/v1', headers: {}, disabledTools: ['x'] } })]),
      'org-1',
      KEY,
      silent,
    )
    expect(servers).toEqual({})
    expect(disabledTools.size).toBe(0)
  })

  it('takes nothing from a row it could not build', async () => {
    const { skipped, disabledTools } = await buildMcpServers(
      fakeDb([row({ config: { url: 'http://169.254.169.254/', headers: {}, disabledTools: ['x'] } })]),
      'org-1',
      KEY,
      silent,
    )
    expect(skipped).toHaveLength(1)
    expect(disabledTools.size).toBe(0)
  })

  /**
   * The session spreads the in-process `agency` server last, so a connector
   * row by that name never runs. Its tool list must not switch off the
   * agency's own tools by the back door.
   */
  it('takes nothing from a row named agency, which the in-process server displaces', async () => {
    const { disabledTools } = await buildMcpServers(
      fakeDb([row({ name: 'agency', config: { url: 'https://a.example/v1', headers: {}, disabledTools: ['queue_touch'] } })]),
      'org-1',
      KEY,
      silent,
    )
    expect(disabledTools.size).toBe(0)
  })
})
