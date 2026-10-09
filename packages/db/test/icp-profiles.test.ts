/**
 * /settings/icp's read (§2.2).
 *
 * The tests that matter are the ones about ambiguity and ownership. `active`
 * has no partial-unique index, so two active rows are storable, and the page
 * exists partly to SHOW that — a list that returned one of them would hide
 * exactly the state it is there to flag. And a profile is org data: another
 * org's row, and another org's scores against a profile, are not this org's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { icpProfilesList, schema, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const DEF = {
  label: 'Test profile',
  disqualifiers: {},
  signals: { csp: { weight: 10, why: 'No CSP', order: 1 } },
  scoring: { qualify_at: 45, tiers: [{ name: 'A', floor: 70 }] },
}

describe('icpProfilesList', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('returns nothing for an org with no profile', async () => {
    expect(await icpProfilesList(db, orgId)).toEqual([])
  })

  it("returns only this org's rows", async () => {
    await db.insert(schema.icpProfiles).values([
      { orgId, name: 'ours', definition: DEF, active: true },
      { orgId: otherOrgId, name: 'theirs', definition: DEF, active: true },
    ])
    const rows = await icpProfilesList(db, orgId)
    expect(rows.map((r) => r.name)).toEqual(['ours'])
    expect((await icpProfilesList(db, otherOrgId)).map((r) => r.name)).toEqual(['theirs'])
  })

  /**
   * Until 0021 two active rows were a state `activeIcpProfile` resolved
   * arbitrarily, and this listed both so the page could say so. 0021's
   * `icp_profiles_one_active_per_org` makes the state unstorable; the list
   * still puts the active one first, then the rest by name.
   */
  it('returns the active row first, then the rest by name — and a second active row cannot be stored', async () => {
    await db.insert(schema.icpProfiles).values([
      { orgId, name: 'b-inactive', definition: DEF, active: false },
      { orgId, name: 'z-active', definition: DEF, active: true },
      { orgId, name: 'a-inactive', definition: DEF, active: false },
    ])
    await expect(db.insert(schema.icpProfiles).values({ orgId, name: 'm-active', definition: DEF, active: true })).rejects.toThrow()
    const rows = await icpProfilesList(db, orgId)
    expect(rows.map((r) => [r.name, r.active])).toEqual([
      ['z-active', true],
      ['a-inactive', false],
      ['b-inactive', false],
    ])
  })

  it('hands back the definition as stored, for the page to parse', async () => {
    await db.insert(schema.icpProfiles).values({ orgId, name: 'ours', definition: DEF })
    const [row] = await icpProfilesList(db, orgId)
    expect(row!.definition).toEqual(DEF)
    expect(row!.createdAt).toBeInstanceOf(Date)
  })

  /**
   * The count behind "N stored scores name this definition". It is a number,
   * not the driver's text, and it counts this org's scores only.
   */
  it('counts the scores that name each profile, as a number', async () => {
    const [ours, idle] = await db
      .insert(schema.icpProfiles)
      .values([
        { orgId, name: 'ours', definition: DEF, active: true },
        { orgId, name: 'idle', definition: DEF, active: false },
      ])
      .returning({ id: schema.icpProfiles.id })
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'acme.test' })
      .returning({ id: schema.companies.id })
    for (let i = 0; i < 3; i++) {
      const [scan] = await db
        .insert(schema.scans)
        .values({ orgId, companyId: company!.id, ok: true })
        .returning({ id: schema.scans.id })
      await db.insert(schema.scores).values({
        orgId, companyId: company!.id, scanId: scan!.id, icpProfileId: ours!.id, score: 50 + i,
      })
    }
    const rows = await icpProfilesList(db, orgId)
    expect(rows.find((r) => r.id === ours!.id)?.scores).toBe(3)
    expect(rows.find((r) => r.id === idle!.id)?.scores).toBe(0)
  })
})
