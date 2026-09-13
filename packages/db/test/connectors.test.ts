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
  createConnector, deleteConnector, enabledConnectors, isReachableConnectorUrl, listConnectors,
  parseConnectorConfig, putSecret, readConnector, recordConnectorProbe, schema,
  setConnectorEnabled, updateConnector, type AgencyDb,
} from '../src/index.js'
import { expectRejection, freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'

describe('parseConnectorConfig', () => {
  it('accepts a well-formed http server', () => {
    const out = parseConnectorConfig('http', { url: 'https://mcp.example/v1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
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
    test = await freshDb()
    await migrateUp(test.driver, migrations())
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
