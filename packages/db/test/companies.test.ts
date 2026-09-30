/**
 * Editing a company (PROMPT.md §2.1), against a real engine.
 *
 * The zone is the field that matters: the send path falls back to it for
 * every contact here who has none, so a zone the runtime does not know must
 * be refused before it is stored — with the same sentence `createContact`
 * gives, since it is the same mistake.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  companiesEditView, companiesUpdate, companyPatchInput, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('companyPatchInput', () => {
  it('trims, and refuses a key it does not know rather than dropping it', () => {
    expect(companyPatchInput.parse({ name: '  Rentman  ' })).toEqual({ name: 'Rentman' })
    expect(companyPatchInput.safeParse({ domain: 'evil.example' }).success).toBe(false)
    expect(companyPatchInput.safeParse({ timezone: 'Europe/London' }).success).toBe(false)
  })
})

describe('companiesUpdate', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Other agency' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', country: 'Netherlands', timeZone: 'Europe/Amsterdam' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const stored = async () =>
    (await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)))[0]!

  it('refuses a zone the runtime does not know, with the sentence createContact uses, and stores nothing', async () => {
    const r = await companiesUpdate(db, orgId, companyId, { timeZone: 'Pacific Time', name: 'Renamed' })
    expect(r).toEqual({
      ok: false,
      reason: 'invalid',
      message: '"Pacific Time" is not a timezone this system recognises. Use an IANA name like Europe/London.',
    })
    const row = await stored()
    expect(row.timeZone).toBe('Europe/Amsterdam')
    expect(row.name).toBe('Rentman')
  })

  it('accepts a zone with no slash that the runtime knows', async () => {
    const r = await companiesUpdate(db, orgId, companyId, { timeZone: 'Japan' })
    expect(r.ok).toBe(true)
    expect((await stored()).timeZone).toBe('Japan')
  })

  it("answers not found for another org's company, and changes nothing", async () => {
    const r = await companiesUpdate(db, otherOrgId, companyId, { name: 'Hijacked' })
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
    expect((await stored()).name).toBe('Rentman')
  })

  it('answers not found for an id that is not a uuid, rather than a database error', async () => {
    expect(await companiesUpdate(db, orgId, 'not-a-uuid', { name: 'x' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await companiesEditView(db, orgId, 'not-a-uuid')).toBeNull()
  })

  it('leaves a field alone when it is undefined and clears it when it is null', async () => {
    const r = await companiesUpdate(db, orgId, companyId, { country: null })
    expect(r).toMatchObject({ ok: true, changed: ['country'] })
    const row = await stored()
    expect(row.country).toBeNull()
    expect(row.name).toBe('Rentman')
    expect(row.timeZone).toBe('Europe/Amsterdam')
  })

  it('reads a blank value as clearing the field', async () => {
    const r = await companiesUpdate(db, orgId, companyId, { timeZone: '   ' })
    expect(r).toMatchObject({ ok: true, changed: ['timeZone'] })
    expect((await stored()).timeZone).toBeNull()
  })

  it('lists exactly the fields whose value changed, in a fixed order', async () => {
    const r = await companiesUpdate(db, orgId, companyId, {
      timeZone: 'Europe/London', name: 'Rentman', country: 'United Kingdom',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // `name` was sent but is what was already stored, so it did not change.
    expect(r.changed).toEqual(['country', 'timeZone'])
    expect(r.company).toMatchObject({ name: 'Rentman', country: 'United Kingdom', timeZone: 'Europe/London' })
  })

  it('writes nothing when nothing changed', async () => {
    const before = await stored()
    const r = await companiesUpdate(db, orgId, companyId, { name: 'Rentman' })
    expect(r).toMatchObject({ ok: true, changed: [] })
    expect((await stored()).updatedAt).toEqual(before.updatedAt)
  })

  it('never touches the domain, even when a caller built the patch by hand', async () => {
    const r = await companiesUpdate(db, orgId, companyId, { domain: 'evil.example' } as never)
    expect(r).toMatchObject({ ok: false, reason: 'invalid' })
    expect((await stored()).domain).toBe('rentman.io')
  })

  it('counts the people here for whom the company zone is the only one', async () => {
    await db.insert(schema.contacts).values([
      { orgId, companyId, email: 'a@rentman.io', timeZone: null },
      { orgId, companyId, email: 'b@rentman.io', timeZone: 'Europe/London' },
      { orgId, companyId, email: 'c@rentman.io', timeZone: null },
    ])
    const view = await companiesEditView(db, orgId, companyId)
    expect(view?.contactsWithoutZone).toBe(2)
    expect(view?.company.domain).toBe('rentman.io')
    expect(await companiesEditView(db, otherOrgId, companyId)).toBeNull()
  })
})
