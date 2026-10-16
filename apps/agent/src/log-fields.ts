/**
 * What a worker's warning may say about the fault behind it (2026-10-09).
 *
 * The error's class, and — where it carries one — its code: a Node system
 * code (`ETIMEDOUT`, `ENOTFOUND`, `EADDRNOTAVAIL`) or a Postgres SQLSTATE
 * (`57P01`, `08006`), read from the error itself or from the error it wraps
 * (a query builder's error keeps the driver's as its `cause`). Never the
 * message, which for a driver's error can quote the DSN or the values it was
 * given (§2.3).
 *
 * Before this the lines said only the class, and a network error's class is
 * plain `Error`: on 2026-10-09 the operator's Mac lost its network for five
 * minutes and the terminal filled with "sender could not read the queue",
 * "approval sweep failed" and "heartbeat not written", each `"error":
 * "Error"`, with nothing to say they were one outage the worker would ride
 * out. A code that says the network went away carries a hint that says so.
 */

/** A code is kept only in this shape: letters, digits and underscores, as system codes and SQLSTATEs are. */
const CODE = /^[A-Za-z0-9_]{1,40}$/

/** The network went away under the worker: a laptop asleep or offline, or the far end unreachable. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ETIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EADDRNOTAVAIL', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'EPIPE',
])

export const NETWORK_HINT =
  'the network or the database could not be reached — this machine may be asleep or offline; the worker keeps retrying on its own'

/** Postgres closed the connection or would not take one (class 08, and an administrator's or a restart's 57P0x). */
const DATABASE_GONE = /^(08[0-9A-Z]{3}|57P0[1-3])$/

export const DATABASE_GONE_HINT = 'the database closed the connection or is restarting; the worker retries on its own'

/** A type, not an interface, so it passes as a logger's fields (an index signature). */
export type FaultFields = {
  readonly error: string
  readonly code?: string
  readonly hint?: string
}

function codeOf(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && CODE.test(code)) return code
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

export function faultFields(err: unknown): FaultFields {
  const error = err instanceof Error ? err.name : 'UnknownError'
  const code = codeOf(err)
  if (code === undefined) return { error }
  const upper = code.toUpperCase()
  if (NETWORK_CODES.has(upper)) return { error, code, hint: NETWORK_HINT }
  if (DATABASE_GONE.test(upper)) return { error, code, hint: DATABASE_GONE_HINT }
  return { error, code }
}
