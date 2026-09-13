/**
 * Third-party credentials, encrypted at rest (PROMPT.md §2.3).
 *
 * Three rules, and this file exists to make each of them structural rather
 * than a thing everyone has to remember:
 *
 *  1. **The database never holds anything that decrypts itself.** The master
 *     key lives only in the environment, so a dump of `secrets` is inert.
 *  2. **Decrypt at point of use only.** There is no "load all secrets" call
 *     here, and nothing caches a plaintext. The one reader returns a value to
 *     one caller for one purpose.
 *  3. **The agent is never handed a raw key.** Nothing in this module is
 *     reachable from a tool handler; the connector builder in the worker uses
 *     it to construct HTTP headers the model never sees.
 *
 * AES-256-GCM, which is authenticated: a ciphertext someone edited in the
 * database fails to decrypt rather than decrypting to something else. That
 * matters more than the confidentiality here — a silently-altered API token is
 * a request sent somewhere nobody chose.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type SecretRow = typeof schema.secrets.$inferSelect

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** The current master key version. Bump when rotating; see `keyVersion`. */
export const CURRENT_KEY_VERSION = 1

export class SecretsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretsUnavailableError'
  }
}

/**
 * Read the master key from its environment variable.
 *
 * Throws rather than defaulting. A generated-on-boot key would encrypt
 * credentials that nothing can ever read again after a restart, which looks
 * like it works right up until the moment it matters.
 */
export function masterKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new SecretsUnavailableError(
      'SECRETS_KEY is not set, so third-party credentials cannot be stored or read. ' +
        'Generate one with: openssl rand -base64 32',
    )
  }
  let key: Buffer
  try {
    key = Buffer.from(raw, 'base64')
  } catch {
    throw new SecretsUnavailableError('SECRETS_KEY is not valid base64.')
  }
  if (key.length !== KEY_BYTES) {
    // The LENGTH is safe to report; the value is not. A 16-byte key would
    // silently select AES-128 in some libraries — here it is refused.
    throw new SecretsUnavailableError(
      `SECRETS_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    )
  }
  return key
}

/**
 * Encrypt one value.
 *
 * A fresh random nonce every time, never derived from anything: GCM's security
 * collapses entirely if a nonce is reused under the same key, and "the same
 * plaintext encrypts to the same ciphertext" would also leak which connectors
 * share a token.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, body]).toString('base64')
}

/**
 * Decrypt one value, or throw.
 *
 * Every failure — a wrong key, a truncated blob, an edited byte — comes out as
 * the same error with no detail. There is nothing useful to tell a caller
 * apart, and the differences are exactly what an attacker with database access
 * would use as an oracle.
 */
export function decrypt(encoded: string, key: Buffer): string {
  let raw: Buffer
  try {
    raw = Buffer.from(encoded, 'base64')
  } catch {
    throw new SecretsUnavailableError('A stored credential could not be read.')
  }
  if (raw.length <= NONCE_BYTES + TAG_BYTES) {
    throw new SecretsUnavailableError('A stored credential could not be read.')
  }
  try {
    const nonce = raw.subarray(0, NONCE_BYTES)
    const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
    const body = raw.subarray(NONCE_BYTES + TAG_BYTES)
    const decipher = createDecipheriv(ALGORITHM, key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // Deliberately not `err.message`. Node's GCM failure text is stable and
    // says "unable to authenticate data", which distinguishes a wrong key from
    // a malformed blob — a distinction worth denying.
    throw new SecretsUnavailableError('A stored credential could not be read.')
  }
}

/**
 * Store a credential and return the id that points at it.
 *
 * The plaintext is not returned, not logged, and not kept: after this call the
 * only way back to it is `revealSecret`, which one caller uses at the moment
 * of use.
 */
export async function putSecret(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly label: string
    readonly plaintext: string
    readonly createdBy?: string | null
  },
  key: Buffer,
): Promise<string> {
  const label = args.label.trim()
  if (!label) throw new Error('A credential needs a label, so a person can tell it from the others.')
  if (!args.plaintext) throw new Error('Refusing to store an empty credential.')

  const rows = await db
    .insert(schema.secrets)
    .values({
      orgId: args.orgId,
      label,
      ciphertext: encrypt(args.plaintext, key),
      keyVersion: CURRENT_KEY_VERSION,
      createdBy: args.createdBy ?? null,
    })
    .returning({ id: schema.secrets.id })

  const id = rows[0]?.id
  if (!id) throw new Error('secret insert returned no row')
  return id
}

/**
 * The one place a credential becomes readable again.
 *
 * Named `reveal` rather than `get` on purpose: a call site that reads
 * `revealSecret(...)` is one a reviewer looks at twice, and every one of them
 * should be somewhere that immediately puts the value into a request and
 * forgets it.
 */
export async function revealSecret(
  db: AgencyDb,
  orgId: string,
  secretId: string,
  key: Buffer,
): Promise<string | null> {
  const rows = await db
    .select({ ciphertext: schema.secrets.ciphertext, keyVersion: schema.secrets.keyVersion })
    .from(schema.secrets)
    .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, secretId)))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  if (row.keyVersion !== CURRENT_KEY_VERSION) {
    throw new SecretsUnavailableError(
      `This credential was encrypted with key version ${row.keyVersion} and the current version ` +
        `is ${CURRENT_KEY_VERSION}. Re-enter it, or restore the previous key.`,
    )
  }
  return decrypt(row.ciphertext, key)
}

/**
 * What the settings screen shows: everything ABOUT a credential and nothing OF
 * it. There is no variant of this that returns ciphertext — a value that
 * cannot leave the server should not be in a response shape at all.
 */
export async function listSecrets(
  db: AgencyDb,
  orgId: string,
): Promise<Array<{ id: string; label: string; createdAt: Date; keyVersion: number }>> {
  return db
    .select({
      id: schema.secrets.id,
      label: schema.secrets.label,
      createdAt: schema.secrets.createdAt,
      keyVersion: schema.secrets.keyVersion,
    })
    .from(schema.secrets)
    .where(eq(schema.secrets.orgId, orgId))
    .orderBy(schema.secrets.createdAt)
}

/**
 * Delete a credential.
 *
 * Fails if a connector still points at it — `connectors_secret_ref_points_at_a_
 * secret` is ON DELETE RESTRICT, so the error surfaces here rather than
 * leaving a connector that cannot authenticate and will not say why.
 */
export async function deleteSecret(db: AgencyDb, orgId: string, secretId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.secrets)
    .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, secretId)))
    .returning({ id: schema.secrets.id })
  return rows.length === 1
}

/**
 * Is this the same secret? Constant-time, for the rare caller that compares.
 *
 * Exported because the obvious `a === b` on a credential is a timing oracle,
 * and someone will eventually need this.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * The master key from the environment, or null.
 *
 * The web app needs to store a credential (the Settings form) and the worker
 * needs to read one (building a connector). Both want "is there a usable key?"
 * rather than an exception, because both have something sensible to say when
 * there is not — so this returns null where `masterKey` throws.
 *
 * Deliberately NOT called at module scope anywhere: `next build` evaluates
 * route modules while collecting page data, and an image build must not need
 * runtime credentials (CLAUDE.md §4).
 */
export function secretsKeyFromEnv(raw: string | undefined = process.env['SECRETS_KEY']): Buffer | null {
  if (!raw) return null
  try {
    return masterKey(raw)
  } catch {
    return null
  }
}
