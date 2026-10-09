/**
 * Quotes from chat (2026-10-08): create_quote, get_quote, update_quote and
 * list_quotes, through the context the agent calls them with. None of them
 * sends a quote, makes its link or records a buyer's answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { z } from 'zod'
import { orgProfileSave, quoteRead, quoteSend, serviceCreate, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import seed from '../../db/seed/icp-security-gap-saas.json' with { type: 'json' }
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  createQuote, getQuote, listQuotes, updateQuote, type AgencyToolSpec, type ToolContext, type ToolOutcome,
} from '../src/index.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')

describe('the quote tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true })
    await db.insert(schema.companies).values({
      orgId, domain: 'kumar-dental-ab12.nosite.invalid', name: 'Kumar Dental', source: 'google_maps', googlePlaceId: 'ChIJk',
      googleCategory: 'dentist', listingCheckedAt: new Date('2026-10-07T00:00:00Z'),
    })
    await serviceCreate(db, { orgId, input: { name: 'New website', needs: ['no_website'], priceFrom: 15_000 }, actor: ownerId, createdBy: ownerId })
    await orgProfileSave(db, { orgId, actor: ownerId, updatedBy: ownerId, input: { gstin: '29ABCDE1234F1Z5', gstRate: 18 } })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db,
    orgId,
    principal: { id: ownerId, orgId, role: 'owner' },
    turnId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx())
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }

  it('raises a draft from the services the needs point at, says it is a draft and that nothing was sent', async () => {
    const out = await run(createQuote, { domain: 'kumar-dental-ab12.nosite.invalid' })
    const summary = summaryOf(out)
    expect(summary).toMatch(/^Raised Q-2026-0001 for Kumar Dental/)
    expect(summary).toContain('New website × 1 at ₹15,000')
    expect(summary).toContain('GST 18% ₹2,700 = total ₹17,700')
    expect(summary).toMatch(/DRAFT: nothing was sent/)
    expect(audited.map((a) => a.action)).toEqual(['agent.create_quote'])
    const id = (out as { data: { quoteId: string } }).data.quoteId
    const stored = await quoteRead(db, orgId, id)
    expect(stored).toMatchObject({ status: 'draft', createdBy: null })
  })

  it('takes typed lines in whole rupees, reads them back, edits them and lists them', async () => {
    const out = await run(createQuote, {
      domain: 'kumar-dental-ab12.nosite.invalid',
      title: 'Clinic website',
      lines: [{ name: 'Website', unitPrice: 20_000 }, { name: 'Care plan', unit: 'monthly', unitPrice: 2_000, quantity: 3 }],
    })
    const id = (out as { data: { quoteId: string } }).data.quoteId
    expect(summaryOf(await run(getQuote, { quoteId: id }))).toContain('Care plan × 3 (monthly) at ₹2,000 = ₹6,000')
    const edited = summaryOf(await run(updateQuote, { quoteId: id, lines: [{ name: 'Website', unitPrice: 25_000 }] }))
    expect(edited).toContain('total ₹29,500')
    expect(summaryOf(await run(listQuotes, {}))).toMatch(/Q-2026-0001 · Kumar Dental · draft · ₹29,500/)
  })

  it('says a sent quote became a draft again when it is edited, and that a person must send it again', async () => {
    const out = await run(createQuote, { domain: 'kumar-dental-ab12.nosite.invalid' })
    const id = (out as { data: { quoteId: string } }).data.quoteId
    await quoteSend(db, { orgId, quoteId: id, actor: ownerId, now: NOW })
    const summary = summaryOf(await run(updateQuote, { quoteId: id, title: 'Revised' }))
    expect(summary).toMatch(/DRAFT again/)
    expect(summary).toMatch(/must mark it sent again/)
  })

  it('refuses a company that is not in the CRM, and a role that may not write', async () => {
    expect(await run(createQuote, { domain: 'nowhere.example' })).toMatchObject({ ok: false, code: 'not_found' })
    const viewer = { ...ctx(), principal: { id: ownerId, orgId, role: 'viewer' } } as unknown as ToolContext
    const r = await createQuote.handler({ domain: 'kumar-dental-ab12.nosite.invalid' } as never, viewer)
    expect(r).toMatchObject({ ok: false, code: 'not_permitted' })
  })
})
