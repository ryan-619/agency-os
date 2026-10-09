/**
 * The organisation's own name (Settings → Organisation).
 *
 * `orgs.name` is what the product calls the agency to everyone: the sidebar
 * on every page, "Prepared by" on a proposal and its buyer page, the booking
 * page's display name, the opener's sign-off (`draftOpener`'s `agencyName`)
 * and the assistant's own instructions, which the worker reads fresh on every
 * turn. It was written once, by the seed (`SEED_ORG_NAME`, "Agency" unless
 * set), and nothing could change it: an agency trading as "Accemy" signed its
 * mail as "Agency" (2026-10-08).
 *
 * The name is the agency's, never a person's, so the audit row carries it —
 * `org.renamed { from, to }` — in the same transaction as the change.
 * `orgs_name_key` makes a name unique across the deployment, and a clash is a
 * sentence, not a 500. The seed finds the org by name, so a renamed org needs
 * `SEED_ORG_NAME` set to its new name before `remote-setup.sh` is run again;
 * the seed refuses loudly rather than create a second org (seed.ts).
 */
import { eq } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { isUniqueViolation } from './pg-errors.js'

/** In code points, as Postgres counts. A name, not a description. */
export const ORG_NAME_MAX = 80

export type OrgRename =
  | { readonly ok: true; readonly name: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'invalid' | 'taken' | 'not_found'; readonly message: string }

/** The name as it will be stored, or why it cannot be. */
export function orgNameFrom(raw: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'Give the organisation a name.' }
  const name = raw.replace(/\s+/g, ' ').trim()
  if (name === '') return { ok: false, message: 'Give the organisation a name.' }
  // Control characters, U+0000 among them, which Postgres refuses in text.
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: 'A name cannot carry control characters.' }
  if ([...name].length > ORG_NAME_MAX) {
    return { ok: false, message: `A name is at most ${ORG_NAME_MAX} characters.` }
  }
  return { ok: true, name }
}

/**
 * Rename the organisation, and audit it, in one transaction.
 *
 * The same name again changes nothing and writes no row. A name another
 * organisation on this deployment holds is refused (`taken`).
 */
export async function renameOrg(
  db: AgencyDb,
  input: { readonly orgId: string; readonly name: unknown; readonly actor: string },
): Promise<OrgRename> {
  const read = orgNameFrom(input.name)
  if (!read.ok) return { ok: false, reason: 'invalid', message: read.message }
  const name = read.name
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ name: schema.orgs.name })
        .from(schema.orgs)
        .where(eq(schema.orgs.id, input.orgId))
        .for('update')
      if (!current) {
        return { ok: false, reason: 'not_found', message: 'This organisation no longer exists.' } as const
      }
      if (current.name === name) return { ok: true, name, changed: false } as const
      await tx.update(schema.orgs).set({ name }).where(eq(schema.orgs.id, input.orgId))
      await tx.insert(schema.auditLog).values({
        orgId: input.orgId,
        actor: input.actor,
        action: 'org.renamed',
        subjectType: 'org',
        subjectId: input.orgId,
        detail: { from: current.name, to: name },
      })
      return { ok: true, name, changed: true } as const
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: 'taken', message: 'Another organisation on this deployment already has that name.' }
    }
    throw err
  }
}

/** The organisation's name, or null when the row is gone. */
export async function orgName(db: AgencyDb, orgId: string): Promise<string | null> {
  const [row] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).limit(1)
  return row?.name ?? null
}
