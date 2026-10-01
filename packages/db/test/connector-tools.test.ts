/**
 * Turning a connector's tools off (connector-tool-disable).
 *
 * The one test that matters is the first: the writer changes the list and
 * NOTHING else. `updateConnector` re-disables a connector and forgets its
 * probe on any change, and doing that here would switch off a live, tested
 * server because somebody made it safer.
 *
 * The rest pin what the gate is handed: the catalog default for a row nobody
 * has reviewed (including the `'*'` entries a tool name cannot store), the
 * owner's list once there is one, and the predicate both rings ask.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import { CONNECTOR_CATALOG } from '@agency/core'
import {
  connectorToolsCheck, connectorToolsDenied, connectorToolsEveryTool, connectorToolsIsDisabled,
  connectorToolsPreset, connectorToolsSetDisabled, connectorToolsState, createConnector, disabledToolNames,
  parseConnectorConfig, putSecret, readConnector, recordConnectorProbe, schema, setConnectorEnabled,
  type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const ZAPIER = 'https://mcp.zapier.com/api/v1/connect'
const STRIPE = 'https://mcp.stripe.com'

describe('connectorToolsSetDisabled, against a real engine', () => {
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

  /** A tested, enabled connector with a credential and a non-secret header — everything the writer must leave alone. */
  async function liveConnector(over: { url?: string; org?: string } = {}) {
    seq += 1
    const org = over.org ?? orgId
    const secretRef = await putSecret(db, { orgId: org, label: `server-${seq} key`, plaintext: 'tok-not-a-real-one' }, randomBytes(32))
    const row = await createConnector(db, {
      orgId: org,
      name: `server-${seq}`,
      kind: 'http',
      config: { url: over.url ?? 'https://mcp.example/v1', headers: { 'close-scope': 'mcp.read' } },
      secretRef,
    })
    await recordConnectorProbe(db, org, row.id, { ok: true })
    await setConnectorEnabled(db, org, row.id, true)
    return (await readConnector(db, org, row.id))!
  }

  /**
   * THE test. Narrowing what a server may do is not a change to where it
   * points, so nothing that `updateConnector` resets may move.
   */
  it('writes the list and leaves enabled, last_ok_at and the rest of the row untouched', async () => {
    const before = await liveConnector()
    expect(before.enabled).toBe(true)
    expect(before.lastOkAt).not.toBeNull()

    const after = await connectorToolsSetDisabled(db, orgId, before.id, ['send_email', 'create_task'])
    expect(after).not.toBeNull()
    expect(after!.enabled).toBe(true)
    expect(after!.lastOkAt?.toISOString()).toBe(before.lastOkAt!.toISOString())
    expect(after!.lastError).toBeNull()
    expect(after!.secretRef).toBe(before.secretRef)
    expect(after!.name).toBe(before.name)
    expect(after!.kind).toBe(before.kind)
    // One key of config changed; every other key is byte-for-byte the same.
    expect(after!.config).toEqual({ ...(before.config as object), disabledTools: ['create_task', 'send_email'] })
  })

  it('stores a config the worker can still read, naming the tools the gate will refuse', async () => {
    const row = await liveConnector()
    const after = (await connectorToolsSetDisabled(db, orgId, row.id, ['send_email']))!
    expect(parseConnectorConfig(after.kind, after.config).ok).toBe(true)
    expect([...disabledToolNames(after)]).toEqual([`mcp__${row.name}__send_email`])
    expect([...connectorToolsDenied(after)]).toEqual([`mcp__${row.name}__send_email`])
  })

  it('drops duplicates and sorts, so the row and the audit say the same thing', async () => {
    const row = await liveConnector()
    const after = (await connectorToolsSetDisabled(db, orgId, row.id, ['b', 'a', 'b']))!
    expect((after.config as { disabledTools: string[] }).disabledTools).toEqual(['a', 'b'])
  })

  /**
   * An EMPTY saved list is an answer, not an absence: an owner looked and
   * turned nothing off. It must override the catalog default rather than be
   * read as "nobody decided".
   */
  it('stores an empty list as a decision that overrides the catalog default', async () => {
    const row = await liveConnector({ url: ZAPIER })
    expect(connectorToolsState(row)).toMatchObject({ source: 'catalog', everyTool: true })
    const after = (await connectorToolsSetDisabled(db, orgId, row.id, []))!
    expect(connectorToolsState(after)).toEqual({ source: 'owner', tools: [], everyTool: false, preset: 'Zapier MCP' })
    expect(connectorToolsDenied(after).size).toBe(0)
  })

  it.each([
    ['a space', ['a b']],
    ['a fully-qualified name, which would never match', ['mcp__x__y']],
    ['a star, which is not a tool name', ['*']],
    ['an empty name', ['']],
    ['sixty-five names', Array.from({ length: 65 }, (_, i) => `tool_${i}`)],
    ['something that is not a list', 'send_email'],
    ['a list of something else', [1, 2]],
  ])('refuses %s, and writes nothing', async (_label, tools) => {
    const row = await liveConnector()
    const checked = connectorToolsCheck(row, tools)
    expect(checked.ok).toBe(false)
    await expect(connectorToolsSetDisabled(db, orgId, row.id, tools as string[])).rejects.toThrow()
    const unchanged = (await readConnector(db, orgId, row.id))!
    expect(unchanged.config).toEqual(row.config)
    expect(unchanged.enabled).toBe(true)
  })

  it('accepts sixty-four', async () => {
    const row = await liveConnector()
    const tools = Array.from({ length: 64 }, (_, i) => `tool_${String(i).padStart(2, '0')}`)
    const after = await connectorToolsSetDisabled(db, orgId, row.id, tools)
    expect((after!.config as { disabledTools: string[] }).disabledTools).toHaveLength(64)
  })

  it('cannot reach another org’s connector, and leaves it alone', async () => {
    const theirs = await liveConnector({ org: otherOrgId })
    expect(await connectorToolsSetDisabled(db, orgId, theirs.id, ['send_email'])).toBeNull()
    const unchanged = (await readConnector(db, otherOrgId, theirs.id))!
    expect(unchanged.config).toEqual(theirs.config)
  })

  it('answers null for a connector that does not exist', async () => {
    expect(await connectorToolsSetDisabled(db, orgId, '00000000-0000-4000-8000-000000000000', [])).toBeNull()
  })
})

