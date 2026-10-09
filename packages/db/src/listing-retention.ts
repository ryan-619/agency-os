/**
 * Google's coordinates are kept thirty days (2026-10-09).
 *
 * The Places API's terms let a listing's latitude and longitude be cached
 * for thirty days and no longer; everything else a listing says — the name,
 * the address, the phone, the rating — may be kept. `find_businesses` and the
 * night shift date every reading with `listing_checked_at`, and a pair older
 * than `COORDINATE_RETENTION_DAYS` is cleared here, by the daily digest cron:
 * one UPDATE per run, the rest of the listing untouched, and one audit row
 * per org that had any (`listing.coordinates_pruned { companies }`). A
 * business found on the map again gets fresh coordinates with the reading;
 * until then `/visits` lists it apart and the audit page compares it by city,
 * as both already do for a company with none.
 */
import { and, isNotNull, lt, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'

export const COORDINATE_RETENTION_DAYS = 30

export async function pruneListingCoordinates(
  db: AgencyDb,
  args: { readonly now: Date },
): Promise<{ readonly pruned: number; readonly orgs: number }> {
  const cutoff = new Date(args.now.getTime() - COORDINATE_RETENTION_DAYS * 86_400_000)
  const rows = await db
    .update(schema.companies)
    .set({ latitude: null, longitude: null })
    .where(and(isNotNull(schema.companies.latitude), lt(schema.companies.listingCheckedAt, cutoff)))
    .returning({ orgId: schema.companies.orgId })
  const byOrg = new Map<string, number>()
  for (const r of rows) byOrg.set(r.orgId, (byOrg.get(r.orgId) ?? 0) + 1)
  for (const [orgId, companies] of byOrg) {
    await appendAudit(db, {
      orgId, actor: 'system', action: 'listing.coordinates_pruned', detail: { companies, olderThanDays: COORDINATE_RETENTION_DAYS },
    }).catch(() => {})
  }
  return { pruned: rows.length, orgs: byOrg.size }
}

/** For tests: the cutoff `pruneListingCoordinates` applies. */
export const coordinateCutoff = (now: Date): Date => new Date(now.getTime() - COORDINATE_RETENTION_DAYS * 86_400_000)
// `sql` is imported for callers that compose on this module's predicate; kept so the import graph matches its siblings.
void sql
