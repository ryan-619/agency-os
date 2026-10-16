/**
 * The public free website check (2026-10-08), against a real migrated
 * database: the booking page's rules for a stranger's request — the org by
 * its slug, one email consent with the form's wording for a new contact —
 * caps per hour and per site, held under the org's lock, and nothing changed
 * for a site or an address already on file (review, 2026-10-08).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { CHECKS_PER_HOUR, VERIFY_TASK_TITLE, appendAudit, schema, verifyTaskDetail, websiteCheckRequest, type AgencyDb } from '../src/index.js'
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

  it('changes nothing for a site already on file: no contact, consent or deal move — one task for a person to confirm who asked', async () => {
    const [co] = await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental Clinic' }).returning({ id: schema.companies.id })
    await db.insert(schema.contacts).values({ orgId, companyId: co!.id, email: 'ravi@kumardental.in', firstName: 'Dr Ravi' })
    await db.insert(schema.deals).values({ orgId, companyId: co!.id, stage: 'contacted' })
    const r = await ask({ businessName: 'Someone Else', name: 'Not Ravi', email: 'stranger@elsewhere.in' })
    expect(r).toEqual({ ok: true, recognised: true, orgId, orgName: 'Accemy' })
    expect((await db.select().from(schema.companies).where(eq(schema.companies.id, co!.id)))[0]!.name).toBe('Kumar Dental Clinic')
    expect((await db.select().from(schema.contacts)).map((c) => c.email)).toEqual(['ravi@kumardental.in'])
    expect(await db.select().from(schema.consents)).toEqual([])
    expect((await db.select().from(schema.deals)).map((d) => d.stage)).toEqual(['contacted'])
    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toEqual([expect.objectContaining({ title: VERIFY_TASK_TITLE, companyId: co!.id, kind: 'todo', createdBy: null })])
    expect(tasks[0]!.detail).toBe(verifyTaskDetail('kumardental.in', 'Not Ravi', 'stranger@elsewhere.in'))
    const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'check.requested'))
    expect(row).toMatchObject({ actor: 'website_check', subjectType: 'company', subjectId: co!.id })
    expect(row!.detail).toEqual({ recognised: true, by: 'site', task: 'made' })
  })

  it('changes nothing for an address already on file, even with a new site — the site is not filed', async () => {
    const [co] = await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in' }).returning({ id: schema.companies.id })
    const [ct] = await db.insert(schema.contacts).values({ orgId, companyId: co!.id, email: 'ravi@kumardental.in' }).returning({ id: schema.contacts.id })
    const r = await ask({ domain: 'brand-new-site.in' })
    expect(r).toMatchObject({ ok: true, recognised: true })
    expect((await db.select().from(schema.companies)).map((c) => c.domain)).toEqual(['kumardental.in'])
    expect(await db.select().from(schema.deals)).toEqual([])
    expect(await db.select().from(schema.tasks)).toEqual([expect.objectContaining({ title: VERIFY_TASK_TITLE, companyId: co!.id })])
    const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'check.requested'))
    expect(row).toMatchObject({ subjectType: 'contact', subjectId: ct!.id })
    expect(row!.detail).toEqual({ recognised: true, by: 'address', task: 'made' })
    // The same address again inside the hour is refused; after it, the open task is not made twice.
    expect(await ask({ domain: 'third-site.in' })).toMatchObject({ ok: false, status: 429 })
    // The audit log is append-only and stamps its own time, so "an hour later" is asked from two hours past the clock.
    const later = new Date(Date.now() + 2 * 3_600_000)
    expect(await ask({ domain: 'third-site.in', now: later })).toMatchObject({ ok: true, recognised: true })
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'check.requested'))
    expect(rows.map((x) => (x.detail as { task?: string }).task).sort()).toEqual(['already_open', 'made'])
  })

  it('holds the hourly cap for requests that arrive together', async () => {
    const asks = Array.from({ length: CHECKS_PER_HOUR + 5 }, (_, i) => ask({ domain: `site-${i}.in`, email: `owner${i}@site-${i}.in` }))
    const results = await Promise.all(asks)
    expect(results.filter((x) => x.ok)).toHaveLength(CHECKS_PER_HOUR)
    expect(results.filter((x) => !x.ok)).toHaveLength(5)
    expect(await db.select().from(schema.companies)).toHaveLength(CHECKS_PER_HOUR)
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
