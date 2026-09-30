/**
 * Settings → Credentials, against a real engine (PROMPT.md §2.3).
 *
 * `secrets.test.ts` covers the cipher and the table. This covers the three
 * things a person does on the page: see what is stored and what uses it,
 * re-enter a connector's credential, and delete one nothing uses. The tests
 * that matter are the ones about what must NOT happen — a listing that
 * carries ciphertext, a re-entered key left live on an untested connection,
 * a delete that strands a connector, an old key that outlives its rotation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  createConnector, credentialsDelete, credentialsList, credentialsReplaceForConnector, deleteConnector,
  isForeignKeyViolation, putSecret, readConnector, recordConnectorProbe, revealSecret, schema, setConnectorEnabled,
  type AgencyDb, type ConnectorRow,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const KEY = randomBytes(32)
const OLD_TOKEN = 'sk-apollo-live-0ld0ld0ld0ld'
const NEW_TOKEN = 'sk-apollo-live-n3wn3wn3wn3w'

describe('Settings → Credentials', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A connector that has a credential, was tested, and is live. */
  async function liveConnector(name = 'apollo', token = OLD_TOKEN, org = orgId): Promise<ConnectorRow> {
    const secretRef = await putSecret(db, { orgId: org, label: `${name} key`, plaintext: token }, KEY)
    const row = await createConnector(db, {
      orgId: org, name, kind: 'http', config: { url: 'https://mcp.example.test/v1', headers: {} }, secretRef,
    })
    await recordConnectorProbe(db, org, row.id, { ok: true })
    await setConnectorEnabled(db, org, row.id, true)
    return (await readConnector(db, org, row.id))!
  }

  async function secretCount(org = orgId): Promise<number> {
    const rows = await db.select({ id: schema.secrets.id }).from(schema.secrets).where(eq(schema.secrets.orgId, org))
    return rows.length
  }

  describe('credentialsList', () => {
    it('never carries ciphertext — the key is absent from every row, not just empty', async () => {
      await liveConnector('apollo')
      await putSecret(db, { orgId, label: 'Spare', plaintext: NEW_TOKEN }, KEY)
      const listed = await credentialsList(db, orgId)
      expect(listed).toHaveLength(2)
      for (const row of listed) {
        expect(Object.keys(row)).not.toContain('ciphertext')
        expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'keyVersion', 'label', 'usedBy'])
      }
      const dumped = JSON.stringify(listed)
      expect(dumped).not.toContain(OLD_TOKEN)
      expect(dumped).not.toContain(NEW_TOKEN)
    })

    it('says which connector uses each credential, and marks a removed connector’s key as an orphan', async () => {
      const apollo = await liveConnector('apollo')
      const orphanSource = await liveConnector('clay', NEW_TOKEN)
      await deleteConnector(db, orgId, orphanSource.id)

      const listed = await credentialsList(db, orgId)
      const used = listed.find((r) => r.id === apollo.secretRef)
      const orphan = listed.find((r) => r.id === orphanSource.secretRef)
      expect(used?.usedBy).toEqual([{ connectorId: apollo.id, name: 'apollo' }])
      // Removing a connector LEAVES its credential. Here is where it shows up.
      expect(orphan?.label).toBe('clay key')
      expect(orphan?.usedBy).toEqual([])
    })

    it('lists every connector sharing one credential on that one row', async () => {
      const apollo = await liveConnector('apollo')
      const twin = await createConnector(db, {
        orgId, name: 'apollo-eu', kind: 'http', config: { url: 'https://eu.mcp.example.test/v1', headers: {} },
        secretRef: apollo.secretRef,
      })
      const listed = await credentialsList(db, orgId)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.usedBy.map((u) => u.connectorId)).toEqual([apollo.id, twin.id])
    })

    it('shows nothing of another org — not its credentials, not its connectors’ names', async () => {
      await liveConnector('rival-crm', OLD_TOKEN, otherOrgId)
      expect(await credentialsList(db, orgId)).toEqual([])
      expect(await credentialsList(db, otherOrgId)).toHaveLength(1)
    })
  })

  describe('credentialsReplaceForConnector', () => {
    it('stores the new value, readable only through revealSecret, and points the connector at it', async () => {
      const apollo = await liveConnector()
      const r = await credentialsReplaceForConnector(
        db, { orgId, connectorId: apollo.id, plaintext: NEW_TOKEN, label: 'Apollo key (rotated)', createdBy: userId }, KEY,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.secretId).not.toBe(apollo.secretRef)
      expect(await revealSecret(db, orgId, r.secretId, KEY)).toBe(NEW_TOKEN)

      const after = await readConnector(db, orgId, apollo.id)
      expect(after?.secretRef).toBe(r.secretId)
      const [stored] = await db.select().from(schema.secrets).where(eq(schema.secrets.id, r.secretId))
      expect(stored?.label).toBe('Apollo key (rotated)')
      expect(stored?.createdBy).toBe(userId)
      expect(JSON.stringify(stored)).not.toContain(NEW_TOKEN)
    })

    /**
     * The key that was tested is not the key now configured. A connector left
     * enabled across a rotation is a live connection nobody has verified, in
     * the very next chat message.
     */
    it('disables the connector and clears its probe, so it must be tested again', async () => {
      const apollo = await liveConnector()
      expect(apollo.enabled).toBe(true)
      expect(apollo.lastOkAt).not.toBeNull()

      await credentialsReplaceForConnector(db, { orgId, connectorId: apollo.id, plaintext: NEW_TOKEN }, KEY)
      const after = await readConnector(db, orgId, apollo.id)
      expect(after?.enabled).toBe(false)
      expect(after?.lastOkAt).toBeNull()
      expect(after?.lastError).toBeNull()
    })

    it('removes the credential it replaced, so a rotated key does not linger as an orphan', async () => {
      const apollo = await liveConnector()
      const r = await credentialsReplaceForConnector(db, { orgId, connectorId: apollo.id, plaintext: NEW_TOKEN }, KEY)
      expect(r.ok && r.previousDeleted).toBe(true)
      expect(await revealSecret(db, orgId, apollo.secretRef!, KEY)).toBeNull()
      expect(await secretCount()).toBe(1)
    })

    /**
     * RESTRICT refuses the old row's delete when another connector still
     * points at it. That is not a failure of the rotation — the old key is
     * still in use — and without the savepoint it would abort the whole
     * transaction and lose the new key too.
     */
    it('keeps the old credential when another connector still uses it, and still rotates', async () => {
      const apollo = await liveConnector()
      const twin = await createConnector(db, {
        orgId, name: 'apollo-eu', kind: 'http', config: { url: 'https://eu.mcp.example.test/v1', headers: {} },
        secretRef: apollo.secretRef,
      })

      const r = await credentialsReplaceForConnector(db, { orgId, connectorId: apollo.id, plaintext: NEW_TOKEN }, KEY)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.previousDeleted).toBe(false)
      expect((await readConnector(db, orgId, apollo.id))?.secretRef).toBe(r.secretId)
      expect((await readConnector(db, orgId, twin.id))?.secretRef).toBe(apollo.secretRef)
      expect(await revealSecret(db, orgId, apollo.secretRef!, KEY)).toBe(OLD_TOKEN)
    })

    it('gives a connector that never had a credential its first one, with a label naming it', async () => {
      const bare = await createConnector(db, {
        orgId, name: 'deepwiki', kind: 'http', config: { url: 'https://mcp.deepwiki.test/mcp', headers: {} },
      })
      const r = await credentialsReplaceForConnector(db, { orgId, connectorId: bare.id, plaintext: NEW_TOKEN, label: '  ' }, KEY)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.previousDeleted).toBe(false)
      const listed = await credentialsList(db, orgId)
      expect(listed.map((l) => l.label)).toEqual(['deepwiki credential'])
    })

    it('treats another org’s connector as one that does not exist, and stores nothing', async () => {
      const theirs = await liveConnector('rival-crm', OLD_TOKEN, otherOrgId)
      const r = await credentialsReplaceForConnector(db, { orgId, connectorId: theirs.id, plaintext: NEW_TOKEN }, KEY)
      expect(r).toEqual({ ok: false, message: 'No such connector.' })
      expect(await secretCount()).toBe(0)
      const untouched = await readConnector(db, otherOrgId, theirs.id)
      expect(untouched?.secretRef).toBe(theirs.secretRef)
      expect(untouched?.enabled).toBe(true)
    })

    it('answers a malformed id as not found rather than a cast error', async () => {
      const r = await credentialsReplaceForConnector(db, { orgId, connectorId: 'not-a-uuid', plaintext: NEW_TOKEN }, KEY)
      expect(r).toEqual({ ok: false, message: 'No such connector.' })
    })

    it('refuses an empty or blank credential and leaves the connector as it was', async () => {
      const apollo = await liveConnector()
      for (const plaintext of ['', '   \n']) {
        const r = await credentialsReplaceForConnector(db, { orgId, connectorId: apollo.id, plaintext }, KEY)
        expect(r.ok).toBe(false)
      }
      const after = await readConnector(db, orgId, apollo.id)
      expect(after?.secretRef).toBe(apollo.secretRef)
      expect(after?.enabled).toBe(true)
      expect(await secretCount()).toBe(1)
    })

    /**
     * The label is shown on the page and written to the audit log. A person
     * who pastes the key into it has put a credential exactly where §2.3 says
     * one may never be.
     */
    it('refuses a label that contains the credential', async () => {
      const apollo = await liveConnector()
      const r = await credentialsReplaceForConnector(
        db, { orgId, connectorId: apollo.id, plaintext: NEW_TOKEN, label: `apollo ${NEW_TOKEN}` }, KEY,
      )
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.message).toMatch(/do not paste it/)
      expect(r.message).not.toContain(NEW_TOKEN)
      expect(await secretCount()).toBe(1)
    })
  })

  describe('credentialsDelete', () => {
    it('deletes an orphan and hands back its label for the audit row', async () => {
      const clay = await liveConnector('clay')
      await deleteConnector(db, orgId, clay.id)
      const r = await credentialsDelete(db, orgId, clay.secretRef!)
      expect(r).toEqual({ ok: true, label: 'clay key' })
      expect(await secretCount()).toBe(0)
    })

    it('refuses a credential a connector still uses, names that connector, and deletes nothing', async () => {
      const apollo = await liveConnector()
      const r = await credentialsDelete(db, orgId, apollo.secretRef!)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toBe('referenced')
      expect(r.message).toMatch(/^apollo still uses this credential/)
      expect(await revealSecret(db, orgId, apollo.secretRef!, KEY)).toBe(OLD_TOKEN)
      expect((await readConnector(db, orgId, apollo.id))?.enabled).toBe(true)
    })

    /**
     * Why credentials.ts does not rely on `isForeignKeyViolation` alone. On
     * Postgres 18 — PGlite here, and the production server — a RESTRICT
     * refusal is 23001, not 23503. Postgres 16 says 23503. A delete path that
     * only knew 23503 answered every referenced credential with a 500 on the
     * very server it was deployed to.
     */
    it('recognises RESTRICT by the code this engine actually raises', async () => {
      const apollo = await liveConnector()
      let caught: unknown
      try {
        await db.delete(schema.secrets).where(eq(schema.secrets.id, apollo.secretRef!))
      } catch (err) {
        caught = err
      }
      const cause = (caught as { cause?: { code?: string; constraint?: string } }).cause
      expect(cause?.constraint).toBe('connectors_secret_ref_points_at_a_secret')
      expect(['23001', '23503']).toContain(cause?.code)
      if (cause?.code === '23001') expect(isForeignKeyViolation(caught)).toBe(false)
      expect((await credentialsDelete(db, orgId, apollo.secretRef!)).ok).toBe(false)
    })

    it('treats another org’s credential as not found, and leaves it alone', async () => {
      const secretId = await putSecret(db, { orgId: otherOrgId, label: 'Theirs', plaintext: OLD_TOKEN }, KEY)
      const r = await credentialsDelete(db, orgId, secretId)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toBe('not_found')
      expect(await secretCount(otherOrgId)).toBe(1)
    })

    it('answers a malformed or unknown id as not found', async () => {
      for (const id of ['nope', '00000000-0000-4000-8000-00000000dead']) {
        const r = await credentialsDelete(db, orgId, id)
        expect(r.ok === false && r.reason).toBe('not_found')
      }
    })
  })
})
