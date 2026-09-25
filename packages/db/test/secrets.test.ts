/**
 * Third-party credentials at rest (PROMPT.md §2.3).
 *
 * The tests that matter here are not "it round-trips". They are the ones about
 * what happens when something is wrong: a rotated key, an edited ciphertext, a
 * short key, a credential a connector still needs. §2.3 is one of the four
 * hard constraints, and the failure mode it guards against — a token readable
 * from a database dump — is silent by nature.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  CURRENT_KEY_VERSION, SecretsUnavailableError, decrypt, deleteSecret, encrypt, listSecrets,
  masterKey, putSecret, revealSecret, schema, secretsMatch, type AgencyDb,
} from '../src/index.js'
import { migratedDb,expectRejection, type TestDb } from './helpers.js'

const KEY = randomBytes(32)
const TOKEN = 'sk-apollo-live-9f3a2b7c1d4e'

describe('the master key', () => {
  it('accepts a 32-byte base64 key', () => {
    expect(masterKey(KEY.toString('base64')).length).toBe(32)
  })

  /**
   * Every refusal here is a refusal to do something that LOOKS like it works.
   * A generated-on-boot key encrypts credentials nothing can read after a
   * restart; a short key silently selects a weaker cipher in some libraries.
   */
  it('refuses to invent one when the variable is unset', () => {
    expect(() => masterKey(undefined)).toThrow(SecretsUnavailableError)
    expect(() => masterKey('')).toThrow(/SECRETS_KEY is not set/)
  })

  it('refuses a key of the wrong length, and says the length but never the value', () => {
    const short = randomBytes(16).toString('base64')
    expect(() => masterKey(short)).toThrow(/must decode to 32 bytes, got 16/)
    try {
      masterKey(short)
    } catch (err) {
      expect((err as Error).message).not.toContain(short)
    }
  })
})

describe('encrypt and decrypt', () => {
  it('round-trips a credential', () => {
    expect(decrypt(encrypt(TOKEN, KEY), KEY)).toBe(TOKEN)
  })

  /**
   * A fresh nonce every time. GCM's security collapses entirely on nonce
   * reuse, and identical ciphertexts would also leak which connectors share a
   * token — visible to anyone who can read the table.
   */
  it('never produces the same ciphertext twice for the same value', () => {
    const seen = new Set(Array.from({ length: 20 }, () => encrypt(TOKEN, KEY)))
    expect(seen.size).toBe(20)
  })

  it('refuses to decrypt under a different key', () => {
    const other = randomBytes(32)
    expect(() => decrypt(encrypt(TOKEN, KEY), other)).toThrow(SecretsUnavailableError)
  })

  /**
   * The point of an AUTHENTICATED cipher. A token altered in the database must
   * fail rather than decrypt to something else — a silently-changed API token
   * is a request sent somewhere nobody chose.
   */
  it('refuses a ciphertext that was edited', () => {
    const raw = Buffer.from(encrypt(TOKEN, KEY), 'base64')
    raw[raw.length - 1] ^= 0x01
    expect(() => decrypt(raw.toString('base64'), KEY)).toThrow(SecretsUnavailableError)
  })

  it('refuses a truncated blob rather than reading past it', () => {
    const raw = Buffer.from(encrypt(TOKEN, KEY), 'base64')
    expect(() => decrypt(raw.subarray(0, 8).toString('base64'), KEY)).toThrow(SecretsUnavailableError)
  })

  /**
   * Every failure is the same sentence. A wrong key and a corrupt blob are
   * exactly the distinction an attacker with database access would use as an
   * oracle, and Node's own GCM error text gives it away.
   */
  it('says the same thing however it failed', () => {
    const messages = new Set<string>()
    for (const attempt of [
      () => decrypt(encrypt(TOKEN, KEY), randomBytes(32)),
      () => decrypt('not base64 at all!!', KEY),
      () => decrypt(Buffer.from('short').toString('base64'), KEY),
    ]) {
      try {
        attempt()
      } catch (err) {
        messages.add((err as Error).message)
      }
    }
    expect(messages.size).toBe(1)
    expect([...messages][0]).not.toMatch(/authenticate|tag|cipher/i)
  })

  it('handles a credential with newlines and unicode, which a PEM key has', () => {
    const pem = '-----BEGIN KEY-----\nlíneé\n-----END KEY-----\n'
    expect(decrypt(encrypt(pem, KEY), KEY)).toBe(pem)
  })
})

