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
 * table: 23505 unique, 23503 foreign key, 23514 check. Both node-postgres and
 * PGlite put the code on `.code` and the constraint's name on `.constraint`,
 * which is what lets a caller ask "was it THIS rule?" rather than parsing the
 * message.
 */

interface PgErrorFields {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly cause?: unknown
}

/** The first error in the chain carrying this SQLSTATE, or null. */
function findByCode(err: unknown, code: string): PgErrorFields | null {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const fields = cur as PgErrorFields
    if (fields.code === code) return fields
    cur = fields.cause
  }
  return null
}

/** 23505: a UNIQUE constraint or unique index refused the row. */
export function isUniqueViolation(err: unknown): boolean {
  return findByCode(err, '23505') !== null
}

/** 23503: a foreign key refused the row, or a RESTRICT refused the delete. */
export function isForeignKeyViolation(err: unknown): boolean {
  return findByCode(err, '23503') !== null
}

/**
 * 23514: a CHECK refused the row. With a name, only THAT check counts — a
 * caller catching `tasks_kind_known` must not also swallow
 * `tasks_title_is_not_blank` and report the wrong reason to a person.
 */
export function isCheckViolation(err: unknown, constraintName?: string): boolean {
  const found = findByCode(err, '23514')
  if (!found) return false
  return constraintName === undefined || found.constraint === constraintName
}
