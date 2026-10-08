/**
 * The public free website check (2026-10-08), against a real migrated
 * database: the booking page's rules for a stranger's request — the org by
 * its slug, a known company or contact used and never rewritten, one email
 * consent with the form's wording for a new contact — and caps per hour and
 * per site.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { CHECKS_PER_HOUR, appendAudit, schema, websiteCheckRequest, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const WORDING = 'Email me about the result.'

describe('the free website check', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy', bookingSlug: 'accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ask = (over: Partial<Parameters<typeof websiteCheckRequest>[1]> = {}) =>
    websiteCheckRequest(db, {
      slug: 'accemy', domain: 'kumardental.in', businessName: 'Kumar Dental', name: 'Ravi Kumar', email: 'Ravi@KumarDental.in',
      timeZone: 'Asia/Kolkata', consentWording: WORDING, now: NOW, ...over,
    })

  it('files a new business and person as inbound, with the one email consent the form asked for, and a deal to call', async () => {
    const r = await ask()
    expect(r).toMatchObject({ ok: true, orgId, orgName: 'Accemy', recognised: false })
    const [co] = await db.select().from(schema.companies).where(eq(schema.companies.orgId, orgId))
    expect(co).toMatchObject({ domain: 'kumardental.in', name: 'Kumar Dental', source: 'inbound' })
    const [ct] = await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, orgId))
    expect(ct).toMatchObject({ email: 'ravi@kumardental.in', firstName: 'Ravi', lastName: 'Kumar' })
    const consents = await db.select().from(schema.consents).where(eq(schema.consents.contactId, ct!.id))
    expect(consents).toEqual([expect.objectContaining({ channel: 'email', granted: true, source: 'website check form', evidence: expect.objectContaining({ wording: WORDING }) })])
    const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, co!.id))
    expect(deal).toMatchObject({ stage: 'replied', nextAction: 'Call — they asked for a free website check' })
    const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'check.requested'))
    expect(row).toMatchObject({ actor: 'website_check', subjectId: co!.id })
    expect(row!.detail).toEqual({ recognised: false })
  })

  it('uses a company and a person already on file as they are, and records no new consent for them', async () => {
    const [co] = await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental Clinic' }).returning({ id: schema.companies.id })
    await db.insert(schema.contacts).values({ orgId, companyId: co!.id, email: 'ravi@kumardental.in', firstName: 'Dr Ravi' })
    expect(await ask({ businessName: 'Someone Else', name: 'Not Ravi' })).toMatchObject({ ok: true, recognised: true, companyId: co!.id })
    expect((await db.select().from(schema.companies).where(eq(schema.companies.id, co!.id)))[0]!.name).toBe('Kumar Dental Clinic')
    expect((await db.select().from(schema.contacts))[0]!.firstName).toBe('Dr Ravi')
    expect(await db.select().from(schema.consents)).toEqual([])
  })

  it('refuses an unknown page, a bad address, the same site twice in an hour, and more than the hour allows', async () => {
    expect(await ask({ slug: 'nobody' })).toMatchObject({ ok: false, status: 404 })
    expect(await ask({ email: 'not-an-address' })).toMatchObject({ ok: false, status: 400 })
    expect(await ask()).toMatchObject({ ok: true })
    expect(await ask({ email: 'other@kumardental.in' })).toMatchObject({ ok: false, status: 429 })
    for (let i = 0; i < CHECKS_PER_HOUR; i++) {
      await appendAudit(db, { orgId, actor: 'website_check', action: 'check.requested', subjectType: 'company', subjectId: orgId, detail: {} })
    }
    expect(await ask({ domain: 'another.in', email: 'a@another.in' })).toMatchObject({ ok: false, status: 429 })
  })
})
