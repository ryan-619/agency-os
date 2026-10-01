import 'server-only'
import { cache } from 'react'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '@/lib/db'

/**
 * The org's own identity: the sidebar names it on every page, and the
 * settings index lists it beside the booking link.
 *
 * `orgs.name` and `booking_slug` are what the organisation IS; the ICP's
 * label is the name of a scoring profile ("Security-gap SaaS (US/EU)"). The
 * dashboard and the settings area handed the sidebar the first and most other
 * pages handed it the second, so the subtitle under "Agency OS" changed as a
 * person moved between pages. `Shell` reads it here now and no page passes a
 * name, so there is one place it can come from.
 *
 * `cache()` makes it one read per request: `Shell` and the settings index
 * both ask, and React dedupes the call for the length of one server render.
 */
export interface OrgIdentity {
  readonly name: string
  readonly bookingSlug: string | null
}

export const orgIdentity = cache(async (orgId: string): Promise<OrgIdentity> => {
  const [row] = await getDb()
    .select({ name: schema.orgs.name, bookingSlug: schema.orgs.bookingSlug })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId))
    .limit(1)
  return { name: row?.name ?? 'Agency', bookingSlug: row?.bookingSlug ?? null }
})
