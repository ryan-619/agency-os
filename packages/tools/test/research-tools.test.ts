/**
 * record_research and get_research (0028): claims with their pages, written
 * at once as the agent's, read back with the warning that none of it is
 * evidence; a bad source or an unknown company writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import { getCompany, getResearch, recordResearch, type AgencyToolSpec, type ToolContext, type ToolOutcome } from '../src/index.js'

describe('the research tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'priya@accemy.test', name: 'Priya', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental' }).returning({ id: schema.companies.id }))[0]!.id
  }, 30_000)
  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db, orgId, principal: { id: userId, orgId, role: 'owner' }, turnId: '44444444-4444-4444-8444-444444444444',
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) => spec.handler(z.object(spec.shape).parse(input) as never, ctx())
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }

  it('records claims with their pages as the agent’s, skips a repeat, and reads them back as research', async () => {
    const out = await run(recordResearch, {
      domain: 'https://www.kumardental.in/',
      facts: [
        { claim: 'Opened a second clinic in Indiranagar in 2026.', sourceUrl: 'https://inc42.com/kumar-dental', sourceTitle: 'Inc42' },
        { claim: 'Lists 14 staff on LinkedIn.', sourceUrl: 'https://www.linkedin.com/company/kumar-dental/' },
      ],
    })
    expect(summaryOf(out)).toContain('Recorded 2 research claims on kumardental.in')
    expect(summaryOf(out)).toContain('never as a finding')
    expect(audited.at(-1)).toMatchObject({ action: 'agent.record_research', detail: { companyId, recorded: 2, skipped: 0 } })
    const rows = await db.select().from(schema.companyResearch).where(eq(schema.companyResearch.companyId, companyId))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.recordedBy === null)).toBe(true)

    const again = await run(recordResearch, { domain: 'kumardental.in', facts: [{ claim: 'Lists 14 staff on LinkedIn.', sourceUrl: 'https://www.linkedin.com/company/kumar-dental/' }] })
    expect(summaryOf(again)).toContain('Recorded 0 research claims')
    expect(summaryOf(again)).toContain('1 already on file')

    const read = summaryOf(await run(getResearch, { domain: 'kumardental.in' }))
    expect(read).toContain('2 research claims on file about kumardental.in')
    expect(read).toContain('Opened a second clinic in Indiranagar in 2026. — Inc42, https://inc42.com/kumar-dental (the agent)')
    expect(read).toContain('quote none of it to the company')

    const company = summaryOf(await run(getCompany, { domain: 'kumardental.in' }))
    expect(company).toContain('2 research claims with sources on file (get_research reads them) — research, never evidence.')
  })

  it('refuses a bad source or an unknown company, writing nothing', async () => {
    const http = await run(recordResearch, { domain: 'kumardental.in', facts: [{ claim: 'Something.', sourceUrl: 'http://inc42.com/x' }] })
    expect(http.ok).toBe(false)
    if (!http.ok) expect(http.message).toMatch(/https.*Nothing was recorded/)
    const unknown = await run(recordResearch, { domain: 'nobody.in', facts: [{ claim: 'Something.', sourceUrl: 'https://inc42.com/x' }] })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.code).toBe('not_found')
    expect(await db.select().from(schema.companyResearch)).toEqual([])
    expect(summaryOf(await run(getResearch, { domain: 'kumardental.in' }))).toContain('No research is on file')
  })
})
