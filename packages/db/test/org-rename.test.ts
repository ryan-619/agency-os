/**
 * The organisation's name, renamed by an owner (Settings → Organisation),
 * against a real migrated database: the change and its audit row land
 * together, a name another org holds is a sentence, and what cannot be
 * stored is refused before anything is written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { ORG_NAME_MAX, orgName, orgNameFrom, renameOrg, schema, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('renaming the organisation', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const audits = () => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'org.renamed'))

  it('renames it and records who, from what, to what, in the same transaction', async () => {
    const outcome = await renameOrg(db, { orgId, name: '  Accemy  ', actor: userId })
    expect(outcome).toEqual({ ok: true, name: 'Accemy', changed: true })
    expect(await orgName(db, orgId)).toBe('Accemy')
    const [row] = await audits()
    expect(row).toMatchObject({ orgId, actor: userId, subjectType: 'org', subjectId: orgId, detail: { from: 'Agency', to: 'Accemy' } })
  })

  it('changes nothing and writes no row for the name it already has', async () => {
    await renameOrg(db, { orgId, name: 'Accemy', actor: userId })
    const again = await renameOrg(db, { orgId, name: 'Accemy', actor: userId })
    expect(again).toEqual({ ok: true, name: 'Accemy', changed: false })
    expect(await audits()).toHaveLength(1)
  })

  it('refuses a name another organisation holds, with a sentence, and writes nothing', async () => {
    await db.insert(schema.orgs).values({ name: 'Taken Co' })
    const outcome = await renameOrg(db, { orgId, name: 'Taken Co', actor: userId })
    expect(outcome).toMatchObject({ ok: false, reason: 'taken' })
    expect(await orgName(db, orgId)).toBe('Agency')
    expect(await audits()).toHaveLength(0)
  })

  it.each([
    ['blank', '   '],
    ['not a string', 42],
    ['a control character', 'Acc\u0000emy'],
    ['too long', 'x'.repeat(ORG_NAME_MAX + 1)],
  ])('refuses a name that is %s before anything is written', async (_label, name) => {
    const outcome = await renameOrg(db, { orgId, name, actor: userId })
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await orgName(db, orgId)).toBe('Agency')
    expect(await audits()).toHaveLength(0)
  })

  it('counts length in code points and folds runs of whitespace', () => {
    expect(orgNameFrom('😀'.repeat(ORG_NAME_MAX))).toEqual({ ok: true, name: '😀'.repeat(ORG_NAME_MAX) })
    expect(orgNameFrom('Accemy \n  Studio')).toEqual({ ok: true, name: 'Accemy Studio' })
  })

  it('answers not_found for an organisation that does not exist', async () => {
    const outcome = await renameOrg(db, { orgId: '00000000-0000-4000-8000-000000000000', name: 'X', actor: userId })
    expect(outcome).toMatchObject({ ok: false, reason: 'not_found' })
  })
})
