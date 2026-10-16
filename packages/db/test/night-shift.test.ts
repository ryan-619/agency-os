/**
 * The night shift's store (0025), against a real migrated database: the
 * settings and their audit, the saved searches, which orgs are due by their
 * own clock, the one-claim-a-night rule, and the morning report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  NIGHT_DEFAULTS, NIGHT_SEARCHES_MAX, appendAudit, claimNightShift, nightReportLatest, nightSearchAdd, nightSearchRemove,
  nightSearchSetActive, nightSearchesList, nightSearchesToRun, nightShiftRead, nightShiftRequest, nightShiftSave, nightShiftsDue,
  schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

// 01:00 IST on 9 October, then 02:30 IST.
const BEFORE = new Date('2026-10-08T19:30:00.000Z')
const AFTER = new Date('2026-10-08T21:00:00.000Z')

describe('the night shift’s store', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const on = () => nightShiftSave(db, { orgId, enabled: true, runAt: '02:00', timeZone: 'Asia/Kolkata', actor: ownerId, updatedBy: ownerId })

  it('reads as off until it is saved, refuses a bad time or zone, and audits what changed', async () => {
    expect(await nightShiftRead(db, orgId)).toEqual(NIGHT_DEFAULTS)
    expect(await nightShiftSave(db, { orgId, enabled: true, runAt: '25:00', timeZone: 'Asia/Kolkata', actor: ownerId, updatedBy: ownerId })).toMatchObject({ ok: false })
    expect(await nightShiftSave(db, { orgId, enabled: true, runAt: '02:00', timeZone: 'Mars/Olympus', actor: ownerId, updatedBy: ownerId })).toMatchObject({ ok: false })
    expect(await on()).toEqual({ ok: true })
    expect(await nightShiftRead(db, orgId)).toMatchObject({ enabled: true, runAt: '02:00', timeZone: 'Asia/Kolkata', updatedBy: ownerId })
    const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'night.updated'))
    expect(row!.detail).toEqual({ enabled: true, at: '02:00', timeZone: 'Asia/Kolkata' })
  })

  it('is due once its zone’s clock passes its time, claimed once a night, and run at once when asked', async () => {
    expect(await nightShiftsDue(db, AFTER)).toEqual([])
    await on()
    expect(await nightShiftsDue(db, BEFORE)).toEqual([])
    expect(await nightShiftsDue(db, AFTER)).toEqual([{ orgId, localDate: '2026-10-09', requested: false }])
    expect(await claimNightShift(db, { orgId, localDate: '2026-10-09' })).toBe(true)
    expect(await claimNightShift(db, { orgId, localDate: '2026-10-09' })).toBe(false)
    expect(await nightShiftsDue(db, AFTER)).toEqual([])
    // "Run it now": due whatever the clock says, and the claim spends it.
    expect(await nightShiftRequest(db, { orgId, actor: ownerId })).toEqual({ ok: true })
    expect(await nightShiftsDue(db, AFTER)).toEqual([{ orgId, localDate: '2026-10-09', requested: true }])
    expect(await claimNightShift(db, { orgId, localDate: '2026-10-09' })).toBe(true)
    expect(await nightShiftsDue(db, AFTER)).toEqual([])
    // Switching it off drops a waiting request and runs nothing.
    await nightShiftRequest(db, { orgId, actor: ownerId })
    await nightShiftSave(db, { orgId, enabled: false, runAt: '02:00', timeZone: 'Asia/Kolkata', actor: ownerId, updatedBy: ownerId })
    expect(await nightShiftsDue(db, AFTER)).toEqual([])
    expect(await nightShiftRequest(db, { orgId, actor: ownerId })).toMatchObject({ ok: false })
  })

  it('keeps saved searches — one per wording, at most ten — and runs the one that ran longest ago first', async () => {
    const a = await nightSearchAdd(db, { orgId, query: '  dentists in   Indiranagar, Bengaluru ', region: 'in', city: 'Bengaluru', createdBy: ownerId, actor: ownerId })
    expect(a).toMatchObject({ ok: true, search: { query: 'dentists in Indiranagar, Bengaluru', region: 'IN', city: 'Bengaluru', active: true } })
    expect(await nightSearchAdd(db, { orgId, query: 'DENTISTS IN INDIRANAGAR, BENGALURU', region: null, city: null, createdBy: ownerId, actor: ownerId }))
      .toMatchObject({ ok: false, message: 'That search is already saved.' })
    expect(await nightSearchAdd(db, { orgId, query: 'ab', region: null, city: null, createdBy: ownerId, actor: ownerId })).toMatchObject({ ok: false })
    expect(await nightSearchAdd(db, { orgId, query: 'bakeries in Pune', region: 'IND', city: null, createdBy: ownerId, actor: ownerId })).toMatchObject({ ok: false })
    const b = await nightSearchAdd(db, { orgId, query: 'bakeries in Pune', region: null, city: 'Pune', createdBy: ownerId, actor: ownerId })
    if (!a.ok || !b.ok) throw new Error('not added')
    await db.update(schema.nightSearches).set({ lastRunAt: BEFORE }).where(eq(schema.nightSearches.id, a.search.id))
    expect((await nightSearchesToRun(db, orgId)).map((s) => s.query)).toEqual(['bakeries in Pune', 'dentists in Indiranagar, Bengaluru'])
    expect(await nightSearchSetActive(db, { orgId, searchId: b.search.id, active: false, actor: ownerId })).toBe(true)
    expect((await nightSearchesToRun(db, orgId)).map((s) => s.query)).toEqual(['dentists in Indiranagar, Bengaluru'])
    expect(await nightSearchRemove(db, { orgId, searchId: b.search.id, actor: ownerId })).toBe(true)
    expect(await nightSearchRemove(db, { orgId, searchId: b.search.id, actor: ownerId })).toBe(false)
    for (let i = 0; i < NIGHT_SEARCHES_MAX - 1; i++) {
      await nightSearchAdd(db, { orgId, query: `plumbers in area ${i}`, region: null, city: null, createdBy: ownerId, actor: ownerId })
    }
    expect((await nightSearchesList(db, orgId)).length).toBe(NIGHT_SEARCHES_MAX)
    expect(await nightSearchAdd(db, { orgId, query: 'one too many', region: null, city: null, createdBy: ownerId, actor: ownerId })).toMatchObject({ ok: false })
  })

  it('reports the latest night with its list as the companies are now, and nothing from another org', async () => {
    expect(await nightReportLatest(db, orgId)).toBeNull()
    const [c] = await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental' }).returning({ id: schema.companies.id })
    const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
    const [theirs] = await db.insert(schema.companies).values({ orgId: other!.id, domain: 'theirs.in', name: 'Theirs' }).returning({ id: schema.companies.id })
    await appendAudit(db, {
      orgId, actor: 'night_shift', action: 'night.ran', subjectType: 'org', subjectId: orgId,
      detail: { date: '2026-10-09', searches: 2, added: 7, scanned: 3, audited: 2, top: [c!.id, theirs!.id, 'not-a-uuid'] },
    })
    const report = await nightReportLatest(db, orgId)
    expect(report).toMatchObject({ date: '2026-10-09', searches: 2, added: 7, scanned: 3, audited: 2 })
    expect(report!.top.map((t) => t.name)).toEqual(['Kumar Dental'])
  })
})
