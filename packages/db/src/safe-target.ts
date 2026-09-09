/**
 * Strip credentials from a connection string so a target can be shown.
 *
 * PROMPT.md §2.3: no credential is ever written to a log line. A DATABASE_URL
 * carries a password, so the CLIs print only host, port and database name.
 * Its own module so it can be tested — CLAUDE.md names this function as the
 * enforcement point, which is a claim worth backing with a test.
 */
export function safeTarget(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}
