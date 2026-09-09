/**
 * Log redaction.
 *
 * PROMPT.md §2.3: "No credential is ever written to a source file, a log line,
 * or an agent's context window."
 *
 * This is a BACKSTOP, not the primary defence. The primary defence is not
 * handing a credential to the logger at all. What this catches is the
 * realistic accident: logging a whole database row —
 * `log.error('connector test failed', { connector: row })` — where
 * `row.config.headers.authorization` holds a decrypted MCP server token.
 *
 * It lives in packages/core because it is pure, and because both the web app
 * and the agent worker need exactly the same behaviour; two copies would drift.
 *
 * Known limits, stated plainly so nobody over-trusts it:
 *   * It matches on KEY NAME. A credential stored under an innocuous key
 *     (`{ value: 'sk-live-...' }`) is not detected and never will be.
 *   * It does not inspect string contents for secret-shaped substrings.
 * Treat it as a seatbelt, not as permission to log arbitrary objects.
 */

/** Key names whose values are replaced wholesale, whatever their type. */
export const SENSITIVE_KEY =
  /pass|passwd|pwd|secret|token|key|apikey|credential|auth|bearer|cookie|session|dsn|connection|url$/i

/** Depth cap, so a cyclic or pathological object cannot hang the logger. */
const MAX_DEPTH = 6

export const REDACTED = '[redacted]'

export type LogFields = Record<string, unknown>

function redactValue(value: unknown, depth: number, path: Set<object>): unknown {
  if (depth > MAX_DEPTH) return '[truncated]'
  if (value === null || typeof value !== 'object') return value

  if (value instanceof Date) return value.toISOString()
  // Errors carry a stack that can quote a connection string; keep name+message.
  if (value instanceof Error) return { name: value.name, message: value.message }

  /**
   * `path` holds the ANCESTORS of the current node, not everything visited.
   * A set of all visited objects would flag the same sub-object referenced
   * twice in different branches — an ordinary DAG, not a cycle — and silently
   * drop its contents from the log line. Only a true self-reference matters,
   * so the node is removed again on the way back up.
   */
  if (path.has(value)) return '[circular]'
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, path))

    const out: LogFields = {}
    for (const [k, v] of Object.entries(value as LogFields)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1, path)
    }
    return out
  } finally {
    path.delete(value)
  }
}

/** Redact a set of log fields, walking nested objects and arrays. */
export function redact(fields: LogFields): LogFields {
  return redactValue(fields, 0, new Set<object>()) as LogFields
}
