/**
 * Settings → Credentials (PROMPT.md §2.3): what is stored, what uses it, and
 * the two writes a person needs — re-entering a connector's credential, and
 * deleting one that nothing uses any more.
 *
 * Everything ABOUT a credential and nothing OF it. No query here selects
 * `ciphertext`, so there is no row shape that could carry it to a page by
 * accident, and the one function that is handed a plaintext passes it
 * straight to `putSecret` — the only place a plaintext is encrypted — and
 * neither keeps, returns nor logs it.
 *
 * Orphans exist on purpose. Removing a connector deliberately LEAVES its
 * credential (`DELETE /api/connectors/[id]` says why: another connector may be
 * about to reuse the key, and silently destroying it is the worse mistake), so
 * this is the page where a person sees what it was for and decides.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { updateConnector } from './connectors.js'
import { isForeignKeyViolation } from './pg-errors.js'
import { deleteSecret, putSecret } from './secrets.js'

/**
 * A uuid, checked before it reaches a `uuid` column. Postgres answers a
 * malformed one with a cast error (22P02) — a 500 for what is only an id that
 * does not exist, which is what the callers here report instead.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The one foreign key that points at `secrets` (0009). */
const HELD_BY_A_CONNECTOR = 'connectors_secret_ref_points_at_a_secret'

/**
 * `ON DELETE RESTRICT` refused a delete because a connector still points at
 * the row.
 *
 * `isForeignKeyViolation` alone does NOT see this, and the difference is the
 * server version. Measured on PGlite's Postgres 18.3: a RESTRICT refusal is
 * SQLSTATE 23001 `restrict_violation` — the SQL standard's code — while a
 * NO ACTION refusal is 23503. Postgres 16 and 17 report both as 23503.
 * Production runs 18 and CI's real server runs 16, so both codes count here;
 * and only for THIS constraint, so an unrelated failure is never reported to a
 * person as "a connector still uses it".
 */
function heldByAConnector(err: unknown): boolean {
  if (isForeignKeyViolation(err)) return true
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const fields = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (fields.code === '23001') return fields.constraint === undefined || fields.constraint === HELD_BY_A_CONNECTOR
    cur = fields.cause
  }
  return false
}

/** Long enough for any description, too short to be somewhere a PEM key fits. */
const MAX_LABEL = 120

/**
 * Below this, a label that contains the credential is a coincidence rather
 * than a paste — and no real token is this short.
 */
const PASTE_CHECK_MIN = 8

export interface CredentialsListRow {
  readonly id: string
  readonly label: string
  readonly createdAt: Date
  /** Which master key encrypted it. Not the current one → re-enter it. */
  readonly keyVersion: number
  /** Empty means orphaned: left behind by a removed connector. */
  readonly usedBy: readonly { readonly connectorId: string; readonly name: string }[]
}

/**
 * Every credential the org holds, newest first, with the connectors that
 * point at each one.
 *
 * Two plain reads joined here rather than one LEFT JOIN: a secret can be
 * shared by several connectors, and folding them in code keeps each row one
 * credential. The connector read is scoped by org as well as by pointer —
 * `connectors_secret_ref_points_at_a_secret` does not carry `org_id`, so the
 * scope is what keeps another org's connector names off this page.
 */
export async function credentialsList(db: AgencyDb, orgId: string): Promise<CredentialsListRow[]> {
  const [secrets, holders] = await Promise.all([
    db
      .select({
        id: schema.secrets.id,
        label: schema.secrets.label,
        createdAt: schema.secrets.createdAt,
        keyVersion: schema.secrets.keyVersion,
      })
      .from(schema.secrets)
      .where(eq(schema.secrets.orgId, orgId))
      .orderBy(desc(schema.secrets.createdAt), asc(schema.secrets.id)),
    db
      .select({
        connectorId: schema.connectors.id,
        name: schema.connectors.name,
        secretRef: schema.connectors.secretRef,
      })
      .from(schema.connectors)
      .where(and(eq(schema.connectors.orgId, orgId), isNotNull(schema.connectors.secretRef)))
      .orderBy(asc(schema.connectors.name)),
  ])

  const bySecret = new Map<string, { connectorId: string; name: string }[]>()
  for (const h of holders) {
    if (!h.secretRef) continue
    const list = bySecret.get(h.secretRef) ?? []
    list.push({ connectorId: h.connectorId, name: h.name })
    bySecret.set(h.secretRef, list)
  }
  return secrets.map((s) => ({
    id: s.id,
    label: s.label,
    createdAt: s.createdAt,
    keyVersion: s.keyVersion,
    usedBy: bySecret.get(s.id) ?? [],
  }))
}

export type CredentialsReplaceResult =
  | {
      readonly ok: true
      readonly secretId: string
      /** What the new row is called — the caller's, or `<connector> credential`. For the audit row. */
      readonly label: string
      readonly previousDeleted: boolean
    }
  | {
      readonly ok: false
      /** `not_found` is a 404 to a route; `invalid` is something the person can fix on the form. */
      readonly reason: 'not_found' | 'invalid'
      readonly message: string
    }

