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
import { encrypt, type ConnectorRow } from '@agency/db'
import { buildMcpServers, describeServers } from '../src/runtime/connectors.js'

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
      chain(cols && 'ciphertext' in cols ? (secret ? [secret] : []) : rows),
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
    const { rows, secret } = withSecret()
    const { servers } = await buildMcpServers(fakeDb(rows, secret as never), 'org-1', KEY, noisy)
    const dumped = JSON.stringify(lines) + JSON.stringify(describeServers(servers))
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
    expect(servers['local-tools']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
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
    expect(built.env['MCP_SECRET']).toBe(TOKEN)
    // A command line is visible in `ps` to anyone on the host.
    expect(built.args.join(' ')).not.toContain(TOKEN)
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
    })
  })
})
