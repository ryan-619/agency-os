import 'server-only'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '@/lib/db'

/**
 * The org's own identity, for the settings pages' sidebar and the index.
 *
 * `orgs.name` and `booking_slug` are what the organisation IS; the ICP's
 * label is the name of a scoring profile. The dashboard already shows the
 * former in the sidebar and the settings area does the same, so the one
 * place that lists both does not show one of them twice.
 */
export interface OrgIdentity {
  readonly name: string
  readonly bookingSlug: string | null
}

export async function orgIdentity(orgId: string): Promise<OrgIdentity> {
  const [row] = await getDb()
    .select({ name: schema.orgs.name, bookingSlug: schema.orgs.bookingSlug })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId))
    .limit(1)
  return { name: row?.name ?? 'Agency', bookingSlug: row?.bookingSlug ?? null }
}