/**
 * Give a connector a new credential, and remove the one it replaced.
 *
 * One transaction, so there is no moment at which the connector points at
 * nothing or at a row that is about to disappear:
 *
 *  1. the connector is read and LOCKED, so two people re-entering at once
 *     produce one after the other rather than two new rows and a lost pointer;
 *  2. the new value goes through `putSecret`;
 *  3. `updateConnector` moves the pointer — and, because any change does,
 *     disables the connector and clears its probe. The key that was tested is
 *     not the key now configured, and an unverified connection must not stay
 *     live in the next chat message;
 *  4. the old row is deleted inside a SAVEPOINT. If another connector still
 *     points at it, `ON DELETE RESTRICT` refuses; that refusal would abort the
 *     whole transaction without the savepoint, and it is not a failure — the
 *     old key is still in use, so it is kept and `previousDeleted` says so.
 *
 * A connector with no credential yet takes this path too: adding one is
 * re-entering one that was never there.
 */
export async function credentialsReplaceForConnector(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly connectorId: string
    readonly plaintext: string
    readonly label?: string | null
    readonly createdBy?: string | null
  },
  key: Buffer,
): Promise<CredentialsReplaceResult> {
  if (!UUID.test(args.connectorId)) return { ok: false, reason: 'not_found', message: 'No such connector.' }

  const plaintext = args.plaintext
  if (typeof plaintext !== 'string' || plaintext.trim() === '') {
    return { ok: false, reason: 'invalid', message: 'Enter the new credential.' }
  }
  const label = (args.label ?? '').trim()
  if (label.length > MAX_LABEL) {
    return {
      ok: false,
      reason: 'invalid',
      message: `Keep the label under ${MAX_LABEL} characters — it describes the credential, it does not hold it.`,
    }
  }
  const core = plaintext.trim()
  if (label && core.length >= PASTE_CHECK_MIN && label.includes(core)) {
    // The label is shown on the page and written to the audit log, which is
    // exactly where §2.3 says a credential may never be.
    return {
      ok: false,
      reason: 'invalid',
      message: 'The label is shown on this page and in the audit log. Describe the credential there; do not paste it.',
    }
  }

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as AgencyDb
    const rows = await txDb
      .select({
        id: schema.connectors.id,
        name: schema.connectors.name,
        secretRef: schema.connectors.secretRef,
      })
      .from(schema.connectors)
      .where(and(eq(schema.connectors.orgId, args.orgId), eq(schema.connectors.id, args.connectorId)))
      .limit(1)
      .for('update')
    const connector = rows[0]
    if (!connector) return { ok: false as const, reason: 'not_found' as const, message: 'No such connector.' }

    const storedLabel = label || `${connector.name} credential`
    const secretId = await putSecret(
      txDb,
      {
        orgId: args.orgId,
        label: storedLabel,
        plaintext,
        createdBy: args.createdBy ?? null,
      },
      key,
    )
    await updateConnector(txDb, args.orgId, connector.id, { secretRef: secretId })

    let previousDeleted = false
    const previous = connector.secretRef
    if (previous && previous !== secretId) {
      try {
        previousDeleted = await txDb.transaction((sp) =>
          deleteSecret(sp as unknown as AgencyDb, args.orgId, previous),
        )
      } catch (err) {
        if (!heldByAConnector(err)) throw err
        previousDeleted = false
      }
    }
    return { ok: true as const, secretId, label: storedLabel, previousDeleted }
  })
}

export type CredentialsDeleteResult =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly reason: 'referenced' | 'not_found'; readonly message: string }

/**
 * Delete a credential nothing uses.
 *
 * The database decides whether "nothing uses it" is true, not a read made
 * first: `ON DELETE RESTRICT` refuses at the delete, so a connector pointed at
 * this row a moment ago cannot be left holding a dangling pointer. The refusal
 * is turned into a sentence that names what still uses it.
 *
 * Call it with the pool, not inside a caller's transaction: the refusal is a
 * statement error, and in a transaction it would abort everything around it.
 */
export async function credentialsDelete(
  db: AgencyDb,
  orgId: string,
  secretId: string,
): Promise<CredentialsDeleteResult> {
  const notFound = { ok: false as const, reason: 'not_found' as const, message: 'No such credential.' }
  if (!UUID.test(secretId)) return notFound

  try {
    const rows = await db
      .delete(schema.secrets)
      .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, secretId)))
      .returning({ label: schema.secrets.label })
    const row = rows[0]
    return row ? { ok: true, label: row.label } : notFound
  } catch (err) {
    if (!heldByAConnector(err)) throw err
    const holders = await db
      .select({ name: schema.connectors.name })
      .from(schema.connectors)
      .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.secretRef, secretId)))
      .orderBy(asc(schema.connectors.name))
    const names = holders.map((h) => h.name)
    return {
      ok: false,
      reason: 'referenced',
      message:
        names.length > 0
          ? `${names.join(', ')} still ${names.length === 1 ? 'uses' : 'use'} this credential. ` +
            'Re-enter that connector’s credential or remove the connector first.'
          : 'A connector still uses this credential. Re-enter its credential or remove it first.',
    }
  }
}
