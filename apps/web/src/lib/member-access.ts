/**
 * May this `users` row sign in, or keep using a session it already has?
 *
 * One rule, read in three places in `auth.ts` — the send leg of the magic
 * link, the callback leg, and the per-request session — and pulled out here
 * so it can be tested without Next or a database. It is deliberately tiny:
 * the point of a single function is that the three places cannot come to
 * disagree about what "revoked" means, which is how a person who was removed
 * ends up still holding a thirty-day session.
 *
 * No row and a revoked row answer the SAME `false`, and the callers must
 * keep it that way: the magic-link request returns identically for both, so
 * a stranger cannot tell "not on the team" from "was on the team" (§2.3,
 * CLAUDE.md §4 "Sign-in reveals nothing about who has access").
 *
 * Pure, with no `server-only` and no `@/` import, so `apps/web/test` can load
 * it — vitest has neither.
 */
export function memberMayAccess(row: { readonly revokedAt: Date | null } | null | undefined): boolean {
  if (!row) return false
  return row.revokedAt === null
}
