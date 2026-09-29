/**
 * The connector registry, against a real engine (PROMPT.md §6).
 *
 * `apps/agent/test/connectors.test.ts` covers the ASSEMBLY — what a row
 * becomes when the worker builds a turn from it. This covers the rows: what
 * the database accepts, what validation refuses before a row is written, and
 * the rule that a connector is never enabled by the act of creating or editing
 * it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import {
  createConnector, deleteConnector, disabledToolNames, enabledConnectors, FORBIDDEN_SECRET_ENV,
  isReachableConnectorUrl, listConnectors, parseConnectorConfig, putSecret, readConnector,
  recordConnectorProbe, schema, secretEnvName, secretPlacement, setConnectorEnabled, updateConnector,
  type AgencyDb, type HttpConfig, type StdioConfig,
} from '../src/index.js'
import { migratedDb,expectRejection, type TestDb } from './helpers.js'

describe('parseConnectorConfig', () => {
  it('accepts a well-formed http server', () => {
    const out = parseConnectorConfig('http', { url: 'https://mcp.example/v1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // 0018 added optional keys; an existing row's shape (none of them) parses
    // unchanged, and reads as a row with nothing turned off.
    expect(out.value).toEqual({ url: 'https://mcp.example/v1', headers: {} })
  })

  it('accepts a well-formed stdio server', () => {
    const out = parseConnectorConfig('stdio', { command: 'npx', args: ['-y', 'x'] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value).toEqual({ command: 'npx', args: ['-y', 'x'], env: {} })
  })

  /**
   * The message goes on a form under the field that is wrong, so it names the
   * field rather than describing a zod issue.
   */
  it.each([
    ['http', {}, /url/],
    ['http', { url: 'not a url' }, /url/],
    ['stdio', { args: ['x'] }, /command/],
    ['stdio', { command: '' }, /command/],
    ['telepathy', {}, /not a transport/],
  ])('refuses %s config %j and says which field', (kind, config, matches) => {
    const out = parseConnectorConfig(kind, config)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toMatch(matches)
  })

  it('treats a missing config as an empty one rather than throwing', () => {
    expect(parseConnectorConfig('http', undefined).ok).toBe(false)
    expect(parseConnectorConfig('http', null).ok).toBe(false)
  })

  /**
   * 0018's extension: WHERE the credential goes is a NAME in config; the
   * value never is. Every case below is a person typing something into a
   * form, and the refusal is what stops a credential landing in plain jsonb.
   */
  describe('where the credential goes (secretEnv / secretHeader / secretPrefix)', () => {
    const stdio = (over: Record<string, unknown>) =>
      parseConnectorConfig('stdio', { command: 'npx', ...over })
    const http = (over: Record<string, unknown>) =>
      parseConnectorConfig('http', { url: 'https://mcp.example/v1', ...over })

    it.each(['lower', 'ANTHROPIC_API_KEY', 'PATH', 'USER', 'CLAUDE_X', 'DATABASE_URL', 'NODE_OPTIONS', '1BAD'])(
      'refuses secretEnv %j — it belongs to the worker or is not a variable name',
      (secretEnv) => {
        const out = stdio({ secretEnv })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.message).toMatch(/secretEnv/)
      },
    )

    it('accepts a vendor variable and reports it as the injection slot', () => {
      const out = stdio({ secretEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN' })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(secretEnvName(out.value as StdioConfig)).toBe('GITHUB_PERSONAL_ACCESS_TOKEN')
      expect(FORBIDDEN_SECRET_ENV).not.toContain('GITHUB_PERSONAL_ACCESS_TOKEN')
    })

    it('defaults the slot to MCP_SECRET when nothing is named', () => {
      const out = stdio({})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(secretEnvName(out.value as StdioConfig)).toBe('MCP_SECRET')
    })

    it.each([
      ['http', { headers: { authorization: 'x' } }],
      ['http', { headers: { Authorization: 'x' } }],
      ['http', { headers: { 'x-api-key': 'x' } }],
      ['http', { headers: { 'X-Api-Token': 'x' } }],
      ['http', { headers: { 'close-api-key': 'x' }, secretHeader: 'close-api-key' }],
      ['stdio', { env: { MCP_SECRET: 'x' } }],
      ['stdio', { env: { BRAVE_API_KEY: 'x' }, secretEnv: 'BRAVE_API_KEY' }],
      ['stdio', { env: { GITHUB_TOKEN: 'x' } }],
    ])('refuses a %s config whose KEY is credential-shaped or is the secret slot: %j', (kind, over) => {
      const out = kind === 'http' ? http(over) : stdio(over)
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.message).toContain('Put the credential in the credential field')
    })

    /**
     * The key check cannot see `x-custom: sk-ant-…`, which is the same
     * credential under a name it does not recognise. The VALUE is checked
     * too — the documented prefixes, an auth scheme typed by hand, and the
     * `scheme://user:password@` shape SENSITIVE_VALUE already knows.
     */
    it.each([
      ['http', { headers: { 'x-custom': 'sk-ant-api03-abcdef' } }],
      ['http', { headers: { 'x-custom': 'Bearer abc.def' } }],
      ['http', { headers: { 'x-custom': 'Sentry-Bearer abc' } }],
      ['stdio', { env: { FOO: 'ghp_abcdefghijklmnop' } }],
      ['stdio', { env: { FOO: 'github_pat_11AAA' } }],
      ['stdio', { env: { FOO: 'postgres://user:pw@db.example/agency' } }],
      ['stdio', { env: { FOO: 'xoxb-1234-5678' } }],
    ])('refuses a %s config whose VALUE is credential-shaped: %j', (kind, over) => {
      const out = kind === 'http' ? http(over) : stdio(over)
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.message).toContain('Put the credential in the credential field')
    })

    it('accepts a non-secret header a preset needs', () => {
      const out = http({ headers: { 'close-scope': 'mcp.read' }, secretHeader: 'close-api-key', secretPrefix: '' })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect((out.value as HttpConfig).headers).toEqual({ 'close-scope': 'mcp.read' })
    })

    it('accepts an ordinary environment for a stdio server', () => {
      const out = stdio({ env: { LOG_LEVEL: 'info', SENTRY_HOST: 'sentry.example' } })
      expect(out.ok).toBe(true)
    })

    it('refuses an upper-case or malformed secretHeader', () => {
      expect(http({ secretHeader: 'X-API-Key' }).ok).toBe(false)
      expect(http({ secretHeader: '-x' }).ok).toBe(false)
      expect(http({ secretPrefix: 'a'.repeat(17) }).ok).toBe(false)
    })

    it('places the credential in authorization with a Bearer prefix by default', () => {
      const out = http({})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(secretPlacement(out.value as HttpConfig)).toEqual({ header: 'authorization', prefix: 'Bearer ' })
    })

    it('places it in a named header with NO prefix by default, and honours an explicit scheme', () => {
      const hunter = http({ secretHeader: 'x-api-key' })
      expect(hunter.ok).toBe(true)
      if (hunter.ok) expect(secretPlacement(hunter.value as HttpConfig)).toEqual({ header: 'x-api-key', prefix: '' })
      const sentry = http({ secretHeader: 'authorization', secretPrefix: 'Sentry-Bearer ' })
      expect(sentry.ok).toBe(true)
      if (sentry.ok) expect(secretPlacement(sentry.value as HttpConfig)).toEqual({ header: 'authorization', prefix: 'Sentry-Bearer ' })
    })
  })

  describe('disabledTools', () => {
    const http = (over: Record<string, unknown>) =>
      parseConnectorConfig('http', { url: 'https://mcp.example/v1', ...over })

    it('accepts bare tool names', () => {
      const out = http({ disabledTools: ['send_message', 'create-refund', 'x1'] })
      expect(out.ok).toBe(true)
    })

    /**
     * `mcp__x__y` is refused because `disabledToolNames` prefixes
     * `mcp__<name>__` itself: a stored value carrying the prefix would never
     * match the gate's name, and a person would believe a tool was off.
     */
    it.each([['a b'], ['mcp__x__y'], ['send__message'], ['-lead'], ['']])('refuses %j', (bad) => {
      expect(http({ disabledTools: [bad] }).ok).toBe(false)
    })

    it('refuses 65 entries', () => {
      expect(http({ disabledTools: Array.from({ length: 65 }, (_, i) => `t${i}`) }).ok).toBe(false)
      expect(http({ disabledTools: Array.from({ length: 64 }, (_, i) => `t${i}`) }).ok).toBe(true)
    })

    it('yields the gate’s fully-qualified names, and nothing for a config that does not parse', () => {
      expect([...disabledToolNames({ name: 'apollo', config: { url: 'https://x.example/', disabledTools: ['send_email', 'sequences_add'] } })].sort())
        .toEqual(['mcp__apollo__send_email', 'mcp__apollo__sequences_add'])
      expect(disabledToolNames({ name: 'apollo', config: { url: 'https://x.example/' } }).size).toBe(0)
      expect(disabledToolNames({ name: 'apollo', config: { disabledTools: ['mcp__x__y'] } }).size).toBe(0)
      expect(disabledToolNames({ name: 'apollo', config: null }).size).toBe(0)
    })
  })
})

