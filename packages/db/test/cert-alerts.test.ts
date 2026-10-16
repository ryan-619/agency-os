/**
 * A website certificate about to expire (2026-10-08), against a real migrated
 * database: a task from a CURRENT scan's evidence only, once per company per
 * expiry date, a call where a number can be called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import seed from '../seed/icp-security-gap-saas.json' with { type: 'json' }
import { CERT_ALERT_DAYS, certificateAlerts, daysToCertExpiry, schema, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const DAY = 86_400_000

describe('certificate alerts', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const scanned = async (domain: string, expires: string, ranAt: Date, phone: string | null = '+918041234567') => {
    const [co] = await db.insert(schema.companies).values({ orgId, domain, name: domain, phone }).returning({ id: schema.companies.id })
    const [s] = await db.insert(schema.scans).values({ orgId, companyId: co!.id, ranAt, ok: true }).returning({ id: schema.scans.id })
    await db.insert(schema.findings).values({
      orgId, scanId: s!.id, companyId: co!.id, signalKey: 'tls', observed: true, gap: false, detail: 'TLSv1.3',
      evidence: { host: domain, protocol: 'TLSv1.3', issuer: "Let's Encrypt", expires, daysToExpiry: 30 },
    })
    return co!.id
  }
  const tasks = () => db.select().from(schema.tasks)

  it('counts days to the end of the expiry day', () => {
    expect(daysToCertExpiry('2026-10-20', NOW)).toBe(12)
    expect(daysToCertExpiry('2026-10-08', NOW)).toBe(0)
    expect(daysToCertExpiry('2026-10-01', NOW)).toBe(-7)
    expect(daysToCertExpiry('soon', NOW)).toBeNull()
  })

  it('raises a call once per company per expiry date, from a current scan, and says when', async () => {
    const soon = await scanned('soon.in', '2026-10-20', new Date(NOW.getTime() - 2 * DAY))
    await scanned('later.in', '2027-01-15', new Date(NOW.getTime() - 2 * DAY))
    // Seen 40 days ago: the certificate may have been renewed since, so nothing is said.
    await scanned('stale.in', '2026-10-15', new Date(NOW.getTime() - 40 * DAY))
    expect(await certificateAlerts(db, { now: NOW })).toEqual({ alerted: 1 })
    const [t] = await tasks()
    expect(t).toMatchObject({ companyId: soon, kind: 'call', title: 'Tell soon.in their website’s certificate expires in 12 days' })
    expect(t!.detail).toContain('expires on 2026-10-20, in 12 days')
    expect(await certificateAlerts(db, { now: new Date(NOW.getTime() + DAY) })).toEqual({ alerted: 0 })
    expect(await tasks()).toHaveLength(1)
    expect(CERT_ALERT_DAYS).toBe(14)
  })

  it('is a to-do when there is no number to call, and says so once it has expired', async () => {
    await scanned('gone.in', '2026-10-05', new Date(NOW.getTime() - 4 * DAY), null)
    await certificateAlerts(db, { now: NOW })
    const [t] = await tasks()
    expect(t).toMatchObject({ kind: 'todo', title: 'Tell gone.in their website’s certificate has expired' })
    const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'cert.alerted'))
    expect(row!.detail).toMatchObject({ expires: '2026-10-05', daysLeft: -3 })
  })
})
