/**
 * A connector named `agency` from before 0018 (PROMPT.md §6).
 *
 * 0018 added `connectors_name_is_not_agency` NOT VALID, and its comment said
 * that meant it "never fails on an existing one". NOT VALID skips checking the
 * rows already there when the constraint is ADDED; a CHECK is still evaluated
 * on every later UPDATE of a row, whatever column the UPDATE touches. So a
 * pre-0018 `agency` row can no longer be enabled, disabled, probed,
 * re-credentialed or have its tools narrowed — each write fails on a
 * constraint about a column it never changed, and each route answered 500.
 *
 * Migration 0018 is shipped and is not edited. The row is reproduced here the
 * way production would hold it: the constraint dropped, the row written, the
 * constraint put back exactly as 0018 adds it. What changes is that the
 * refusal is RECOGNISED and answered with a sentence — and that DELETE, the
 * one way out, still works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  LEGACY_AGENCY_CONNECTOR_MESSAGE, connectorToolsSetDisabled, credentialsReplaceForConnector, deleteConnector,
  isLegacyAgencyConnectorRefusal, readConnector, recordConnectorProbe, schema, setConnectorEnabled, updateConnector,
  type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('a connector named agency that predates 0018', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let legacyId: string
  let otherId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    // As production holds it: written before the constraint existed.
    await test.pg.exec('ALTER TABLE connectors DROP CONSTRAINT connectors_name_is_not_agency')
    const [legacy] = await db
      .insert(schema.connectors)
      .values({ orgId, name: 'agency', kind: 'http', enabled: true, config: { url: 'https://mcp.example/v1', headers: {} } })
      .returning({ id: schema.connectors.id })
    legacyId = legacy!.id
    // Exactly as 0018 adds it.
    await test.pg.exec(
      "ALTER TABLE connectors ADD CONSTRAINT connectors_name_is_not_agency CHECK (name <> 'agency') NOT VALID",
    )
    const [other] = await db
      .insert(schema.connectors)
      .values({ orgId, name: 'deepwiki', kind: 'http', enabled: false, config: { url: 'https://mcp.deepwiki.com/mcp', headers: {} } })
      .returning({ id: schema.connectors.id })
    otherId = other!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** The reproduction: every update path fails on the row, on a column it never touched. */
  it.each([
    ['setConnectorEnabled (disable)', () => setConnectorEnabled(db, orgId, legacyId, false)],
    ['setConnectorEnabled (enable)', () => setConnectorEnabled(db, orgId, legacyId, true)],
    ['recordConnectorProbe', () => recordConnectorProbe(db, orgId, legacyId, { ok: false, error: 'x' })],
    ['updateConnector', () => updateConnector(db, orgId, legacyId, { secretRef: null })],
    ['connectorToolsSetDisabled', () => connectorToolsSetDisabled(db, orgId, legacyId, ['send_email'])],
    ['credentialsReplaceForConnector', () =>
      credentialsReplaceForConnector(db, { orgId, connectorId: legacyId, plaintext: 'a-new-token-value' }, randomBytes(32))],
  ])('%s is refused by the constraint, and the refusal is recognised', async (_name, write) => {
    let caught: unknown = null
    try {
      await write()
    } catch (err) {
      caught = err
    }
    expect(caught, 'the update went through').not.toBeNull()
    expect(isLegacyAgencyConnectorRefusal(caught)).toBe(true)
  })

  it('leaves the row as it was, and stores no credential for it', async () => {
    await credentialsReplaceForConnector(db, { orgId, connectorId: legacyId, plaintext: 'a-new-token-value' }, randomBytes(32))
      .catch(() => null)
    expect(await db.select().from(schema.secrets)).toEqual([])
    expect((await readConnector(db, orgId, legacyId))?.enabled).toBe(true)
  })

  it('still deletes — the one way out the sentence names', async () => {
    expect(await deleteConnector(db, orgId, legacyId)).toBe(true)
    expect(await db.select().from(schema.connectors).where(eq(schema.connectors.id, legacyId))).toEqual([])
  })

  it('recognises nothing else: another connector updates, and other failures are not this one', async () => {
    expect((await setConnectorEnabled(db, orgId, otherId, true))?.enabled).toBe(true)
    expect(isLegacyAgencyConnectorRefusal(new Error('connectors_name_is_not_agency'))).toBe(false)
    let unique: unknown = null
    await db.insert(schema.connectors).values({ orgId, name: 'deepwiki', kind: 'http', config: {} }).catch((e: unknown) => { unique = e })
    expect(unique).not.toBeNull()
    expect(isLegacyAgencyConnectorRefusal(unique)).toBe(false)
  })

  it('says what happened and what to do, in one sentence', () => {
    expect(LEGACY_AGENCY_CONNECTOR_MESSAGE).toBe(
      "A connector named 'agency' predates this release and can no longer be changed; delete it and add it again under another name.",
    )
  })
})
