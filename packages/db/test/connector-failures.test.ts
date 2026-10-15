/**
 * A connector that refused a call (0029), against a real engine.
 *
 * Test connection lists a server's tools and calls none, so a keyless
 * research server passed it and then refused every real call — and the
 * assistant kept calling it. The worker now records the moment a connector
 * refused and the KIND, in our own two words, beside Test connection's
 * `last_ok_at` and `last_error`, which it never touches; a later answer, a
 * new key or a new endpoint clears it; and the next turn asks which ENABLED
 * servers refused lately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  connectorFailuresRecent, connectorFailuresSince, connectorsClearFailure, connectorsRecordFailure, createConnector,
  credentialsReplaceForConnector, putSecret, readConnector, recordConnectorProbe, schema, setConnectorEnabled,
  updateConnector, type AgencyDb, type ConnectorRow,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const KEY = randomBytes(32)
const HOUR = 60 * 60 * 1000

describe('a connector that refused a call', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** Enabled, tested, with a key — a server the assistant is offered. */
  async function liveConnector(name: string, org = orgId): Promise<ConnectorRow> {
    const secretRef = await putSecret(db, { orgId: org, label: `${name} key`, plaintext: `sk-${name}-0000000000` }, KEY)
    const row = await createConnector(db, {
      orgId: org, name, kind: 'http', config: { url: `https://mcp.${name}.example/v1`, headers: {} }, secretRef,
    })
    await recordConnectorProbe(db, org, row.id, { ok: true })
    await setConnectorEnabled(db, org, row.id, true)
    return (await readConnector(db, org, row.id))!
  }

  it('records when and which kind — and nothing else on the row', async () => {
    const jina = await liveConnector('jina')
    await recordConnectorProbe(db, orgId, jina.id, { ok: false, error: 'Test connection: could not be reached.' })
    const before = (await readConnector(db, orgId, jina.id))!
    const at = new Date('2026-10-13T06:58:00.000Z')

    expect(await connectorsRecordFailure(db, { orgId, name: 'jina', kind: 'auth', at })).toBe(true)
    const after = (await readConnector(db, orgId, jina.id))!
    expect(after).toMatchObject({ lastFailureAt: at, lastFailureKind: 'auth' })
    // Test connection's fields, the switch and the configuration are not the worker's to change.
    expect(after.lastOkAt).toEqual(before.lastOkAt)
    expect(after.lastError).toBe(before.lastError)
    expect(after.enabled).toBe(true)
    expect(after.config).toEqual(before.config)
    expect(after.secretRef).toBe(before.secretRef)
  })

  it('takes the database’s clock when no time is given, and a later refusal replaces the earlier', async () => {
    const tavily = await liveConnector('tavily')
    await connectorsRecordFailure(db, { orgId, name: 'tavily', kind: 'auth', at: new Date('2026-10-12T06:00:00.000Z') })
    expect(await connectorsRecordFailure(db, { orgId, name: 'tavily', kind: 'quota' })).toBe(true)
    const row = (await readConnector(db, orgId, tavily.id))!
    expect(row.lastFailureKind).toBe('quota')
    expect(Date.now() - row.lastFailureAt!.getTime()).toBeLessThan(HOUR)
  })

  it('touches only its own org’s server of that name, and answers false for a name nobody has', async () => {
    const mine = await liveConnector('exa')
    const theirs = await liveConnector('exa', otherOrgId)
    expect(await connectorsRecordFailure(db, { orgId, name: 'exa', kind: 'quota' })).toBe(true)
    expect((await readConnector(db, otherOrgId, theirs.id))!.lastFailureAt).toBeNull()
    expect((await readConnector(db, orgId, mine.id))!.lastFailureKind).toBe('quota')
    expect(await connectorsRecordFailure(db, { orgId, name: 'firecrawl', kind: 'auth' })).toBe(false)
  })

  it('refuses a kind outside its two words before anything is written', async () => {
    const jina = await liveConnector('jina')
    await expect(
      connectorsRecordFailure(db, { orgId, name: 'jina', kind: 'HTTP 401: Unauthorized' as never }),
    ).rejects.toThrow(/unknown failure kind/)
    expect((await readConnector(db, orgId, jina.id))!.lastFailureAt).toBeNull()
  })

  it('clears a refusal when a later call answers, and leaves Test connection’s fields alone', async () => {
    const jina = await liveConnector('jina')
    await connectorsRecordFailure(db, { orgId, name: 'jina', kind: 'auth' })
    const before = (await readConnector(db, orgId, jina.id))!
    expect(await connectorsClearFailure(db, { orgId, name: 'jina' })).toBe(true)
    const after = (await readConnector(db, orgId, jina.id))!
    expect(after).toMatchObject({ lastFailureAt: null, lastFailureKind: null, enabled: true })
    expect(after.lastOkAt).toEqual(before.lastOkAt)
    // Nothing to clear the second time: the row is not written, so `updated_at` does not move every turn.
    expect(await connectorsClearFailure(db, { orgId, name: 'jina' })).toBe(false)
    expect((await readConnector(db, orgId, jina.id))!.updatedAt).toEqual(after.updatedAt)
  })

  it('forgets a refusal when the endpoint or the configuration is edited', async () => {
    const jina = await liveConnector('jina')
    await connectorsRecordFailure(db, { orgId, name: 'jina', kind: 'auth' })
    await updateConnector(db, orgId, jina.id, { config: { url: 'https://mcp.jina.example/v2', headers: {} } })
    expect((await readConnector(db, orgId, jina.id))!).toMatchObject({ lastFailureAt: null, lastFailureKind: null })
  })

  it('forgets a refusal when the key is re-entered — a new key is the usual fix for "unauthorized"', async () => {
    const jina = await liveConnector('jina')
    await connectorsRecordFailure(db, { orgId, name: 'jina', kind: 'auth' })
    const r = await credentialsReplaceForConnector(db, { orgId, connectorId: jina.id, plaintext: 'sk-jina-n3wn3wn3wn3w' }, KEY)
    expect(r.ok).toBe(true)
    expect((await readConnector(db, orgId, jina.id))!).toMatchObject({ lastFailureAt: null, lastFailureKind: null })
  })

  /**
   * A pre-0018 row named `agency` can be updated by nothing (0018's CHECK is
   * evaluated on every UPDATE) and is never a live server — the in-process
   * one takes its place. The worker writes these fire-and-forget; a throw
   * there would be a fault nobody can act on, so it answers false.
   */
  it('answers false, never a throw, for a pre-0018 row named agency', async () => {
    await test.pg.exec('ALTER TABLE connectors DROP CONSTRAINT connectors_name_is_not_agency')
    // With a refusal already on it, so the clear's UPDATE matches the row and
    // meets the CHECK — without one it would match nothing and prove nothing.
    await db.insert(schema.connectors).values({
      orgId, name: 'agency', kind: 'http', enabled: true, config: { url: 'https://mcp.example/v1', headers: {} },
      lastFailureAt: new Date('2026-10-13T06:00:00.000Z'), lastFailureKind: 'auth',
    })
    await test.pg.exec("ALTER TABLE connectors ADD CONSTRAINT connectors_name_is_not_agency CHECK (name <> 'agency') NOT VALID")
    expect(await connectorsRecordFailure(db, { orgId, name: 'agency', kind: 'quota' })).toBe(false)
    expect(await connectorsClearFailure(db, { orgId, name: 'agency' })).toBe(false)
    const [legacy] = await db.select().from(schema.connectors).where(eq(schema.connectors.name, 'agency'))
    expect(legacy).toMatchObject({ lastFailureKind: 'auth' })
  })

  describe('connectorFailuresSince', () => {
    it('lists the enabled servers that refused since then, newest first, in this org only', async () => {
      await liveConnector('jina')
      await liveConnector('tavily')
      await liveConnector('exa')
      const firecrawl = await liveConnector('firecrawl')
      await liveConnector('jina', otherOrgId)
      const now = Date.now()
      await connectorsRecordFailure(db, { orgId, name: 'jina', kind: 'auth', at: new Date(now - 3 * HOUR) })
      await connectorsRecordFailure(db, { orgId, name: 'tavily', kind: 'quota', at: new Date(now - HOUR) })
      // Too long ago to say anything about this turn.
      await connectorsRecordFailure(db, { orgId, name: 'exa', kind: 'auth', at: new Date(now - 48 * HOUR) })
      // Switched off: not offered to the model, so its refusal is nobody's next step.
      await connectorsRecordFailure(db, { orgId, name: 'firecrawl', kind: 'auth', at: new Date(now - HOUR) })
      await setConnectorEnabled(db, orgId, firecrawl.id, false)
      await connectorsRecordFailure(db, { orgId: otherOrgId, name: 'jina', kind: 'quota', at: new Date(now - HOUR) })

      const since = new Date(now - 24 * HOUR)
      expect(await connectorFailuresSince(db, orgId, since)).toEqual([
        { name: 'tavily', kind: 'quota', at: new Date(now - HOUR) },
        { name: 'jina', kind: 'auth', at: new Date(now - 3 * HOUR) },
      ])
      // The spec's name for the same reader.
      expect(await connectorFailuresRecent(db, orgId, since)).toEqual(await connectorFailuresSince(db, orgId, since))
    })

    it('answers nothing once a refusal is cleared', async () => {
      await liveConnector('jina')
      await connectorsRecordFailure(db, { orgId, name: 'jina', kind: 'auth' })
      await connectorsClearFailure(db, { orgId, name: 'jina' })
      expect(await connectorFailuresSince(db, orgId, new Date(Date.now() - 24 * HOUR))).toEqual([])
    })
  })
})
