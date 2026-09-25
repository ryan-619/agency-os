/**
 * The pipeline tools (PROMPT.md §6, §8.6).
 *
 * Three tools Phase 2 deliberately withheld, now that deals are written by
 * the send path. What matters: `get_pipeline` never lists a company nobody
 * has touched; `update_deal` refuses a lost deal with no reason; and
 * `book_meeting` records a meeting and moves the deal WITHOUT sending
 * anything or touching a calendar — which its summary says, because the
 * model repeats summaries to people.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { z } from 'zod'
import { AGENCY_TOOL_NAMES } from '@agency/core'
import { openDealFor, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb,type TestDb } from '../../db/test/helpers.js'
import {
  AGENCY_TOOLS, bookMeeting, getPipeline, updateDeal, type AgencyToolSpec, type ToolContext,
} from '../src/index.js'

describe('the pipeline tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let userId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'o@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    await db.insert(schema.contacts).values({ orgId, companyId, email: 'priya@rentman.io', firstName: 'Priya' })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db,
    orgId,
    principal: { id: userId, orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => new Date('2026-09-15T12:00:00.000Z'),
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx())

  it('is registered, classified, and named consistently', () => {
    for (const name of ['get_pipeline', 'update_deal', 'book_meeting']) {
      expect(AGENCY_TOOLS.map((t) => t.name)).toContain(name)
      expect(AGENCY_TOOL_NAMES).toContain(name)
    }
  })

  describe('get_pipeline', () => {
    it('lists nothing for a company nobody has done anything about', async () => {
      const out = await run(getPipeline, {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.data).toEqual([])
      expect(out.summary).toMatch(/No open deals/)
    })

    it('lists open deals with their company and next action, and not closed ones', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'replied', nextAction: 'answer them' })
      const [other] = await db.insert(schema.companies).values({ orgId, domain: 'lost.io' }).returning({ id: schema.companies.id })
      await db.insert(schema.deals).values({
        orgId, companyId: other!.id, stage: 'lost', lostReason: 'budget', closedAt: new Date(),
      })
      const out = await run(getPipeline, {})
      if (!out.ok) throw new Error(out.message)
      const rows = out.data as Array<{ domain: string; stage: string; nextAction: string | null }>
      expect(rows).toEqual([expect.objectContaining({ domain: 'rentman.io', stage: 'replied', nextAction: 'answer them' })])
      expect(out.summary).toContain('rentman.io')
    })

    it('filters by stage', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'replied' })
      const out = await run(getPipeline, { stage: 'meeting' })
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toEqual([])
    })

    it('does not see another org’s deals', async () => {
      const [rival] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const [c] = await db.insert(schema.companies).values({ orgId: rival!.id, domain: 'theirs.io' }).returning({ id: schema.companies.id })
      await db.insert(schema.deals).values({ orgId: rival!.id, companyId: c!.id, stage: 'meeting' })
      const out = await run(getPipeline, {})
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toEqual([])
    })
  })

  describe('update_deal', () => {
    it('creates the deal at the stage asked for when there is none', async () => {
      const out = await run(updateDeal, { domain: 'rentman.io', stage: 'contacted', nextAction: 'follow up Thursday' })
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ stage: 'contacted', nextAction: 'follow up Thursday' })
      expect((await openDealFor(db, orgId, companyId))!.stage).toBe('contacted')
    })

    it('moves an existing deal in either direction, because a person asked', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' })
      const out = await run(updateDeal, { domain: 'rentman.io', stage: 'replied' })
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ stage: 'replied' })
    })

    it('sets a next action without touching the stage', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' })
      const out = await run(updateDeal, { domain: 'rentman.io', nextAction: 'send the proposal' })
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ stage: 'meeting', nextAction: 'send the proposal' })
    })

    it('refuses to lose a deal without a reason', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'proposal' })
      const out = await run(updateDeal, { domain: 'rentman.io', stage: 'lost' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.message).toMatch(/reason/)
      expect((await openDealFor(db, orgId, companyId))!.stage).toBe('proposal')
    })

    it('closes a lost deal with its reason', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'proposal' })
      const out = await run(updateDeal, { domain: 'rentman.io', stage: 'lost', lostReason: 'no budget this year' })
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ stage: 'lost', closed: true })
      expect(await openDealFor(db, orgId, companyId)).toBeNull()
    })

    it('refuses a change that changes nothing, and an unknown company', async () => {
      expect((await run(updateDeal, { domain: 'rentman.io' })).ok).toBe(false)
      expect((await run(updateDeal, { domain: 'nobody.io', stage: 'meeting' })).ok).toBe(false)
    })

    it('audits what it did', async () => {
      await run(updateDeal, { domain: 'rentman.io', stage: 'contacted' })
      expect(audited.some((a) => a.action === 'agent.update_deal' && a.detail['stage'] === 'contacted')).toBe(true)
    })
  })

  describe('book_meeting', () => {
    const at = '2026-09-18T14:00:00Z'

    it('records the meeting and moves the deal, and says no invitation was sent', async () => {
      const out = await run(bookMeeting, { domain: 'rentman.io', contactEmail: 'Priya@Rentman.io', startsAt: at, timeZone: 'Europe/London' })
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ domain: 'rentman.io', deal: 'created:meeting' })
      expect(out.summary).toMatch(/No invitation was sent/)
      const [meeting] = await db.select().from(schema.meetings)
      expect(meeting!.source).toBe('agent')
      expect(meeting!.contactId).not.toBeNull()
      expect(meeting!.endsAt!.getTime() - meeting!.startsAt.getTime()).toBe(30 * 60_000)
      expect((await openDealFor(db, orgId, companyId))!.stage).toBe('meeting')
    })

    it('refuses a contact address it does not have on file, rather than guessing', async () => {
      const out = await run(bookMeeting, { domain: 'rentman.io', contactEmail: 'ceo@rentman.io', startsAt: at, timeZone: 'Europe/London' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.message).toMatch(/Add them first/)
      expect(await db.select().from(schema.meetings)).toEqual([])
    })

    it.each([
      ['a time that is not an instant', { startsAt: 'Thursday at 2', timeZone: 'Europe/London' }],
      ['a timezone it does not know', { startsAt: at, timeZone: 'Mars/Olympus' }],
    ])('refuses %s', async (_label, over) => {
      const out = await run(bookMeeting, { domain: 'rentman.io', ...over })
      expect(out.ok).toBe(false)
      expect(await db.select().from(schema.meetings)).toEqual([])
    })

    it('does not move a deal that is already further along', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'proposal' })
      const out = await run(bookMeeting, { domain: 'rentman.io', startsAt: at, timeZone: 'Europe/London' })
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ deal: 'unchanged:proposal' })
    })
  })
})
