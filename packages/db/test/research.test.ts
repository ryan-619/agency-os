/**
 * Research with sources (0028): claims are recorded with their pages, once
 * per claim per page, for a company in this org; read back newest first with
 * who recorded each; deleted by the recorder, an owner, or anybody when the
 * agent recorded it; and the database holds the shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { expectRejection, migratedDb, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import type { AgencyDb } from '../src/repository.js'
import { researchCount, researchDelete, researchFor, researchRecord } from '../src/research.js'

describe('research', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let memberId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'o@accemy.test', role: 'owner', name: 'Owner' }).returning({ id: schema.users.id }))[0]!.id
    memberId = (await db.insert(schema.users).values({ orgId, email: 'm@accemy.test', role: 'member' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental' }).returning({ id: schema.companies.id }))[0]!.id
  }, 30_000)
  afterEach(async () => {
    await test.close()
  })

  const fact = (claim: string, sourceUrl = 'https://inc42.com/kumar') => ({ claim, sourceUrl })

  it('records claims with their pages once, audits counts only, and reads them back newest first', async () => {
    const r = await researchRecord(db, { orgId, companyId, facts: [fact('Raised ₹3 crore in 2026'), fact('Has three clinics', 'https://www.kumardental.in/about')], recordedBy: null, actor: 'agent' })
    expect(r).toMatchObject({ ok: true, recorded: 2, skipped: 0 })
    const again = await researchRecord(db, { orgId, companyId, facts: [fact('Raised ₹3 crore in 2026'), fact('Opened in 2012', 'https://www.kumardental.in/about')], recordedBy: memberId, actor: memberId })
    expect(again).toMatchObject({ ok: true, recorded: 1, skipped: 1 })
    expect(await researchCount(db, orgId, companyId)).toBe(3)

    const rows = await researchFor(db, orgId, companyId)
    expect(rows.map((x) => x.claim)).toEqual(['Opened in 2012', 'Has three clinics', 'Raised ₹3 crore in 2026'])
    expect(rows[0]).toMatchObject({ recordedBy: memberId, recordedByEmail: 'm@accemy.test', sourceUrl: 'https://www.kumardental.in/about' })
    expect(rows[2]!.recordedBy).toBeNull()

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'research.recorded'))
    expect(audit).toHaveLength(2)
    expect(audit[0]!.detail).toEqual({ companyId, recorded: 2, skipped: 0, recordedBy: null })
    expect(JSON.stringify(audit)).not.toContain('crore')
  })

  it('refuses a bad claim or source, too many, and a company not here, writing nothing', async () => {
    expect(await researchRecord(db, { orgId, companyId, facts: [fact('x', 'http://inc42.com/a')], recordedBy: null, actor: 'agent' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await researchRecord(db, { orgId, companyId, facts: [fact('https://inc42.com/a')], recordedBy: null, actor: 'agent' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await researchRecord(db, { orgId, companyId, facts: Array.from({ length: 11 }, (_, i) => fact(`c${i}`)), recordedBy: null, actor: 'agent' })).toMatchObject({ ok: false, reason: 'too_many' })
    expect(await researchRecord(db, { orgId, companyId: '00000000-0000-0000-0000-000000000000', facts: [fact('x')], recordedBy: null, actor: 'agent' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await researchCount(db, orgId, companyId)).toBe(0)
  })

  it('is deleted by its recorder, an owner, or anybody when the agent recorded it', async () => {
    const mine = await researchRecord(db, { orgId, companyId, facts: [fact('mine')], recordedBy: memberId, actor: memberId })
    const agents = await researchRecord(db, { orgId, companyId, facts: [fact('agent’s')], recordedBy: null, actor: 'agent' })
    const owners = await researchRecord(db, { orgId, companyId, facts: [fact('owner’s')], recordedBy: ownerId, actor: ownerId })
    if (!mine.ok || !agents.ok || !owners.ok) throw new Error('setup')
    expect(await researchDelete(db, { orgId, id: owners.ids[0]!, byUserId: memberId, isOwner: false })).toMatchObject({ ok: false, reason: 'not_permitted' })
    expect(await researchDelete(db, { orgId, id: agents.ids[0]!, byUserId: memberId, isOwner: false })).toEqual({ ok: true })
    expect(await researchDelete(db, { orgId, id: mine.ids[0]!, byUserId: memberId, isOwner: false })).toEqual({ ok: true })
    expect(await researchDelete(db, { orgId, id: owners.ids[0]!, byUserId: ownerId, isOwner: true })).toEqual({ ok: true })
    expect(await researchDelete(db, { orgId, id: owners.ids[0]!, byUserId: ownerId, isOwner: true })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await researchCount(db, orgId, companyId)).toBe(0)
  })

  it('holds the shape: https sources, bounded claims, one claim per page, the company in its org', async () => {
    const other = (await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id }))[0]!.id
    const refused = (org: string, claim: string, url: string) =>
      expectRejection(() => test.pg.query('INSERT INTO company_research (org_id, company_id, claim, source_url) VALUES ($1, $2, $3, $4)', [org, companyId, claim, url]))
    expect(await refused(orgId, 'x', 'http://a.com')).toMatch(/company_research_source_is_a_page/)
    expect(await refused(orgId, '   ', 'https://a.com')).toMatch(/company_research_claim_is_bounded/)
    expect(await refused(other, 'x', 'https://a.com')).toMatch(/company_research_company_in_org/)
    await test.pg.query('INSERT INTO company_research (org_id, company_id, claim, source_url) VALUES ($1, $2, $3, $4)', [orgId, companyId, 'x', 'https://a.com'])
    expect(await refused(orgId, 'x', 'https://a.com')).toMatch(/company_research_one_claim_per_source/)
  })
})
