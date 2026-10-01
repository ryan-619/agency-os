/**
 * Recognising a Postgres error, wherever the driver or drizzle wrapped it.
 *
 * Drizzle wraps the driver's error in a `DrizzleQueryError` whose `cause` is
 * the real one, and a caller's own try/catch may wrap it again — so the SQLSTATE
 * is somewhere down the `cause` chain rather than on the thing that was thrown.
 * These walk the chain. Two private copies of `isUniqueViolation` already exist
 * (`contacts.ts`, `approvals.ts`) and stay where they are; this module is for
 * every module written after it, so a third and fourth copy do not appear.
 *
 * The codes are Class 23 "integrity constraint violation" from the SQLSTATE
 * table: 23505 unique, 23503 foreign key, 23514 check, 23001 restrict. Both
 * node-postgres and PGlite put the code on `.code` and the constraint's name
 * on `.constraint`, which is what lets a caller ask "was it THIS rule?" rather
 * than parsing the message.
 *
 * A refused DELETE of a row something still points at has TWO codes, and the
 * one a caller tests against decides whether a person gets a sentence or a
 * 500. Measured on PGlite's Postgres 18.3: an `ON DELETE RESTRICT` key refuses
 * with 23001 `restrict_violation`, the SQL standard's code; Postgres 16 and 17
 * raised 23503 for it. Production runs 18 (Neon 18.6) and CI's real server
 * runs 16, so a delete path that knew only 23503 passed CI and answered every
 * such refusal with a 500 in production. Every foreign key in this schema
 * names its ON DELETE, so on 18 each refused DELETE is 23001; a DELETE path
 * asks `isReferencedRowRefusal`, which knows both.
 */

interface PgErrorFields {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly cause?: unknown
}

/** The first error in the chain carrying one of these SQLSTATEs, or null. */
function findByCode(err: unknown, ...codes: readonly string[]): PgErrorFields | null {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const fields = cur as PgErrorFields
    if (typeof fields.code === 'string' && codes.includes(fields.code)) return fields
    cur = fields.cause
  }
  return null
}

/** Found, and — when a name is given — refused by THAT constraint. */
function byName(found: PgErrorFields | null, constraintName: string | undefined): boolean {
  if (!found) return false
  return constraintName === undefined || found.constraint === constraintName
}

/** 23505: a UNIQUE constraint or unique index refused the row. */
export function isUniqueViolation(err: unknown): boolean {
  return findByCode(err, '23505') !== null
}

/**
 * 23503: a foreign key refused the row — an INSERT or UPDATE naming a row that
 * does not exist, which is 23503 on every server.
 *
 * NOT, on Postgres 18, a DELETE refused because another row still references
 * this one: that is 23001 there (see the module comment). Ask
 * `isReferencedRowRefusal` about a DELETE.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return findByCode(err, '23503') !== null
}

/**
 * 23001: an `ON DELETE RESTRICT` key refused to let a referenced row go, as
 * Postgres 18 reports it. With a name, only THAT key counts.
 */
export function isRestrictViolation(err: unknown, constraintName?: string): boolean {
  return byName(findByCode(err, '23001'), constraintName)
}

/**
 * A DELETE refused because another row still points at this one, on any
 * server this code runs against: 23001 on Postgres 18, 23503 on 16 and 17.
 * With a name, only THAT key counts — a caller turning the refusal into
 * "a connector still uses this credential" must not say so about another one.
 */
export function isReferencedRowRefusal(err: unknown, constraintName?: string): boolean {
  return byName(findByCode(err, '23001', '23503'), constraintName)
}

/**
 * 23514: a CHECK refused the row. With a name, only THAT check counts — a
 * caller catching `tasks_kind_known` must not also swallow
 * `tasks_title_is_not_blank` and report the wrong reason to a person.
 */
export function isCheckViolation(err: unknown, constraintName?: string): boolean {
  return byName(findByCode(err, '23514'), constraintName)
}