describe('isReachableConnectorUrl', () => {
  /**
   * The same rule the scanner applies to a company domain, for a worse reason:
   * the worker would send the connector's CREDENTIAL to whatever answered.
   * `169.254.169.254` is the cloud metadata endpoint.
   */
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/mcp',
    'https://app.localhost/mcp',
    'http://127.0.0.1:8080/',
    'http://[::1]/mcp',
    'http://10.0.0.5/',
    'http://redis/',
    'http://metadata/',
    'https://vault.internal/',
    'https://db.local/',
    'https://x.home.arpa/',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isReachableConnectorUrl(url)).toBe(false)
  })

  it.each([
    'https://mcp.apollo.io/v1',
    'http://mcp.example.com/',
    'https://api.example.co.uk:8443/mcp',
  ])('allows %s', (url) => {
    expect(isReachableConnectorUrl(url)).toBe(true)
  })

  /**
   * Stated rather than implied: this does not resolve DNS, so a public name
   * pointing at a private address still gets through. That needs a
   * connect-time check, and this is a guard against a mistake and a casual
   * attempt, not a determined one.
   */
  it('cannot see where a public name actually resolves', () => {
    expect(isReachableConnectorUrl('https://localtest.me/mcp')).toBe(true)
  })
})

describe('connector rows', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let seq = 0

  beforeAll(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
  }, 30_000)

  afterAll(async () => {
    await test?.close()
  })

  beforeEach(() => {
    seq += 1
  })

  const http = (over: Record<string, unknown> = {}) => ({
    orgId,
    name: `server-${seq}`,
    kind: 'http' as const,
    config: { url: 'https://mcp.example/v1', headers: {} },
    ...over,
  })

  /**
   * A server is enabled by a separate, deliberate action after Test connection
   * has passed. Otherwise a typo in a URL is live in the next chat message,
   * and somebody enabled a server they never saw respond.
   */
  it('creates a connector DISABLED, whatever was asked for', async () => {
    const row = await createConnector(db, http())
    expect(row.enabled).toBe(false)
    expect(await enabledConnectors(db, orgId)).toHaveLength(0)
  })

  it('enables one on request, and the worker then sees it', async () => {
    const row = await createConnector(db, http())
    await setConnectorEnabled(db, orgId, row.id, true)
    const live = await enabledConnectors(db, orgId)
    expect(live.map((r) => r.id)).toContain(row.id)
  })

  /**
   * The connection that was tested is not the one now configured. An
   * edited-and-still-enabled server is a live connection nobody has verified,
   * and `last_ok_at` would still be showing a tick beside it.
   */
  it('re-disables and forgets the probe when the config changes', async () => {
    const row = await createConnector(db, http())
    await setConnectorEnabled(db, orgId, row.id, true)
    await recordConnectorProbe(db, orgId, row.id, { ok: true })
    expect((await readConnector(db, orgId, row.id))!.lastOkAt).not.toBeNull()

    const updated = await updateConnector(db, orgId, row.id, {
      config: { url: 'https://somewhere-else.example/v1', headers: {} },
    })
    expect(updated!.enabled).toBe(false)
    expect(updated!.lastOkAt).toBeNull()
    expect(updated!.lastError).toBeNull()
  })

  it('records what Test connection found, and caps the error text', async () => {
    const row = await createConnector(db, http())
    await recordConnectorProbe(db, orgId, row.id, { ok: false, error: 'x'.repeat(5000) })
    const after = await readConnector(db, orgId, row.id)
    expect(after!.lastError!.length).toBe(500)
    expect(after!.lastOkAt).toBeNull()

    await recordConnectorProbe(db, orgId, row.id, { ok: true })
    const ok = await readConnector(db, orgId, row.id)
    expect(ok!.lastOkAt).not.toBeNull()
    expect(ok!.lastError).toBeNull()
  })

  it('will not read, update or delete another org’s connector', async () => {
    const row = await createConnector(db, http())
    expect(await readConnector(db, otherOrgId, row.id)).toBeNull()
    expect(await updateConnector(db, otherOrgId, row.id, { config: { url: 'https://x.example/', headers: {} } })).toBeNull()
    expect(await setConnectorEnabled(db, otherOrgId, row.id, true)).toBeNull()
    expect(await deleteConnector(db, otherOrgId, row.id)).toBe(false)
    expect(await readConnector(db, orgId, row.id)).not.toBeNull()
  })

  /**
   * A tool is addressed as `mcp__<server>__<tool>`. A name containing `__`
   * makes that string ambiguous, so the risk classifier cannot tell which
   * server a call belongs to — and it is the classifier that decides whether a
   * human sees the call at all.
   */
  it.each(['Apollo', 'my_server', 'a__b', 'has space', '-leading', ''])(
    'refuses the server name %j at the database',
    async (name) => {
      const msg = await expectRejection(() =>
        test.driver.select(
          `INSERT INTO connectors (org_id, name, kind, config) VALUES ($1, $2, 'http', '{}'::jsonb)`,
          [orgId, name],
        ),
      )
      expect(msg.length).toBeGreaterThan(0)
    },
  )

  it('refuses two connectors with the same name in one org', async () => {
    const name = `dup-${seq}`
    await createConnector(db, http({ name }))
    await expect(createConnector(db, http({ name }))).rejects.toThrow()
  })

  it('lets two orgs each have a connector of the same name', async () => {
    const name = `shared-${seq}`
    await createConnector(db, http({ name }))
    const theirs = await createConnector(db, { ...http({ name }), orgId: otherOrgId })
    expect(theirs.orgId).toBe(otherOrgId)
  })

  it('lists one org’s connectors and nobody else’s', async () => {
    const mine = await listConnectors(db, orgId)
    expect(mine.every((r) => r.orgId === orgId)).toBe(true)
  })

  /**
   * §2.3, enforced by the FK rather than remembered: deleting a credential a
   * connector still needs would leave a server that cannot authenticate and
   * will not say why.
   */
  it('holds a pointer to a credential, never the credential', async () => {
    const key = randomBytes(32)
    const secretId = await putSecret(db, { orgId, label: 'Apollo key', plaintext: 'sk-live-xyz' }, key)
    const row = await createConnector(db, http({ secretRef: secretId }))
    expect(row.secretRef).toBe(secretId)
    expect(JSON.stringify(row)).not.toContain('sk-live-xyz')

    const msg = await expectRejection(() =>
      test.driver.select('DELETE FROM secrets WHERE id = $1', [secretId]),
    )
    expect(msg).toContain('connectors_secret_ref_points_at_a_secret')
  })

  it('deletes a connector, and the credential can then go too', async () => {
    const key = randomBytes(32)
    const secretId = await putSecret(db, { orgId, label: 'Temp', plaintext: 'sk-live-abc' }, key)
    const row = await createConnector(db, http({ secretRef: secretId }))
    expect(await deleteConnector(db, orgId, row.id)).toBe(true)
    await expect(test.driver.select('DELETE FROM secrets WHERE id = $1', [secretId])).resolves.toBeDefined()
  })
})