describe('what is off on a row nobody has reviewed', () => {
  const http = (url: string, over: Record<string, unknown> = {}) => ({
    name: 'srv',
    kind: 'http',
    config: { url, headers: {}, ...over },
  })

  /**
   * The design review's finding: `'*'` cannot be stored and cannot be
   * expanded at install, because the list comes from a probe that has not
   * run. Derived instead, from the endpoint, so it holds from the first turn.
   */
  it('refuses every tool on a catalog server whose every tool acts on another SaaS', () => {
    for (const url of [ZAPIER, 'https://mcp.apollo.io/mcp']) {
      const state = connectorToolsState(http(url))
      expect(state).toMatchObject({ source: 'catalog', everyTool: true, tools: [] })
      const denied = connectorToolsDenied(http(url))
      expect([...denied]).toEqual([connectorToolsEveryTool('srv')])
      expect(connectorToolsIsDisabled(denied, 'mcp__srv__run_any_action')).toBe(true)
    }
  })

  it('refuses exactly the named send tools on a catalog server that names them', () => {
    const state = connectorToolsState(http(STRIPE))
    expect(state).toEqual({
      source: 'catalog',
      everyTool: false,
      preset: 'Stripe',
      tools: ['create_refund', 'create_payment_link', 'create_invoice', 'finalize_invoice', 'create_payout'],
    })
    const denied = connectorToolsDenied(http(STRIPE))
    expect(connectorToolsIsDisabled(denied, 'mcp__srv__create_refund')).toBe(true)
    expect(connectorToolsIsDisabled(denied, 'mcp__srv__list_customers')).toBe(false)
  })

  it('matches the server whatever the row is called, and whatever the transport', () => {
    expect(connectorToolsPreset({ kind: 'sse', config: { url: `${ZAPIER}/` } })?.id).toBe('zapier')
    expect(connectorToolsPreset({ kind: 'http', config: { url: `${ZAPIER}?tenant=x` } })?.id).toBe('zapier')
    expect([...connectorToolsDenied({ name: 'my-zaps', kind: 'http', config: { url: ZAPIER } })]).toEqual([
      'mcp__my-zaps__*',
    ])
  })

  it('turns nothing off on a server the catalog does not name, or names without send tools', () => {
    expect(connectorToolsState(http('https://mcp.example/v1'))).toEqual({
      source: 'none', tools: [], everyTool: false, preset: null,
    })
    expect(connectorToolsState(http('https://mcp.deepwiki.com/mcp'))).toMatchObject({ source: 'none', preset: 'DeepWiki' })
    expect(connectorToolsState({ name: 'x', kind: 'stdio', config: { command: 'npx' } }).source).toBe('none')
    expect(connectorToolsState({ name: 'x', kind: 'http', config: null }).source).toBe('none')
  })

  /**
   * The catalog is data and will grow. A send tool on a preset this module
   * cannot match would be a promise on the card ("disabled until you turn
   * them on") that the gate never keeps.
   */
  it('can match every catalog entry that names a send tool, by its own config', () => {
    const withSendTools = CONNECTOR_CATALOG.filter((p) => p.sendTools.length > 0)
    expect(withSendTools.length).toBeGreaterThan(0)
    for (const preset of withSendTools) {
      expect(preset.kind, preset.id).not.toBe('stdio')
      expect(connectorToolsPreset({ kind: preset.kind, config: preset.config })?.id, preset.id).toBe(preset.id)
      // And each named tool is one the schema would store.
      for (const tool of preset.sendTools.filter((t) => t !== '*')) {
        expect(connectorToolsCheck({ kind: preset.kind, config: preset.config }, [tool]).ok, `${preset.id}:${tool}`).toBe(true)
      }
    }
  })
})

describe('connectorToolsIsDisabled', () => {
  const set = new Set(['mcp__stripe__create_refund', connectorToolsEveryTool('zapier')])

  it.each([
    ['mcp__stripe__create_refund', true],
    ['mcp__stripe__list_customers', false],
    ['mcp__zapier__gmail_send_email', true],
    ['mcp__zapier-two__gmail_send_email', false],
    ['mcp__agency__queue_touch', false],
    ['Bash', false],
    ['mcp__', false],
    ['mcp____x', false],
  ])('%s → %s', (toolName, expected) => {
    expect(connectorToolsIsDisabled(set, toolName)).toBe(expected)
  })

  it('refuses nothing when nothing is off', () => {
    expect(connectorToolsIsDisabled(new Set(), 'mcp__zapier__anything')).toBe(false)
  })
})