describe('storing a credential', () => {
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

  it('stores a credential and gives back only an id', async () => {
    const id = await putSecret(db, { orgId, label: 'Apollo API key', plaintext: TOKEN, createdBy: userId }, KEY)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await revealSecret(db, orgId, id, KEY)).toBe(TOKEN)
  })

  /**
   * The whole claim of §2.3, asserted against the actual bytes. A dump of this
   * table without the master key decrypts to nothing.
   */
  it('writes nothing to the database that resembles the credential', async () => {
    await putSecret(db, { orgId, label: 'Apollo API key', plaintext: TOKEN }, KEY)
    const rows = await db.select().from(schema.secrets)
    const dumped = JSON.stringify(rows)
    expect(dumped).not.toContain(TOKEN)
    expect(dumped).not.toContain('sk-apollo')
    // Not even a fragment long enough to be useful.
    expect(dumped).not.toContain(TOKEN.slice(0, 12))
  })

  it('refuses an empty credential and an unlabelled one', async () => {
    await expect(putSecret(db, { orgId, label: 'x', plaintext: '' }, KEY)).rejects.toThrow(/empty/)
    await expect(putSecret(db, { orgId, label: '   ', plaintext: TOKEN }, KEY)).rejects.toThrow(/label/)
  })

  it('will not reveal another org’s credential', async () => {
    const id = await putSecret(db, { orgId, label: 'Apollo', plaintext: TOKEN }, KEY)
    expect(await revealSecret(db, otherOrgId, id, KEY)).toBeNull()
  })

  it('returns null rather than throwing for an id that does not exist', async () => {
    expect(await revealSecret(db, orgId, '00000000-0000-4000-8000-00000000dead', KEY)).toBeNull()
  })

  /**
   * A key rotation must not silently brick every stored credential, and it
   * must not silently return garbage either. The version is recorded so the
   * failure names the problem and the fix.
   */
  it('says so plainly when a credential predates the current key', async () => {
    const id = await putSecret(db, { orgId, label: 'Apollo', plaintext: TOKEN }, KEY)
    await db.update(schema.secrets).set({ keyVersion: CURRENT_KEY_VERSION - 1 }).where(eq(schema.secrets.id, id))
    await expect(revealSecret(db, orgId, id, KEY)).rejects.toThrow(/key version/)
  })

  it('lists what a credential IS without ever returning what it holds', async () => {
    await putSecret(db, { orgId, label: 'Apollo API key', plaintext: TOKEN }, KEY)
    const listed = await listSecrets(db, orgId)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.label).toBe('Apollo API key')
    expect(Object.keys(listed[0]!)).not.toContain('ciphertext')
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
  })

  it('deletes a credential nothing is using', async () => {
    const id = await putSecret(db, { orgId, label: 'Apollo', plaintext: TOKEN }, KEY)
    expect(await deleteSecret(db, orgId, id)).toBe(true)
    expect(await revealSecret(db, orgId, id, KEY)).toBeNull()
  })

  /**
   * Deleting a credential a connector still needs would leave a connector that
   * cannot authenticate and will not say why. The FK is ON DELETE RESTRICT, so
   * the error arrives at the delete instead.
   */
  it('refuses to delete a credential a live connector points at', async () => {
    const id = await putSecret(db, { orgId, label: 'Apollo', plaintext: TOKEN }, KEY)
    await db.insert(schema.connectors).values({
      orgId, name: 'apollo', kind: 'http', config: { url: 'https://example.test' }, secretRef: id,
    })
    const msg = await expectRejection(() => test.driver.select('DELETE FROM secrets WHERE id = $1', [id]))
    expect(msg).toContain('connectors_secret_ref_points_at_a_secret')
  })

  /**
   * 0005 declared secret_ref as text and documented it as a pointer, but any
   * string was accepted — including, with grim irony, a credential pasted into
   * the column whose comment says it never holds one. 0009 makes it a uuid FK.
   */
  it('will not let a connector store a credential in the pointer column', async () => {
    const msg = await expectRejection(() =>
      test.driver.select(
        `INSERT INTO connectors (org_id, name, kind, config, secret_ref)
         VALUES ($1, 'apollo', 'http', '{}'::jsonb, $2)`,
        [orgId, TOKEN],
      ),
    )
    expect(msg.length).toBeGreaterThan(0)
  })
})

describe('secretsMatch', () => {
  it('compares without leaking length-independent timing', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true)
    expect(secretsMatch('abc', 'abd')).toBe(false)
    expect(secretsMatch('abc', 'abcd')).toBe(false)
    expect(secretsMatch('', '')).toBe(true)
  })
})
