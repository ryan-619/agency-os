/**
 * A connection string as pg should read it (2026-10-09). Pure, no imports.
 *
 * pg-connection-string 2.x treats `sslmode=prefer`, `require` and
 * `verify-ca` exactly as `verify-full` — the certificate and the host both
 * verified — and prints a SECURITY WARNING at every start saying pg 9 will
 * give them libpq's weaker meaning (`require` will stop verifying the
 * certificate). Neon hands out `sslmode=require`, so the worker's terminal
 * and every process's log opened with that warning. Spelling out
 * `verify-full` is today's verification exactly, kept through that change,
 * and the warning goes. A string that asks for libpq's semantics
 * (`uselibpqcompat=true`) is left as it is, and so is every other mode —
 * `disable`, `no-verify`, or none at all on a local database.
 *
 * Only the query string's `sslmode` is touched; the rest — the password
 * included — is returned byte for byte.
 */
export function pgConnectionString(url: string): string {
  if (/[?&]uselibpqcompat=true(?=&|#|$)/.test(url)) return url
  return url.replace(/([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|#|$)/g, '$1verify-full')
}
