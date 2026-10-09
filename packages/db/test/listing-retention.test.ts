/**
 * Google's coordinates are kept thirty days (2026-10-09): a pair read longer
 * ago is cleared and the rest of the listing stays; a fresh pair, and a
 * company with none, are untouched; one audit row per org that had any.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { migratedDb, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import type { AgencyDb } from '../src/repository.js'
import { COORDINATE_RETENTION_DAYS, pruneListingCoordinates } from '../src/listing-retention.js'

const NOW = new Date('2026-10-09T12:00:00.000Z')
const DAY = 86_400_000

describe('pruning listing coordinates', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    otherOrgId = (await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id }))[0]!.id
  }, 30_000)
  afterEach(async () => {
    await test.close()
  })

  const company = (org: string, domain: string, daysAgo: number | null, withCoordinates: boolean) =>
    db
      .insert(schema.companies)
      .values({
        orgId: org, domain, name: domain, phone: '+918041234567', address: '12 CMH Road', googleRating: '4.5',
        listingCheckedAt: daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY),
        ...(withCoordinates ? { latitude: 12.97, longitude: 77.59 } : {}),
      })
      .returning({ id: schema.companies.id })
      .then((r) => r[0]!.id)

  it('clears a pair older than thirty days and keeps the rest of the listing, a fresh pair and a company with none', async () => {
    const old = await company(orgId, 'old.in', COORDINATE_RETENTION_DAYS + 1, true)
    const fresh = await company(orgId, 'fresh.in', COORDINATE_RETENTION_DAYS - 1, true)
    const none = await company(orgId, 'none.in', 90, false)
    const elsewhere = await company(otherOrgId, 'elsewhere.in', 60, true)

    expect(await pruneListingCoordinates(db, { now: NOW })).toEqual({ pruned: 2, orgs: 2 })
    const row = async (id: string) => (await db.select().from(schema.companies).where(eq(schema.companies.id, id)))[0]!
    expect(await row(old)).toMatchObject({ latitude: null, longitude: null, address: '12 CMH Road', phone: '+918041234567', googleRating: '4.5' })
    expect((await row(old)).listingCheckedAt).toEqual(new Date(NOW.getTime() - (COORDINATE_RETENTION_DAYS + 1) * DAY))
    expect(await row(fresh)).toMatchObject({ latitude: 12.97, longitude: 77.59 })
    expect(await row(none)).toMatchObject({ latitude: null })
    expect(await row(elsewhere)).toMatchObject({ latitude: null })

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'listing.coordinates_pruned'))
    expect(audit).toHaveLength(2)
    expect(audit.find((a) => a.orgId === orgId)!.detail).toEqual({ companies: 1, olderThanDays: COORDINATE_RETENTION_DAYS })

    // A second run finds nothing and writes nothing.
    expect(await pruneListingCoordinates(db, { now: NOW })).toEqual({ pruned: 0, orgs: 0 })
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'listing.coordinates_pruned'))).toHaveLength(2)
  })
})
