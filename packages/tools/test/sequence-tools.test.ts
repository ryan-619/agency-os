/**
 * set_campaign_steps and list_campaigns' follow-ups line (0024), through the
 * context the agent calls them with. Setting steps sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { campaignStepsRead, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import { listCampaigns, setCampaignSteps, type AgencyToolSpec, type ToolContext, type ToolOutcome } from '../src/index.js'

describe('the follow-up tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let campaignId: string
  let smsId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    campaignId = (await db.insert(schema.campaigns).values({ orgId, name: 'Clinics', channel: 'email', status: 'active' }).returning({ id: schema.campaigns.id }))[0]!.id
    smsId = (await db.insert(schema.campaigns).values({ orgId, name: 'Texts', channel: 'sms', status: 'active' }).returning({ id: schema.campaigns.id }))[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db, orgId, principal: { id: ownerId, orgId, role: 'owner' }, turnId: '00000000-0000-4000-8000-000000000001',
    now: () => new Date('2026-10-08T09:00:00Z'), audit: async () => {},
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) => spec.handler(z.object(spec.shape).parse(input) as never, ctx())
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }

  it('sets the steps, says nothing was sent, and list_campaigns shows them', async () => {
    const summary = summaryOf(await run(setCampaignSteps, {
      campaignId,
      steps: [{ kind: 'message', afterDays: 3, body: 'Hi {first_name}, any thoughts? {agency}' }, { kind: 'call', afterDays: 2 }],
    }))
    expect(summary).toMatch(/^Set 2 follow-up steps:/)
    expect(summary).toContain('Nothing was sent now.')
    expect(await campaignStepsRead(db, orgId, campaignId)).toHaveLength(2)
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'campaign.steps_saved'))
    expect(audit).toMatchObject({ actor: 'agent' })
    expect(summaryOf(await run(listCampaigns, {}))).toContain('follow-ups: message after 3 days, call after 2 days · 0 being followed up')
    expect(await db.select().from(schema.touches)).toEqual([])
  })

  it('refuses a message step on a text campaign, a placeholder nothing fills, and removes steps with an empty list', async () => {
    expect(await run(setCampaignSteps, { campaignId: smsId, steps: [{ kind: 'message', afterDays: 2, body: 'Hi' }] }))
      .toMatchObject({ ok: false, code: 'invalid_state' })
    expect(await run(setCampaignSteps, { campaignId, steps: [{ kind: 'message', afterDays: 2, body: 'Hi {name}' }] }))
      .toMatchObject({ ok: false, code: 'invalid_state' })
    await run(setCampaignSteps, { campaignId, steps: [{ kind: 'visit', afterDays: 5 }] })
    expect(summaryOf(await run(setCampaignSteps, { campaignId, steps: [] }))).toMatch(/^Removed the campaign’s follow-up steps/)
    expect(await campaignStepsRead(db, orgId, campaignId)).toEqual([])
  })
})
