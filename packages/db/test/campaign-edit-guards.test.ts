/**
 * What a campaign edit may not undo (review round 3, findings 2 and 13).
 *
 * Two saves that read as harmless and were not:
 *
 *  - a channel switch while the campaign holds messages waiting to go. The
 *    sender now checks each message on its own channel and refuses one
 *    whose campaign has moved (touch-channel.test.ts) — but the edit that
 *    strands them is refused first, here, naming how many are waiting;
 *  - a save built on the status the form LOADED. The worker pauses a
 *    campaign whose addresses bounce; a teammate who opened the form before
 *    that and changed only the cap wrote `active` back, re-activating a
 *    campaign known to be bouncing — and the `campaign.updated` row it left
 *    told `campaignAutoPauses` a person had lifted the pause on purpose.
 *    The status the form loaded is now an expected value in the UPDATE's
 *    own predicate, like `expectAutoSend`, and a mismatch is a 409 sentence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  campaignAutoPause, campaignAutoPauses, campaignEditInput, createCampaign, readCampaign, schema, updateCampaign,
  type AgencyDb, type CampaignInput, type CampaignStatus,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('campaign edit guards', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id }))[0]!.id
    otherOrgId = (await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'rentman.io' }).returning({ id: schema.companies.id }))[0]!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const base: CampaignInput = {
    name: 'Q4 LinkedIn', channel: 'linkedin', icpProfileId: null, dailyCap: 25,
    quietStart: '21:00', quietEnd: '08:00', autoSend: false, status: 'active',
  }
  const campaign = (over: Partial<CampaignInput> = {}) => createCampaign(db, orgId, { ...base, ...over })
  const touch = (campaignId: string, status: string, channel = 'linkedin') =>
    db.insert(schema.touches).values({
      orgId, campaignId, companyId, channel, direction: 'out', status,
      refusalCode: status === 'refused' ? 'suppressed' : null,
      sentAt: status === 'sent' ? new Date() : null,
      // 0011: a row may not say "approved" without naming who and when.
      ...(status === 'approved' ? { approvedBy: userId, approvedAt: new Date() } : {}),
    })

  describe('a channel switch while messages wait', () => {
    it.each(['queued', 'awaiting_approval', 'approved', 'sending'])(
      'is refused while a %s message waits, and the campaign keeps its channel',
      async (status) => {
        const c = await campaign()
        await touch(c.id, status)
        await touch(c.id, status)
        const r = await updateCampaign(db, orgId, c.id, { ...base, channel: 'email' })
        expect(r).toEqual({ ok: false, reason: 'channel_has_live_messages', live: 2, channel: 'linkedin' })
        expect((await readCampaign(db, orgId, c.id))!.channel).toBe('linkedin')
      },
    )

    it('is allowed once nothing waits — sent and refused messages are history, not cargo', async () => {
      const c = await campaign()
      await touch(c.id, 'sent')
      await touch(c.id, 'refused')
      const r = await updateCampaign(db, orgId, c.id, { ...base, channel: 'email' })
      expect(r).toMatchObject({ ok: true, row: { channel: 'email' } })
    })

    it('does not stop any other edit while messages wait', async () => {
      const c = await campaign()
      await touch(c.id, 'approved')
      const r = await updateCampaign(db, orgId, c.id, { ...base, dailyCap: 5, name: 'Renamed' })
      expect(r).toMatchObject({ ok: true, row: { channel: 'linkedin', dailyCap: 5, name: 'Renamed' } })
    })

    it('counts only this campaign’s messages', async () => {
      const c = await campaign()
      const other = await campaign({ name: 'Other' })
      await touch(other.id, 'approved')
      expect(await updateCampaign(db, orgId, c.id, { ...base, channel: 'email' })).toMatchObject({ ok: true })
    })
  })

  describe('the status the form loaded', () => {
    it('a save built on a stale read does not re-activate a campaign the worker paused for bouncing', async () => {
      const c = await campaign({ channel: 'email' })
      // 1. The form is opened while the campaign is active.
      const loaded = (await readCampaign(db, orgId, c.id))!.status as CampaignStatus
      expect(loaded).toBe('active')
      // 2. The sender's tick pauses it.
      expect(await campaignAutoPause(db, {
        orgId, campaignId: c.id, detail: { bouncePct: 6, threshold: 5, sentTo: 40, bounced: 3 },
      })).toBe(true)
      // 3. The teammate changes the cap and saves, the form still saying active.
      const r = await updateCampaign(db, orgId, c.id, { ...base, channel: 'email', dailyCap: 10, status: 'active' }, { status: loaded })
      expect(r).toEqual({ ok: false, reason: 'status_changed', status: 'paused' })
      const after = (await readCampaign(db, orgId, c.id))!
      expect(after.status).toBe('paused')
      expect(after.dailyCap).toBe(25)
      // The automatic pause still stands, so the page still says why.
      expect((await campaignAutoPauses(db, orgId)).has(c.id)).toBe(true)
    })

    it('a save whose loaded status still holds goes through — a deliberate re-activation included', async () => {
      const c = await campaign({ channel: 'email', status: 'paused' })
      const r = await updateCampaign(db, orgId, c.id, { ...base, channel: 'email', status: 'active' }, { status: 'paused' })
      expect(r).toMatchObject({ ok: true, row: { status: 'active' } })
    })

    it('with no expected status, writes as before', async () => {
      const c = await campaign({ status: 'paused' })
      expect(await updateCampaign(db, orgId, c.id, { ...base, status: 'active' })).toMatchObject({ ok: true, row: { status: 'active' } })
    })

    it('the edit form’s input carries the loaded status, and the create form’s does not need one', () => {
      const parsed = campaignEditInput.safeParse({ ...base, expectStatus: 'active' })
      expect(parsed.success && parsed.data.expectStatus).toBe('active')
      const without = campaignEditInput.safeParse(base)
      expect(without.success && without.data.expectStatus).toBeUndefined()
      expect(campaignEditInput.safeParse({ ...base, expectStatus: 'running' }).success).toBe(false)
    })
  })

  describe('the other answers', () => {
    it('is not_found for another org’s campaign, and touches nothing', async () => {
      const c = await campaign()
      expect(await updateCampaign(db, otherOrgId, c.id, { ...base, name: 'Hijacked' })).toEqual({ ok: false, reason: 'not_found' })
      expect((await readCampaign(db, orgId, c.id))!.name).toBe('Q4 LinkedIn')
    })

    it('still refuses a member’s save built on a stale auto-send read', async () => {
      const c = await campaign({ autoSend: true })
      await db.update(schema.campaigns).set({ autoSend: false }).where(eq(schema.campaigns.id, c.id))
      const r = await updateCampaign(db, orgId, c.id, { ...base, autoSend: true }, { autoSend: true })
      expect(r).toEqual({ ok: false, reason: 'auto_send_changed', autoSend: false })
      expect((await readCampaign(db, orgId, c.id))!.autoSend).toBe(false)
    })
  })
})
