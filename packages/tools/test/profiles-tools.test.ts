/**
 * The profile tools and what a company is recorded as, through the tools the
 * agent calls (0021): list_icps, create_icp and activate_icp; add_company,
 * import_companies and update_company with a market and a size; and the reads
 * that filter and show them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Principal } from '@agency/core'
import type { AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import seed from '../../db/seed/icp-security-gap-saas.json' with { type: 'json' }
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  activateIcp, addCompany, createIcp, getCompany, getIcp, importCompanies, listIcps, searchCompanies, updateCompany,
  type AgencyToolSpec, type ToolContext, type ToolOutcome,
} from '../src/index.js'

const NOW = new Date('2026-10-07T09:00:00.000Z')

describe('the profile tools, and a company’s market and size', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let memberId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'priya@agency.test', name: 'Priya', role: 'owner' },
        { orgId, email: 'sam@agency.test', name: 'Sam', role: 'member' },
      ])
      .returning({ id: schema.users.id, role: schema.users.role })
    ownerId = users.find((u) => u.role === 'owner')!.id
    memberId = users.find((u) => u.role === 'member')!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: ownerId, orgId, role: 'owner' },
    turnId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))
  const member = (): Partial<ToolContext> => ({ principal: { id: memberId, orgId, role: 'member' } as Principal })
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }
  const refusalOf = (out: ToolOutcome<unknown>): { code: string; message: string } => {
    if (out.ok) throw new Error(`expected a refusal, got: ${out.summary}`)
    return { code: out.code, message: out.message }
  }
  const companyRow = async (domain: string) =>
    (await db.select().from(schema.companies).where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.domain, domain))))[0]

  describe('profiles', () => {
    it('lists the active profile with who it targets', async () => {
      const summary = summaryOf(await run(listIcps, {}))
      expect(summary).toMatch(/● ACTIVE {2}Security-gap SaaS \(US\/EU\) — markets: United States, Canada, United Kingdom/)
      expect(summary).toMatch(/15–400 staff/)
      expect(summary).toMatch(/over 400 staff is disqualified at its next scan/)
      expect(audited).toEqual([{ action: 'agent.list_icps', detail: { profiles: 1 } }])
    })

    it('creates an India profile for small and mid-size companies, inactive, as an owner only', async () => {
      const input = {
        label: 'Security-gap SaaS (India, 10–500 staff)', geos: ['India'], headcountMin: 10, headcountMax: 500,
      }
      expect(refusalOf(await run(createIcp, input, member())).code).toBe('not_permitted')

      const summary = summaryOf(await run(createIcp, input))
      expect(summary).toMatch(/Created the profile "Security-gap SaaS \(India, 10–500 staff\)" from "Security-gap SaaS \(US\/EU\)": markets India; 10–500 staff/)
      expect(summary).toMatch(/It is NOT active/)
      const rows = await db.select().from(schema.icpProfiles).where(eq(schema.icpProfiles.orgId, orgId))
      expect(rows.find((r) => r.name.includes('India'))?.active).toBe(false)
      expect(audited.at(-1)).toMatchObject({ action: 'agent.create_icp', detail: { created: true } })

      expect(refusalOf(await run(createIcp, { label: 'Elsewhere', geos: ['Atlantis'] })).message).toMatch(/not a country/)
    })

    it('switches the active profile, as an owner only, and says what follows', async () => {
      await run(createIcp, { label: 'Security-gap SaaS (India)', geos: ['IN'] })
      expect(refusalOf(await run(activateIcp, { name: 'Security-gap SaaS (India)' }, member())).code).toBe('not_permitted')
      const summary = summaryOf(await run(activateIcp, { name: 'Security-gap SaaS (India)' }))
      expect(summary).toMatch(/is now the active profile \(it was "Security-gap SaaS \(US\/EU\)"\)/)
      expect(summary).toMatch(/needs a scan under this profile/)
      expect(refusalOf(await run(activateIcp, { name: 'Nope' })).code).toBe('not_found')
      expect(summaryOf(await run(getIcp, {}))).toMatch(/^ICP: Security-gap SaaS \(India\)\nTargets: markets India/)
    })
  })

  describe('a company’s market and size', () => {
    it('adds a company with its industry, city and a headcount with its source', async () => {
      const summary = summaryOf(
        await run(addCompany, {
          domain: 'acme.in', name: 'Acme', country: 'India', timeZone: 'Asia/Kolkata', industry: 'fintech',
          city: 'Bengaluru', headcount: 120, headcountSource: 'https://www.linkedin.com/company/acme', stage: 'series-a',
          description: 'Payments APIs for small businesses.',
        }),
      )
      expect(summary).toMatch(/industry fintech, city Bengaluru, stage series-a, ~120 staff \(per https:\/\/www\.linkedin\.com\/company\/acme\)/)
      expect(await companyRow('acme.in')).toMatchObject({ headcount: 120, industry: 'fintech', city: 'Bengaluru', stage: 'series-a' })

      expect(refusalOf(await run(addCompany, { domain: 'beta.in', headcountSource: 'linkedin' })).message).toMatch(
        /needs the headcount it is for/,
      )
      expect(await companyRow('beta.in')).toBeUndefined()
    })

    it('imports a list with each company’s details, refusing a line whose details would not store', async () => {
      const out = await run(importCompanies, {
        companies: [
          { domain: 'one.in', name: 'One', country: 'India', headcount: 40, headcountSource: 'tracxn', industry: 'healthtech' },
          { domain: 'two.in', name: 'Two', headcountSource: 'no count' },
          { domain: 'three.in', name: 'Three' },
        ],
      })
      const summary = summaryOf(out)
      expect(summary).toMatch(/2 companies added/)
      expect(summary).toMatch(/Refused, line 2 \("two\.in"\): A headcount source needs the headcount it is for/)
      expect(await companyRow('one.in')).toMatchObject({ headcount: 40, headcountSource: 'tracxn', industry: 'healthtech' })
      expect(await companyRow('two.in')).toBeUndefined()
    })

    it('says a headcount changes the score at the next scan', async () => {
      await run(addCompany, { domain: 'acme.in' })
      const summary = summaryOf(await run(updateCompany, { domain: 'acme.in', headcount: 900, headcountSource: 'linkedin' }))
      expect(summary).toMatch(/changed its headcount, headcount source/)
      expect(summary).toMatch(/judged against the active profile at its next scan/)
    })

    it('filters by country and size, and shows what is recorded beside each', async () => {
      await run(importCompanies, {
        companies: [
          { domain: 'one.in', country: 'India', headcount: 40, headcountSource: 'x' },
          { domain: 'big.in', country: 'IN', headcount: 4000, headcountSource: 'x' },
          { domain: 'us.example', country: 'United States', headcount: 40, headcountSource: 'x' },
        ],
      })
      const summary = summaryOf(await run(searchCompanies, { country: 'india', headcountMax: 500 }))
      expect(summary).toMatch(/^1 companies matched/)
      expect(summary).toMatch(/one\.in .*\[IN · ~40 staff\]/)
      expect(refusalOf(await run(searchCompanies, { country: 'Atlantis' })).message).toMatch(/not a country/)

      expect(summaryOf(await run(getCompany, { domain: 'one.in' }))).toMatch(
        /Recorded about it \(research, not scan evidence\): in India; ~40 staff \(per x\)/,
      )
    })
  })
})
