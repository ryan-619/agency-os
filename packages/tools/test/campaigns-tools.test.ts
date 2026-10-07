/**
 * The campaign tools, against a real Postgres engine.
 *
 * What is asserted is what a careless handler gets wrong, and what the web
 * route already refuses: a campaign that auto-sends because the model asked,
 * an SMS campaign made by a model, a save built on a stale read undoing the
 * worker's bounce pause, a bouncing campaign switched back on, an enrolment
 * that queues words nobody reads, another org's campaign reachable by its id,
 * an address or a LinkedIn message's words in the model's context, and an
 * audit row carrying somebody's words. Every write lands as the row the
 * route writes, and every write's summary says nothing was sent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Principal } from '@agency/core'
import { SEED_DIR, addSuppression, campaignAutoPause, campaignAutoPauses, readCampaign, smsDraft, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  AGENCY_TOOLS, createCampaign, enrolContacts, listCampaigns, listDrafts, updateCampaign,
  type AgencyToolSpec, type ToolContext, type ToolOutcome,
} from '../src/index.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ICP = JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')) as {
  signals: Record<string, { weight: number; why: string }>
}

/** Midday in London on a Tuesday: outside every default quiet window. */
const NOW = new Date('2026-09-15T12:00:00.000Z')
const FRESH_AT = new Date('2026-09-12T08:00:00.000Z')
const NOTHING_SENT = 'Nothing was sent.'
const ENROL_NOTHING_SENT = 'Nothing was sent — each draft waits for a person on /approvals.'
const BOUNCED = { bouncePct: 12, threshold: 5, sentTo: 25, bounced: 3 }

/** The fixed words an audit detail may carry beside ids, counts and flags. */
const ENUM_WORDS = new Set(['draft', 'active', 'paused', 'done', 'email', 'linkedin', 'sms'])

describe('the campaign tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let ownerId: string
  let memberId: string
  let icpProfileId: string
  let companyId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    orgId = (await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id }))[0]!.id
    otherOrgId = (await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id }))[0]!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'priya@agency.test', name: 'Priya Shah', role: 'owner' },
        { orgId, email: 'sam@agency.test', name: 'Sam Okafor', role: 'member' },
        { orgId: otherOrgId, email: 'outsider@rival.test', name: 'Outsider', role: 'owner' },
      ])
      .returning({ id: schema.users.id, email: schema.users.email })
    ownerId = users.find((u) => u.email === 'priya@agency.test')!.id
    memberId = users.find((u) => u.email === 'sam@agency.test')!.id
    icpProfileId = (
      await db.insert(schema.icpProfiles).values({ orgId, name: 'ICP', definition: ICP, active: true }).returning({ id: schema.icpProfiles.id })
    )[0]!.id
    companyId = await company('rentman.io', 'Rentman')
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: ownerId, orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })
  /** Run a tool the way the adapter will: parse with zod, then hand over. */
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))
  const stranger = (): Partial<ToolContext> => ({
    principal: { id: ownerId, orgId, role: 'guest' as unknown as Principal['role'] },
  })
  const member = (): Partial<ToolContext> => ({ principal: { id: memberId, orgId, role: 'member' } })

  async function company(domain: string, name: string | null, timeZone: string | null = 'Europe/London', org = orgId) {
    const [c] = await db.insert(schema.companies).values({ orgId: org, domain, name, timeZone }).returning({ id: schema.companies.id })
    return c!.id
  }

  async function campaign(over: Partial<typeof schema.campaigns.$inferInsert> = {}, org = orgId) {
    const [c] = await db
      .insert(schema.campaigns)
      .values({ orgId: org, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active', ...over })
      .returning({ id: schema.campaigns.id })
    return c!.id
  }

  async function contact(over: Partial<typeof schema.contacts.$inferInsert> = {}, forCompany = companyId) {
    const [c] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: forCompany, email: 'jo@rentman.io', firstName: 'Jo', timeZone: 'Europe/London', ...over })
      .returning({ id: schema.contacts.id })
    return c!.id
  }

  /** One successful scan of a qualifying company, its findings and the score computed from it. */
  async function scan(forCompany = companyId, ranAt = FRESH_AT) {
    const gaps = ['csp', 'security_txt']
    const [s] = await db
      .insert(schema.scans)
      .values({ orgId, companyId: forCompany, ranAt, ok: true })
      .returning({ id: schema.scans.id })
    await db.insert(schema.findings).values(
      Object.entries(ICP.signals).map(([key, sig]) => {
        const gap = gaps.includes(key)
        return {
          orgId, scanId: s!.id, companyId: forCompany, signalKey: key, observed: true, gap,
          weight: gap ? sig.weight : 0,
          detail: gap ? `${key} missing on https://www.rentman.io/` : null,
          evidence: gap ? { url: 'https://www.rentman.io/', seen: 'absent' } : {},
          stale: false,
        }
      }),
    )
    await db.insert(schema.scores).values({
      orgId, companyId: forCompany, scanId: s!.id, icpProfileId, score: 71, tier: 'A — call first', qualified: true,
    })
    return s!.id
  }

  const campaignRow = async (id: string) => (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]!
  const outbound = () => db.select().from(schema.touches).where(eq(schema.touches.direction, 'out'))
  const auditRows = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))

  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }
  const refusal = (out: ToolOutcome<unknown>): { code: string; message: string } => {
    if (out.ok) throw new Error(`expected a refusal, got: ${out.summary}`)
    return { code: out.code, message: out.message }
  }

  /** Every audit value is an id, a count, a flag, a null or one of a few fixed words — never somebody's words. */
  const safeDetail = (detail: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value === 'string') expect(UUID.test(value) || ENUM_WORDS.has(value), `${key}: ${value}`).toBe(true)
      else expect(value === null || typeof value === 'number' || typeof value === 'boolean', key).toBe(true)
    }
  }

  /**
   * `db`, with one statement held until `meanwhile` has run on the real
   * handle: a teammate's, an owner's or the worker's write landing between
   * the tool's read and its own next statement. By default the first UPDATE
   * of `campaigns` (the save); with `select` and `nth`, that SELECT. The
   * chain the tool builds is recorded and replayed after.
   */
  const racing = (meanwhile: () => Promise<unknown>, method: 'update' | 'select' = 'update', nth = 1): AgencyDb => {
    let seen = 0
    type Chain = Record<PropertyKey, (...args: unknown[]) => unknown>
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== method) return Reflect.get(target, prop, receiver)
        return (...first: unknown[]) => {
          const real = (): Chain => (target[method] as (...a: unknown[]) => unknown).apply(target, first) as Chain
          if (method === 'update' && first[0] !== schema.campaigns) return real()
          if (++seen !== nth) return real()
          const calls: Array<[PropertyKey, unknown[]]> = []
          const chain: unknown = new Proxy(
            {},
            {
              get(_t, step) {
                if (step === 'then') {
                  return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                    meanwhile()
                      .then(() => {
                        let q = real()
                        for (const [m, args] of calls) q = q[m]!(...args) as Chain
                        return q
                      })
                      .then(resolve, reject)
                }
                return (...args: unknown[]) => {
                  calls.push([step, args])
                  return chain
                }
              },
            },
          )
          return chain
        }
      },
    }) as AgencyDb
  }

  // -------------------------------------------------------------------------
  describe('the shapes', () => {
    const mine = [listCampaigns, createCampaign, updateCampaign, enrolContacts, listDrafts] as AgencyToolSpec[]

    it('are registered, described, and take the org from the context', () => {
      for (const spec of mine) {
        expect(AGENCY_TOOLS).toContain(spec)
        expect(spec.description.length, spec.name).toBeGreaterThan(80)
        for (const [key, field] of Object.entries(spec.shape)) {
          expect(['orgId', 'org_id'], spec.name).not.toContain(key)
          expect((field as z.ZodType).description, `${spec.name}.${key}`).toBeTruthy()
        }
      }
    })

    /** The gate refuses a top-level `channel` of sms or voice outright; only create_campaign may have one. */
    it('give only create_campaign a channel, and it takes email or LinkedIn alone', () => {
      for (const spec of mine) {
        if (spec !== createCampaign) expect(Object.keys(spec.shape), spec.name).not.toContain('channel')
      }
      const shape = z.object(createCampaign.shape)
      for (const channel of ['sms', 'voice', 'whatsapp', 'phone']) {
        expect(shape.safeParse({ name: 'x', channel }).success, channel).toBe(false)
      }
      expect(shape.safeParse({ name: 'x', channel: 'linkedin' }).success).toBe(true)
    })

    it('have no input that turns auto-send on, or changes a campaign’s channel', () => {
      for (const spec of [createCampaign, updateCampaign] as AgencyToolSpec[]) {
        expect(Object.keys(spec.shape), spec.name).not.toContain('autoSend')
        expect(Object.keys(spec.shape), spec.name).not.toContain('auto_send')
      }
      expect(Object.keys(updateCampaign.shape)).not.toContain('channel')
    })
  })

  // -------------------------------------------------------------------------
  describe('list_campaigns', () => {
    it('lists this org’s campaigns with their id, mode, cap, quiet hours and what each holds — never another org’s', async () => {
      // Each its own moment: PGlite's clock is millisecond-grained, and two
      // inserts in one millisecond have no "newest" to list first.
      const q4 = await campaign({ name: 'Q4 security gaps', createdAt: new Date(NOW.getTime() - 120_000) })
      const li = await campaign({
        name: 'LinkedIn pilot', channel: 'linkedin', status: 'draft', dailyCap: 10, quietStart: '20:00', quietEnd: '09:00',
        createdAt: new Date(NOW.getTime() - 60_000),
      })
      await campaign({ name: 'RIVAL CAMPAIGN' }, otherOrgId)
      const jo = await contact()
      const base = { orgId, campaignId: q4, contactId: jo, companyId, channel: 'email', direction: 'out' } as const
      await db.insert(schema.touches).values([
        { ...base, status: 'sent', sentAt: NOW, subject: 's', body: 'b' },
        { ...base, status: 'sent', sentAt: NOW, subject: 's', body: 'b' },
        { ...base, status: 'awaiting_approval', subject: 's', body: 'b' },
        { ...base, status: 'approved', approvedBy: ownerId, approvedAt: NOW, subject: 's', body: 'b' },
        { ...base, status: 'refused', refusalCode: 'suppressed', subject: 's', body: 'b' },
      ])

      const out = await run(listCampaigns, {})
      const summary = summaryOf(out)
      expect(summary).toMatch(/^2 campaigns; showing 2, newest first\./)
      expect(summary).toContain(`id ${q4}`)
      expect(summary).toContain(`id ${li}`)
      expect(summary).toContain('“Q4 security gaps”')
      expect(summary).toContain('email · active · supervised — a person approves every message · up to 25 a day · quiet 21:00–08:00')
      expect(summary).toContain('linkedin · draft · supervised — a person approves every message · up to 10 a day · quiet 20:00–09:00')
      expect(summary).toContain(
        'holds: 2 sent in all · 1 waiting for a person on /approvals · 1 approved, waiting to send · 1 not sent — on the suppression list',
      )
      expect(summary).toContain('Nothing was changed and nothing was sent.')
      expect(JSON.stringify(out)).not.toContain('RIVAL')
      expect(JSON.stringify(out)).not.toContain('jo@rentman.io')
      if (!out.ok) return
      const data = out.data as { campaigns: Array<{ campaignId: string; autoSend: boolean; activity: { sent: number } }> }
      expect(data.campaigns.map((c) => c.campaignId)).toEqual([li, q4])
      expect(data.campaigns.find((c) => c.campaignId === q4)!.activity.sent).toBe(2)

      expect(audited).toEqual([{ action: 'agent.list_campaigns', detail: { status: null, matched: 2, returned: 2 } }])
      safeDetail(audited[0]!.detail)
    })

    it('says an auto-send campaign is one, and carries the numbers of a campaign the worker paused for bouncing', async () => {
      await campaign({ name: 'Auto', autoSend: true })
      const bouncing = await campaign({ name: 'Bouncing' })
      expect(await campaignAutoPause(db, { orgId, campaignId: bouncing, detail: BOUNCED })).toBe(true)
      const summary = summaryOf(await run(listCampaigns, {}))
      expect(summary).toContain('auto-send ON — its messages go without a person approving each one')
      expect(summary).toContain(
        'paused automatically: 12% of the addresses it wrote to bounced (3 of 25; the limit is 5%). ' +
          'A person corrects the list, then activates it again on /campaigns; update_campaign will not.',
      )
    })

    it('filters by status and respects the limit', async () => {
      await campaign({ name: 'A', status: 'active' })
      await campaign({ name: 'B', status: 'paused' })
      await campaign({ name: 'C', status: 'paused' })
      const paused = await run(listCampaigns, { status: 'paused' })
      expect(summaryOf(paused)).toMatch(/^2 paused campaigns; showing 2/)
      const one = await run(listCampaigns, { limit: 1 })
      expect(summaryOf(one)).toMatch(/^3 campaigns; showing 1/)
      expect(audited.at(-1)).toEqual({ action: 'agent.list_campaigns', detail: { status: null, matched: 3, returned: 1 } })
    })

    it('says so when there are none, or none with that status', async () => {
      expect(summaryOf(await run(listCampaigns, {}))).toContain('No campaigns are set up.')
      await campaign({ status: 'active' })
      expect(summaryOf(await run(listCampaigns, { status: 'done' }))).toBe(
        'No done campaigns (1 campaign in all). Nothing was changed and nothing was sent.',
      )
    })

    it('refuses a role can() does not know', async () => {
      await campaign()
      expect(await run(listCampaigns, {}, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('create_campaign', () => {
    it('creates a supervised campaign — the row the route writes, with the form’s defaults', async () => {
      const out = await run(createCampaign, { name: '  Q1 openers  ', channel: 'email' }, member())
      const summary = summaryOf(out)
      const rows = await db.select().from(schema.campaigns)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        orgId, name: 'Q1 openers', channel: 'email', autoSend: false, dailyCap: 25, status: 'draft', icpProfileId: null,
      })
      expect(rows[0]!.quietStart.slice(0, 5)).toBe('21:00')
      expect(rows[0]!.quietEnd.slice(0, 5)).toBe('08:00')

      // The route's own row, with the agent as the actor.
      const log = await auditRows('campaign.created')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectType: 'campaign', subjectId: rows[0]!.id })
      expect(log[0]!.detail).toEqual({ name: 'Q1 openers', channel: 'email', autoSend: false, dailyCap: 25 })

      expect(audited).toEqual([
        { action: 'agent.create_campaign', detail: { campaignId: rows[0]!.id, channel: 'email', status: 'draft', autoSend: false } },
      ])
      safeDetail(audited[0]!.detail)
      expect(summary).toContain(`id ${rows[0]!.id}`)
      expect(summary).toContain('supervised — every message in it waits for a person to approve it on /approvals')
      expect(summary).toContain('only an owner can turn it on')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
    })

    it('takes a cap, quiet hours and a status, and says a LinkedIn campaign is sent by a person', async () => {
      const summary = summaryOf(
        await run(createCampaign, { name: 'LinkedIn pilot', channel: 'linkedin', dailyCap: 10, quietStart: '20:30', quietEnd: '07:15', status: 'active' }),
      )
      const row = (await db.select().from(schema.campaigns))[0]!
      expect(row).toMatchObject({ channel: 'linkedin', dailyCap: 10, status: 'active', autoSend: false })
      expect(row.quietStart.slice(0, 5)).toBe('20:30')
      expect(row.quietEnd.slice(0, 5)).toBe('07:15')
      expect(summary).toContain('a step on /tasks')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
    })

    it('never makes auto_send true — an autoSend the model adds is not an input at all', async () => {
      await run(createCampaign, { name: 'Sneaky', channel: 'email', autoSend: true, status: 'active' })
      expect((await db.select().from(schema.campaigns))[0]).toMatchObject({ name: 'Sneaky', autoSend: false })
    })

    it('refuses SMS below the gate: the shape refuses it, and so does the handler, writing nothing', async () => {
      expect(z.object(createCampaign.shape).safeParse({ name: 'Texts', channel: 'sms' }).success).toBe(false)
      // A handler reached without the parse — the guard below the guard.
      const out = await createCampaign.handler({ name: 'Texts', channel: 'sms' } as never, ctx())
      expect(refusal(out).code).toBe('not_permitted')
      expect(refusal(out).message).toContain('email or LinkedIn only')
      expect(await db.select().from(schema.campaigns)).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses what the route refuses, in the route’s words, and writes nothing', async () => {
      const badClock = refusal(await run(createCampaign, { name: 'X', channel: 'email', quietStart: '9pm' }))
      expect(badClock).toEqual({ code: 'invalid_state', message: 'quietStart: Use a 24-hour time, like 21:00. Nothing was written.' })
      expect(refusal(await run(createCampaign, { name: '   ', channel: 'email' })).message).toBe(
        'name: Give the campaign a name. Nothing was written.',
      )
      expect(refusal(await run(createCampaign, { name: 'X', channel: 'email', dailyCap: 0 })).message).toMatch(/^dailyCap: /)
      expect(refusal(await run(createCampaign, { name: 'X', channel: 'email', dailyCap: 201 })).message).toMatch(/^dailyCap: /)
      expect(await db.select().from(schema.campaigns)).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses a name already in use here, but not one another org uses', async () => {
      await campaign({ name: 'Taken' })
      await campaign({ name: 'Theirs' }, otherOrgId)
      expect(refusal(await run(createCampaign, { name: 'Taken', channel: 'email' }))).toEqual({
        code: 'invalid_state',
        message: 'A campaign called "Taken" already exists. Nothing was written.',
      })
      expect(summaryOf(await run(createCampaign, { name: 'Theirs', channel: 'email' }))).toContain('Created the campaign “Theirs”')
      const mineNow = await db.select().from(schema.campaigns).where(eq(schema.campaigns.orgId, orgId))
      expect(mineNow.map((c) => c.name).sort()).toEqual(['Taken', 'Theirs'])
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      expect(await run(createCampaign, { name: 'X', channel: 'email' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await db.select().from(schema.campaigns)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('update_campaign', () => {
    it('renames, re-caps, moves the quiet hours and pauses a campaign — the row the route writes', async () => {
      const id = await campaign({ name: 'Q4', status: 'active' })
      const out = await run(updateCampaign, { campaignId: id, name: 'Q4 openers', dailyCap: 40, quietStart: '22:00', quietEnd: '07:00', status: 'paused' })
      const summary = summaryOf(out)
      const row = await campaignRow(id)
      expect(row).toMatchObject({ name: 'Q4 openers', dailyCap: 40, status: 'paused', channel: 'email', autoSend: false })
      expect(row.quietStart.slice(0, 5)).toBe('22:00')
      expect(row.quietEnd.slice(0, 5)).toBe('07:00')

      const log = await auditRows('campaign.updated')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectType: 'campaign', subjectId: id })
      expect(log[0]!.detail).toEqual({ name: 'Q4 openers', channel: 'email', autoSend: false, dailyCap: 40, status: 'paused' })

      expect(audited).toEqual([
        {
          action: 'agent.update_campaign',
          detail: {
            campaignId: id, statusFrom: 'active', statusTo: 'paused', renamed: true, dailyCapChanged: true, quietHoursChanged: true,
          },
        },
      ])
      safeDetail(audited[0]!.detail)
      expect(summary).toContain('renamed from “Q4”')
      expect(summary).toContain('daily cap 25 → 40')
      expect(summary).toContain('quiet hours 21:00–08:00 → 22:00–07:00')
      expect(summary).toContain('status active → paused')
      expect(summary).toContain('It is paused: nothing in it is sent until it is set active again')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
    })

    it('reactivates a campaign a person paused, and leaves what it was not asked to change', async () => {
      const id = await campaign({ name: 'Held', status: 'paused', dailyCap: 7 })
      const summary = summaryOf(await run(updateCampaign, { campaignId: id, status: 'active', statusRead: 'paused' }, member()))
      expect(await campaignRow(id)).toMatchObject({ status: 'active', dailyCap: 7, name: 'Held' })
      expect(summary).toContain('It is active: messages in it that a person has approved can go')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
    })

    it('answers another org’s campaign exactly like none, and touches nothing', async () => {
      const theirs = await campaign({ name: 'Theirs', status: 'paused' }, otherOrgId)
      const before = await campaignRow(theirs)
      const out = refusal(await run(updateCampaign, { campaignId: theirs, status: 'active' }))
      const none = refusal(await run(updateCampaign, { campaignId: '7d0f4a1e-2b3c-4d5e-8f60-718293a4b5c6', status: 'active' }))
      expect(out).toEqual(none)
      expect(out.code).toBe('not_found')
      expect(await campaignRow(theirs)).toEqual(before)
      expect(await auditRows('campaign.updated')).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      const id = await campaign({ status: 'paused' })
      expect(await run(updateCampaign, { campaignId: id, status: 'active' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await campaignRow(id)).status).toBe('paused')
    })

    it('never changes the channel or auto-send — the model’s extra keys are not inputs', async () => {
      const id = await campaign({ name: 'Q4', channel: 'linkedin', status: 'paused' })
      await run(updateCampaign, { campaignId: id, status: 'active', statusRead: 'paused', channel: 'email', autoSend: true })
      expect(await campaignRow(id)).toMatchObject({ channel: 'linkedin', autoSend: false, status: 'active' })
    })

    /**
     * The status the save was built on is in the UPDATE's own predicate. The
     * worker's bounce pause lands between the tool's read and its save: the
     * save is refused in the route's words, and the pause stands.
     */
    it('refuses a save whose status changed since it was read, in the route’s words — the bounce pause stands', async () => {
      const id = await campaign({ name: 'Q4', status: 'active' })
      const raced = racing(() => campaignAutoPause(db, { orgId, campaignId: id, detail: BOUNCED }))
      const out = refusal(await run(updateCampaign, { campaignId: id, dailyCap: 10 }, { db: raced }))
      expect(out.code).toBe('invalid_state')
      expect(out.message).toBe(
        'This campaign was set to paused while it was being edited (the worker pauses a campaign whose addresses ' +
          'bounce, and /campaigns says when it did). Nothing was saved: read it again with list_campaigns to see it ' +
          'as it is now, then save again if it should change.',
      )
      expect(await campaignRow(id)).toMatchObject({ status: 'paused', dailyCap: 25 })
      expect((await campaignAutoPauses(db, orgId)).has(id)).toBe(true)
      expect(await auditRows('campaign.updated')).toEqual([])
      expect(audited).toEqual([])
    })

    /**
     * The card waits for a person, and a teammate can pause the campaign in
     * that time. Built on the handler's own read, the approved card set it
     * active again and the next tick sent the messages the teammate held
     * (review round 16). It is built on the status the model read now.
     */
    it('will not set active a campaign a teammate paused after the model read it', async () => {
      const id = await campaign({ name: 'Q4', status: 'active', dailyCap: 25 })
      // The model read "active"; Sam pauses it on /campaigns while the card waits.
      await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, id))
      for (const change of [{ status: 'active' as const }, { status: 'active' as const, dailyCap: 40 }]) {
        const out = refusal(await run(updateCampaign, { campaignId: id, statusRead: 'active', ...change }))
        expect(out.code).toBe('invalid_state')
        expect(out.message).toMatch(/^This campaign was set to paused while it was being edited/)
      }
      expect(await campaignRow(id)).toMatchObject({ status: 'paused', dailyCap: 25 })
      expect(await auditRows('campaign.updated')).toEqual([])
    })

    it('asks for the status it read before setting a campaign active, and writes nothing without it', async () => {
      const id = await campaign({ name: 'Q4', status: 'paused' })
      const out = refusal(await run(updateCampaign, { campaignId: id, status: 'active' }))
      expect(out.code).toBe('invalid_state')
      expect(out.message).toMatch(/^Give statusRead/)
      expect((await campaignRow(id)).status).toBe('paused')
      // Pausing needs none: it only stops messages.
      const live = await campaign({ name: 'Live', status: 'active' })
      summaryOf(await run(updateCampaign, { campaignId: live, status: 'paused' }))
      expect((await campaignRow(live)).status).toBe('paused')
    })

    it('refuses a save whose auto-send changed since it was read, rather than turning it back off', async () => {
      const id = await campaign({ name: 'Q4', status: 'paused' })
      const raced = racing(() => db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, id)))
      const out = refusal(await run(updateCampaign, { campaignId: id, status: 'active', statusRead: 'paused' }, { db: raced }))
      expect(out).toEqual({
        code: 'invalid_state',
        message:
          'Someone changed this campaign’s auto-send while it was being edited. Read it again with list_campaigns ' +
          'and try again; nothing was saved.',
      })
      expect(await campaignRow(id)).toMatchObject({ autoSend: true, status: 'paused' })
    })

    describe('an auto-send campaign', () => {
      it('may only be paused here — pausing only stops messages', async () => {
        const id = await campaign({ name: 'Auto', autoSend: true, status: 'active' })
        const summary = summaryOf(await run(updateCampaign, { campaignId: id, status: 'paused' }))
        expect(await campaignRow(id)).toMatchObject({ status: 'paused', autoSend: true })
        expect(summary).toContain('until a person sets it active again on /campaigns')
        expect(summary.endsWith(NOTHING_SENT)).toBe(true)
        expect((await auditRows('campaign.updated'))[0]!.detail).toMatchObject({ autoSend: true, status: 'paused' })
      })

      it.each([
        ['a rename', { name: 'Renamed' }],
        ['a new cap', { dailyCap: 100 }],
        ['new quiet hours', { quietStart: '23:00' }],
        ['reactivation', { status: 'active', statusRead: 'paused' }],
        ['finishing it', { status: 'done' }],
        ['a pause with a rename beside it', { status: 'paused', name: 'Renamed' }],
      ])('refuses %s, and writes nothing', async (_what, change) => {
        const id = await campaign({ name: 'Auto', autoSend: true, status: 'paused' })
        const before = await campaignRow(id)
        const out = refusal(await run(updateCampaign, { campaignId: id, ...change }))
        expect(out.code).toBe('not_permitted')
        expect(out.message).toContain('an auto-send campaign is changed by a person on /campaigns')
        expect(await campaignRow(id)).toEqual(before)
        expect(await auditRows('campaign.updated')).toEqual([])
        expect(audited).toEqual([])
      })
    })

    describe('a campaign the worker paused because it bounced', () => {
      it('is not set active here — a person reactivates it after correcting the list', async () => {
        const id = await campaign({ name: 'Bouncing', status: 'active' })
        expect(await campaignAutoPause(db, { orgId, campaignId: id, detail: BOUNCED })).toBe(true)
        const out = refusal(await run(updateCampaign, { campaignId: id, status: 'active', statusRead: 'paused' }))
        expect(out.code).toBe('not_permitted')
        expect(out.message).toContain(
          'the worker paused it because too many messages bounced (12% of the addresses it wrote to, 3 of 25)',
        )
        expect(out.message).toContain('a person reactivates it on /campaigns after correcting the list')
        expect((await campaignRow(id)).status).toBe('paused')
        expect(audited).toEqual([])
      })

      it('is not set active by a detour through done, either', async () => {
        const id = await campaign({ name: 'Bouncing', status: 'active' })
        await campaignAutoPause(db, { orgId, campaignId: id, detail: BOUNCED })
        summaryOf(await run(updateCampaign, { campaignId: id, status: 'done' }))
        expect(refusal(await run(updateCampaign, { campaignId: id, status: 'active', statusRead: 'done' })).code).toBe('not_permitted')
        expect((await campaignRow(id)).status).toBe('done')
      })

      it('can still be re-capped while it stays paused, and is free again once a person reactivates it', async () => {
        const id = await campaign({ name: 'Bouncing', status: 'active' })
        await campaignAutoPause(db, { orgId, campaignId: id, detail: BOUNCED })
        summaryOf(await run(updateCampaign, { campaignId: id, dailyCap: 5 }))
        expect(await campaignRow(id)).toMatchObject({ status: 'paused', dailyCap: 5 })

        // A person sets it active on /campaigns (the route's own row), then pauses it again by hand.
        await db.update(schema.campaigns).set({ status: 'active' }).where(eq(schema.campaigns.id, id))
        await db.insert(schema.auditLog).values({
          orgId, actor: ownerId, action: 'campaign.updated', subjectType: 'campaign', subjectId: id,
          detail: { name: 'Bouncing', channel: 'email', autoSend: false, dailyCap: 5, status: 'active' },
        })
        await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, id))
        summaryOf(await run(updateCampaign, { campaignId: id, status: 'active', statusRead: 'paused' }))
        expect((await campaignRow(id)).status).toBe('active')
      })
    })

    it('refuses what the route refuses, in the route’s words, and saves nothing', async () => {
      const id = await campaign({ name: 'Q4' })
      await campaign({ name: 'Taken' })
      expect(refusal(await run(updateCampaign, { campaignId: id, quietEnd: '25:00' }))).toEqual({
        code: 'invalid_state',
        message: 'quietEnd: Use a 24-hour time, like 21:00. Nothing was saved.',
      })
      expect(refusal(await run(updateCampaign, { campaignId: id, dailyCap: 0 })).message).toMatch(/^dailyCap: /)
      expect(refusal(await run(updateCampaign, { campaignId: id, name: 'Taken' }))).toEqual({
        code: 'invalid_state',
        message: 'A campaign called "Taken" already exists. Nothing was saved.',
      })
      expect(await campaignRow(id)).toMatchObject({ name: 'Q4', dailyCap: 25 })
      expect(refusal(await run(updateCampaign, { campaignId: id })).message).toMatch(/^Say what to change/)
    })

    it('says so when nothing would change, and writes nothing', async () => {
      const id = await campaign({ name: 'Q4', status: 'paused' })
      const summary = summaryOf(await run(updateCampaign, { campaignId: id, status: 'paused', name: 'Q4', quietStart: '21:00' }))
      expect(summary).toContain('nothing changed')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
      expect(await auditRows('campaign.updated')).toEqual([])
      expect(audited.map((a) => a.action)).toEqual(['agent.update_campaign'])
    })
  })

  // -------------------------------------------------------------------------
  describe('enrol_contacts', () => {
    /**
     * The worker's model polishes the opener when one is configured
     * (`ctx.refineOpener`), inside the tool's time budget: it is handed a
     * signal that is still live, and its words are what is stored.
     */
    it('stores the opener the worker’s model polished, handing it a live signal', async () => {
      const id = await campaign({ name: 'Q4 security gaps' })
      await scan()
      await contact()
      const signals: AbortSignal[] = []
      const refineOpener = async (d: { subject: string; body: string; quoted: readonly string[] }, signal: AbortSignal) => {
        signals.push(signal)
        return { ...d, body: `${d.body}\n\nPolished by the model.` }
      }
      await run(enrolContacts, { campaignId: id }, { refineOpener })
      const rows = await outbound()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.body).toMatch(/Polished by the model\.$/)
      expect(signals).toHaveLength(1)
      expect(signals[0]!.aborted).toBe(false)
    })

    it('writes awaiting_approval drafts into a supervised campaign — the rows the Enrol button writes', async () => {
      const id = await campaign({ name: 'Q4 security gaps' })
      await scan()
      const jo = await contact()
      const sam = await contact({ email: 'sam@rentman.io', firstName: 'Sam', timeZone: null }) // the company's zone covers them
      await contact({ email: 'held@rentman.io', pausedAt: NOW, pausedReason: 'replied 2026-09-14T10:00:00.000Z' })

      const out = await run(enrolContacts, { campaignId: id })
      const summary = summaryOf(out)
      const rows = await outbound()
      expect(rows).toHaveLength(2)
      expect(rows.map((t) => t.contactId).sort()).toEqual([jo, sam].sort())
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'awaiting_approval', campaignId: id, companyId, channel: 'email', approvedBy: null, recipient: null,
        })
        // Signed by the person you are helping, as the Enrol button signs with whoever pressed it.
        expect(row.body).toContain('Priya Shah')
        expect(row.body).toContain('Northwind Security')
      }

      // The route's own row, written by `enrolCampaign`, names the agent — counts only.
      const log = await auditRows('campaign.enrolled')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectType: 'campaign', subjectId: id })
      expect(log[0]!.detail).toEqual({
        campaignId: id, queued: 2, skipped: { paused: 1 }, status: 'awaiting_approval', limit: 50, truncated: false,
      })

      expect(audited).toEqual([
        { action: 'agent.enrol_contacts', detail: { campaignId: id, dryRun: false, queued: 2, skipped: 1, truncated: false, outOfTime: false, limit: 50 } },
      ])
      safeDetail(audited[0]!.detail)
      expect(summary).toContain('wrote 2 drafts, each awaiting approval')
      expect(summary).toContain('1 skipped:')
      expect(summary).toContain('1 people paused after replying')
      expect(summary).not.toMatch(/jo@|sam@|held@/)
      expect(summary.endsWith(ENROL_NOTHING_SENT)).toBe(true)
      if (!out.ok) return
      expect(out.data).toMatchObject({ dryRun: false, status: 'awaiting_approval', queued: 2, skippedTotal: 1 })
    })

    it('a dry run says who would get a draft, and writes nothing', async () => {
      const id = await campaign()
      await scan()
      await contact()
      const summary = summaryOf(await run(enrolContacts, { campaignId: id, dryRun: true }))
      expect(await outbound()).toEqual([])
      expect(await auditRows('campaign.enrolled')).toEqual([])
      expect(summary).toMatch(/^Dry run of enrolling “Q4 security gaps” \(email\): 1 person would get a draft\./)
      expect(summary).toContain('nothing was written')
      expect(summary.endsWith(ENROL_NOTHING_SENT)).toBe(true)
      expect(audited).toEqual([
        { action: 'agent.enrol_contacts', detail: { campaignId: id, dryRun: true, queued: 1, skipped: 0, truncated: false, outOfTime: false, limit: 50 } },
      ])
    })

    it('says each skip in the panel’s words', async () => {
      const id = await campaign({ status: 'draft' })
      await scan()
      const stale = await company('stale.io', 'Stale')
      await contact({ email: 'x@stale.io' }, stale)
      await contact()
      const declined = await contact({ email: 'no@rentman.io' })
      await db.insert(schema.consents).values({ orgId, contactId: declined, channel: 'email', granted: false, source: 'said no on a call' })
      const summary = summaryOf(await run(enrolContacts, { campaignId: id }))
      expect(await outbound()).toHaveLength(1)
      expect(summary).toContain('2 skipped:')
      expect(summary).toContain('1 companies with no fresh scan — re-scan them first')
      expect(summary).toContain('1 people who declined this channel')
      expect(summary).toContain('The campaign is draft, so nothing in it is sent until it is active.')
      expect(summary.endsWith(ENROL_NOTHING_SENT)).toBe(true)
    })

    it('stops at the limit, highest-scoring companies first, and says enrolling again continues', async () => {
      const id = await campaign()
      await scan()
      await contact()
      await contact({ email: 'two@rentman.io' })
      const out = await run(enrolContacts, { campaignId: id, limit: 1 })
      const summary = summaryOf(out)
      expect(await outbound()).toHaveLength(1)
      expect(summary).toContain('It stopped at the limit of 1')
      expect(summary.endsWith(ENROL_NOTHING_SENT)).toBe(true)
      expect(audited).toEqual([
        { action: 'agent.enrol_contacts', detail: { campaignId: id, dryRun: false, queued: 1, skipped: 0, truncated: true, outOfTime: false, limit: 1 } },
      ])
    })

    it('a second enrolment skips the people already waiting, in this campaign, and says it wrote none', async () => {
      const id = await campaign()
      await scan()
      await contact()
      await run(enrolContacts, { campaignId: id })
      const summary = summaryOf(await run(enrolContacts, { campaignId: id }))
      expect(await outbound()).toHaveLength(1)
      expect(summary).toContain('wrote no drafts')
      expect(summary).toContain('1 people with a draft already waiting — in this campaign')
      expect(summary.endsWith(ENROL_NOTHING_SENT)).toBe(true)
    })

    /**
     * `enrolCampaign` reads the campaign again. An owner who turns auto-send
     * on between the tool's read and that one gets rows queued for the
     * worker — their choice — and the summary must not claim they wait for a
     * person.
     */
    it('says so plainly when auto-send was switched on while it enrolled', async () => {
      const id = await campaign()
      await scan()
      await contact()
      // The tool's second SELECT is the signer's name: the owner's switch lands before it.
      const raced = racing(() => db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, id)), 'select', 2)
      const summary = summaryOf(await run(enrolContacts, { campaignId: id }, { db: raced }))
      expect((await outbound()).map((t) => t.status)).toEqual(['queued'])
      expect(summary).toContain('Auto-send was switched on for this campaign while it was being enrolled')
      expect(summary).not.toContain('waits for a person on /approvals')
      expect(summary).toMatch(/Nothing was sent yet\./)
    })

    it('says a LinkedIn draft becomes a /tasks step a person sends', async () => {
      const id = await campaign({ name: 'LinkedIn pilot', channel: 'linkedin' })
      await scan()
      await contact({ email: null, linkedinUrl: 'https://www.linkedin.com/in/jo-rentman' })
      const summary = summaryOf(await run(enrolContacts, { campaignId: id }))
      expect((await outbound())[0]).toMatchObject({ channel: 'linkedin', status: 'awaiting_approval' })
      expect(summary).toContain('a step on /tasks')
      expect(summary.endsWith(ENROL_NOTHING_SENT)).toBe(true)
    })

    it('refuses an auto-send campaign before anything is planned or written, dry run included', async () => {
      const auto = await campaign({ name: 'Auto', autoSend: true })
      await scan()
      await contact()
      for (const dryRun of [false, true]) {
        const out = refusal(await run(enrolContacts, { campaignId: auto, dryRun }))
        expect(out.code).toBe('not_permitted')
        expect(out.message).toContain(
          'enrolling into an auto-send campaign would send without anybody reading the words; a person enrols on /campaigns',
        )
      }
      expect(await outbound()).toEqual([])
      expect(await auditRows('campaign.enrolled')).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses an SMS campaign in enrolment’s own sentence', async () => {
      const sms = await campaign({ name: 'Reminders', channel: 'sms' })
      await scan()
      await contact({ phone: '+447700900123' })
      const out = refusal(await run(enrolContacts, { campaignId: sms }))
      expect(out.code).toBe('invalid_state')
      expect(out.message).toBe(
        'Reminders is on sms, which is not a cold channel. Enrolment writes email and LinkedIn drafts only. ' +
          'SMS is drafted per person with Draft SMS on /contacts. Nothing was written.',
      )
      expect(await outbound()).toEqual([])
    })

    it('refuses a finished campaign in enrolment’s own sentence', async () => {
      const done = await campaign({ name: 'Old', status: 'done' })
      const out = refusal(await run(enrolContacts, { campaignId: done }))
      expect(out).toEqual({
        code: 'invalid_state',
        message: 'Old is marked done, so nothing is enrolled into it. Set it back to draft or active first. Nothing was written.',
      })
    })

    it('answers another org’s campaign exactly like none, and writes nothing', async () => {
      const theirs = await campaign({ name: 'Theirs' }, otherOrgId)
      await scan()
      await contact()
      const out = refusal(await run(enrolContacts, { campaignId: theirs }))
      expect(out).toEqual(refusal(await run(enrolContacts, { campaignId: '7d0f4a1e-2b3c-4d5e-8f60-718293a4b5c6' })))
      expect(out.code).toBe('not_found')
      expect(await outbound()).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      const id = await campaign()
      await scan()
      await contact()
      expect(await run(enrolContacts, { campaignId: id }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await outbound()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('list_drafts', () => {
    const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

    async function draft(over: Partial<typeof schema.touches.$inferInsert>) {
      const [t] = await db
        .insert(schema.touches)
        .values({ orgId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval', ...over })
        .returning({ id: schema.touches.id })
      return t!.id
    }

    it('lists what waits, newest first, with the send rules’ answer — an address only by its domain', async () => {
      await scan()
      const q4 = await campaign({ name: 'Q4 security gaps' })
      const jo = await contact()
      const enrolled = await draft({
        contactId: jo, campaignId: q4, subject: 'Rentman’s public security headers',
        body: '\n\nHi Jo,\nWe looked at what rentman.io serves to the public.', createdAt: at(30),
      })
      const fromChat = await draft({ subject: 'About your CSP', body: 'Hello there', createdAt: at(10) })

      const out = await run(listDrafts, {})
      const summary = summaryOf(out)
      expect(summary).toMatch(/^2 drafts wait on \/approvals; showing 2, newest first \(UTC\)\./)
      expect(summary.indexOf(`id ${fromChat}`)).toBeLessThan(summary.indexOf(`id ${enrolled}`))
      expect(summary).toContain('campaign “Q4 security gaps” · rentman.io · to …@rentman.io')
      expect(summary).toContain('subject “Rentman’s public security headers” — first line: “Hi Jo,”')
      expect(summary).toContain('send rules now: would go now, once a person approves it')
      expect(summary).toContain('no campaign yet · rentman.io · no recipient chosen yet')
      expect(summary).toContain('not checked: no recipient chosen yet')
      expect(summary).toContain('Nothing was changed and nothing was sent.')
      expect(summary).not.toContain('jo@rentman.io')
      expect(JSON.stringify(out)).not.toContain('jo@rentman.io')
      if (!out.ok) return
      const data = out.data as { drafts: Array<{ touchId: string; rules: { code: string } }> }
      expect(data.drafts.map((d) => [d.touchId, d.rules.code])).toEqual([
        [fromChat, 'no_recipient'],
        [enrolled, 'send_now'],
      ])
      expect(audited).toEqual([{ action: 'agent.list_drafts', detail: { total: 2, returned: 2, checked: 1 } }])
      safeDetail(audited[0]!.detail)
    })

    it('says a refusal nobody may approve past as blocked, and the clock’s as a wait', async () => {
      await scan()
      const live = await campaign({ name: 'Live' })
      const held = await campaign({ name: 'Held', status: 'paused' })
      const stop = await contact({ email: 'stop@rentman.io' })
      const jo = await contact()
      await addSuppression(db, { orgId, kind: 'email', value: 'stop@rentman.io', reason: 'asked to stop', source: 'reply' })
      await draft({ contactId: stop, campaignId: live, subject: 's', body: 'b', createdAt: at(20) })
      await draft({ contactId: jo, campaignId: held, subject: 's', body: 'b', createdAt: at(10) })

      const summary = summaryOf(await run(listDrafts, {}))
      expect(summary).toContain(
        'send rules now: blocked (on the suppression list): This recipient is on the suppression list. Nothing was sent, ' +
          'and no one can approve sending to them — a suppression is somebody asking to be left alone. Nobody may approve past this.',
      )
      expect(summary).toContain(
        'send rules now: would wait (campaign paused or not active): This campaign is paused, so nothing in it is sent. ' +
          'It will resume when the campaign is set active again.',
      )
      expect(summary).not.toContain('stop@rentman.io')
    })

    /** /tasks' own rule: a LinkedIn message's words are shown nowhere before Start hands them over. */
    it('withholds a LinkedIn draft’s words exactly as /tasks does', async () => {
      await scan()
      const li = await campaign({ name: 'LinkedIn pilot', channel: 'linkedin' })
      const jo = await contact({ email: null, linkedinUrl: 'https://www.linkedin.com/in/jo-rentman' })
      const id = await draft({ channel: 'linkedin', contactId: jo, campaignId: li, subject: 'SECRET SUBJECT', body: 'SECRET LINKEDIN WORDS' })
      const out = await run(listDrafts, {})
      const summary = summaryOf(out)
      expect(summary).toContain(`id ${id}`)
      expect(summary).toContain('to a contact’s LinkedIn profile')
      expect(summary).toContain('words withheld (Start has not handed them over)')
      expect(summary).toContain('A LinkedIn message’s words are shown only where /tasks would show them')
      expect(JSON.stringify(out)).not.toMatch(/SECRET|jo-rentman/)
    })

    it('names an SMS by its registered template, never its words or the number', async () => {
      const kolkata = await company('rentman.in', 'Rentman India', 'Asia/Kolkata')
      const ravi = await contact({ email: null, firstName: 'Ravi', phone: '+919876543210', timeZone: 'Asia/Kolkata' }, kolkata)
      await db.insert(schema.consents).values({ orgId, contactId: ravi, channel: 'sms', granted: true, source: 'booking form' })
      const reminders = await campaign({ name: 'Reminders', channel: 'sms' })
      const [template] = await db
        .insert(schema.messageTemplates)
        .values({
          orgId, channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit',
          body: 'Hi {#var#}, your call with Acme is at {#var#}. Reply STOP to opt out.',
        })
        .returning({ id: schema.messageTemplates.id })
      const drafted = await smsDraft(db, {
        orgId, contactId: ravi, campaignId: reminders, templateId: template!.id, vars: ['Ravi', '3pm'], createdBy: ownerId, now: NOW,
      })
      if (!drafted.ok) throw new Error(drafted.message)

      const out = await run(listDrafts, {})
      const summary = summaryOf(out)
      expect(summary).toContain(`id ${drafted.touchId}`)
      expect(summary).toContain('from DLT template 1107160000000012345')
      expect(summary).toContain('to a contact’s phone number')
      expect(JSON.stringify(out)).not.toMatch(/your call with Acme|9876543210/)
    })

    it('respects the limit, and never lists another org’s drafts', async () => {
      const [theirs] = await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'rival.io' }).returning({ id: schema.companies.id })
      await db.insert(schema.touches).values({
        orgId: otherOrgId, companyId: theirs!.id, channel: 'email', direction: 'out', status: 'awaiting_approval',
        subject: 'RIVAL DRAFT', body: 'theirs',
      })
      const older = await draft({ subject: 'Older', body: 'one', createdAt: at(30) })
      const newer = await draft({ subject: 'Newer', body: 'two', createdAt: at(5) })
      const out = await run(listDrafts, { limit: 1 })
      const summary = summaryOf(out)
      expect(summary).toMatch(/^2 drafts wait on \/approvals; showing 1/)
      expect(summary).toContain(`id ${newer}`)
      expect(summary).not.toContain(older)
      expect(JSON.stringify(out)).not.toContain('RIVAL')
    })

    it('changes nothing, and says so when nothing waits', async () => {
      expect(summaryOf(await run(listDrafts, {}))).toBe('No drafts are waiting on /approvals. Nothing was changed and nothing was sent.')
      await draft({ subject: 's', body: 'b' })
      const before = await db.select().from(schema.touches)
      await run(listDrafts, {})
      expect(await db.select().from(schema.touches)).toEqual(before)
    })

    it('refuses a role can() does not know', async () => {
      await draft({ subject: 's', body: 'b' })
      expect(await run(listDrafts, {}, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  /**
   * The model sees a tool's SUMMARY and never its `data` (the adapter in
   * apps/agent/src/mcp/agency.ts returns the summary alone), so every id a
   * later call needs is printed there. Proved by doing what the model does:
   * reading the id out of the summary and calling the next tool with it.
   */
  it('prints every id a later call needs in the summary, the only thing the model sees', async () => {
    await scan()
    await contact()
    const idIn = (summary: string, label: string): string => {
      const m = summary.match(new RegExp(`${label}[^\\n]*?id (${UUID.source.slice(1, -1)})`, 'i'))
      if (!m) throw new Error(`no id for ${label} in: ${summary}`)
      return m[1]!
    }

    const created = summaryOf(await run(createCampaign, { name: 'Printed', channel: 'email' }))
    const fromCreate = idIn(created, 'Created the campaign “Printed”')
    const row = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.name, 'Printed')))[0]!
    expect(fromCreate).toBe(row.id)

    const other = await campaign({ name: 'Second' })
    const listed = summaryOf(await run(listCampaigns, {}))
    expect(idIn(listed, '“Printed”')).toBe(row.id)
    expect(idIn(listed, '“Second”')).toBe(other)

    // The ids as printed are the ids the next tools take.
    const updated = summaryOf(await run(updateCampaign, { campaignId: idIn(listed, '“Printed”'), status: 'active', statusRead: 'draft' }))
    expect(idIn(updated, 'Updated the campaign “Printed”')).toBe(row.id)
    expect((await campaignRow(row.id)).status).toBe('active')
    summaryOf(await run(enrolContacts, { campaignId: idIn(listed, '“Printed”') }))
    const drafts = await outbound()
    expect(drafts).toHaveLength(1)

    const waiting = summaryOf(await run(listDrafts, {}))
    expect(waiting).toContain(`id ${drafts[0]!.id}`)
  })

  it('ends every write’s summary with the nothing-sent sentence', async () => {
    await scan()
    await contact()
    const created = summaryOf(await run(createCampaign, { name: 'Fresh', channel: 'email', status: 'active' }))
    expect(created.endsWith(NOTHING_SENT)).toBe(true)
    const id = (await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.orgId, orgId), eq(schema.campaigns.name, 'Fresh'))))[0]!.id
    expect(summaryOf(await run(updateCampaign, { campaignId: id, dailyCap: 30 })).endsWith(NOTHING_SENT)).toBe(true)
    expect(summaryOf(await run(enrolContacts, { campaignId: id })).endsWith(ENROL_NOTHING_SENT)).toBe(true)
    expect(summaryOf(await run(enrolContacts, { campaignId: id, dryRun: true })).endsWith(ENROL_NOTHING_SENT)).toBe(true)
    expect((await readCampaign(db, orgId, id))!.autoSend).toBe(false)
  })
})
