/**
 * The campaign builder and the suppression list (PROMPT.md §8.4, §2.1).
 *
 * The suppression tests are the ones that matter. §2.1: "A `suppression` table
 * wins over everything." A row that fails to go in is an opt-out that was
 * never recorded — so the interesting behaviour is what happens when a value
 * cannot be normalised, and whether the person who pasted it finds out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  addSuppression, campaignActivity, campaignInput, createCampaign, listCampaigns,
  listSuppressions, pausedContacts, removeSuppression, schema, updateCampaign,
  type AgencyDb,
} from '../src/index.js'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'

describe('campaignInput', () => {
  const valid = {
    name: 'Q4 security gaps',
    channel: 'email' as const,
    dailyCap: 25,
    quietStart: '21:00',
    quietEnd: '08:00',
  }

  it('accepts a well-formed campaign', () => {
    const parsed = campaignInput.safeParse(valid)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    // §2.4: auto-send is off unless somebody asked for it.
    expect(parsed.data.autoSend).toBe(false)
    expect(parsed.data.status).toBe('draft')
  })

  /**
   * §2.1: cold outreach is email and LinkedIn. A CAMPAIGN is by definition a
   * sequence of cold messages, so the other channels are not offered — and
   * the send path refuses them independently, because a form is not a control.
   */
  it.each(['sms', 'voice', 'whatsapp'])('refuses a %s campaign outright', (channel) => {
    expect(campaignInput.safeParse({ ...valid, channel }).success).toBe(false)
  })

  it.each(['9pm', '25:00', '21:60', '', '21'])('refuses the quiet time %j', (quietStart) => {
    expect(campaignInput.safeParse({ ...valid, quietStart }).success).toBe(false)
  })

  it('accepts the HH:MM:SS that Postgres `time` reads back', () => {
    expect(campaignInput.safeParse({ ...valid, quietStart: '21:00:00' }).success).toBe(true)
  })

  /**
   * Zero is how a campaign is paused without changing its status, and it must
   * be allowed. A negative cap is not a pause, it is a typo.
   */
  it('allows a cap of zero and refuses a negative one', () => {
    expect(campaignInput.safeParse({ ...valid, dailyCap: 0 }).success).toBe(true)
    expect(campaignInput.safeParse({ ...valid, dailyCap: -1 }).success).toBe(false)
  })

  it('refuses a cap no warmed mailbox would survive', () => {
    expect(campaignInput.safeParse({ ...valid, dailyCap: 5000 }).success).toBe(false)
  })
})

describe('against a real engine', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const campaign = () =>
    createCampaign(db, orgId, {
      name: `Q4 ${Math.random()}`,
      channel: 'email',
      icpProfileId: null,
      dailyCap: 25,
      quietStart: '21:00',
      quietEnd: '08:00',
      autoSend: false,
      status: 'draft',
    })

  describe('campaigns', () => {
    it('creates one with auto-send off', async () => {
      const row = await campaign()
      expect(row.autoSend).toBe(false)
      expect(row.status).toBe('draft')
    })

    it('updates one, and will not touch another org’s', async () => {
      const row = await campaign()
      const input = {
        name: 'Renamed', channel: 'email' as const, icpProfileId: null, dailyCap: 10,
        quietStart: '22:00', quietEnd: '07:00', autoSend: true, status: 'active' as const,
      }
      expect((await updateCampaign(db, orgId, row.id, input))!.name).toBe('Renamed')
      expect(await updateCampaign(db, otherOrgId, row.id, input)).toBeNull()
    })

    it('lists one org’s campaigns and nobody else’s', async () => {
      await campaign()
      expect((await listCampaigns(db, orgId)).length).toBe(1)
      expect(await listCampaigns(db, otherOrgId)).toEqual([])
    })

    /**
     * §2.1 in the schema: `campaigns_no_auto_send_on_voice_or_sms`. Unreachable
     * through `campaignInput`, which does not offer those channels — asserted
     * here against the database, because the constraint is what holds when
     * something writes a row without going through the form.
     */
    it('refuses auto-send on a voice or sms campaign at the database', async () => {
      for (const channel of ['voice', 'sms']) {
        await expect(
          db.insert(schema.campaigns).values({
            orgId, name: `bad-${channel}`, channel, autoSend: true, dailyCap: 5,
          }),
        ).rejects.toThrow()
      }
    })
  })

  describe('campaignActivity', () => {
    /**
     * The numbers that answer "why did a campaign of 40 send 12?". Grouped
     * from `touches` rather than counted on the campaign row: a counter is a
     * second source of truth and its drift always favours sending.
     */
    it('counts what went, what is waiting, and why the rest did not', async () => {
      const c = await campaign()
      const touch = (status: string, refusalCode: string | null = null) =>
        db.insert(schema.touches).values({
          orgId, campaignId: c.id, companyId, channel: 'email', direction: 'out',
          status, refusalCode, sentAt: status === 'sent' ? new Date() : null,
        })

      await touch('sent')
      await touch('sent')
      await touch('awaiting_approval')
      await touch('refused', 'suppressed')
      await touch('refused', 'suppressed')
      await touch('refused', 'quiet_hours')

      const activity = await campaignActivity(db, orgId, c.id)
      expect(activity.sent).toBe(2)
      expect(activity.awaitingApproval).toBe(1)
      // Commonest first, so the screen leads with the reason that matters.
      expect(activity.refusals).toEqual([
        { code: 'suppressed', n: 2 },
        { code: 'quiet_hours', n: 1 },
      ])
    })

    it('reports zeroes for a campaign that has done nothing', async () => {
      const c = await campaign()
      expect(await campaignActivity(db, orgId, c.id)).toEqual({
        sent: 0,
        awaitingApproval: 0,
        refusals: [],
      })
    })
  })

  describe('the suppression list', () => {
    it('normalises on the way in, so equality means equality', async () => {
      const added = await addSuppression(db, {
        orgId, kind: 'email', value: '  Stop@Example.COM ', reason: 'replied stop',
      })
      expect(added).toMatchObject({ ok: true, value: 'stop@example.com', alreadyPresent: false })
      const rows = await listSuppressions(db, orgId)
      expect(rows[0]!.value).toBe('stop@example.com')
    })

    /**
     * THE refusal. Somebody pasting a list of opt-outs must be told which line
     * did not go in, because a silently dropped one is a person who gets
     * contacted again. The message has to say what to do about it.
     */
    it('refuses a number with no country code, and explains why that matters', async () => {
      const result = await addSuppression(db, {
        orgId, kind: 'phone', value: '415 555 0100', reason: 'asked us to stop',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toMatch(/country code/)
      // Not a pedantic complaint — it says what the consequence would be.
      expect(result.message).toMatch(/would not be honoured/)
    })

    it.each([
      ['email', 'not an email'],
      ['email', ''],
      ['domain', 'not a domain'],
      ['phone', '+1-800-FLOWERS'],
    ])('refuses the %s value %j rather than storing something that never matches', async (kind, value) => {
      const result = await addSuppression(db, {
        orgId, kind: kind as 'email', value, reason: 'opted out',
      })
      expect(result.ok).toBe(false)
      expect(await listSuppressions(db, orgId)).toEqual([])
    })

    /**
     * A suppression nobody can explain gets deleted by whoever finds it, and
     * deleting one means contacting somebody who opted out.
     */
    it('refuses a suppression with no reason', async () => {
      const result = await addSuppression(db, {
        orgId, kind: 'email', value: 'stop@example.com', reason: '   ',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toMatch(/Say why/)
    })

    /**
     * Somebody pasting a list twice should not have to work out which line was
     * the duplicate. Adding one that is already there is the outcome they
     * wanted.
     */
    it('treats a duplicate as success, and does not write a second row', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'stop@example.com', reason: 'first' })
      const again = await addSuppression(db, {
        orgId, kind: 'email', value: 'STOP@example.com', reason: 'second',
      })
      expect(again).toMatchObject({ ok: true, alreadyPresent: true })
      expect(await listSuppressions(db, orgId)).toHaveLength(1)
    })

    it('keeps each org’s list separate', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'stop@example.com', reason: 'ours' })
      expect(await listSuppressions(db, otherOrgId)).toEqual([])
    })

    /**
     * Removable on purpose: one added by mistake has to come off, and a list
     * that can only grow is a list nobody trusts. The audit row the caller
     * writes is what makes it accountable.
     */
    it('can be removed, and says what was removed so the caller can audit it', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'stop@example.com', reason: 'typo' })
      const [row] = await listSuppressions(db, orgId)
      const removed = await removeSuppression(db, orgId, row!.id)
      expect(removed!.value).toBe('stop@example.com')
      expect(removed!.reason).toBe('typo')
      expect(await listSuppressions(db, orgId)).toEqual([])
    })

    it('will not remove another org’s', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'stop@example.com', reason: 'ours' })
      const [row] = await listSuppressions(db, orgId)
      expect(await removeSuppression(db, otherOrgId, row!.id)).toBeNull()
      expect(await listSuppressions(db, orgId)).toHaveLength(1)
    })
  })

  describe('pausedContacts', () => {
    it('lists who is paused and why, oldest first', async () => {
      const [a] = await db
        .insert(schema.contacts)
        .values({
          orgId, companyId, email: 'a@rentman.io',
          pausedAt: new Date('2026-09-01T10:00:00Z'), pausedReason: 'replied',
        })
        .returning({ id: schema.contacts.id })
      await db.insert(schema.contacts).values({
        orgId, companyId, email: 'b@rentman.io',
        pausedAt: new Date('2026-09-05T10:00:00Z'), pausedReason: 'out of office',
      })
      await db.insert(schema.contacts).values({ orgId, companyId, email: 'c@rentman.io' })

      const paused = await pausedContacts(db, orgId)
      expect(paused.map((p) => p.email)).toEqual(['a@rentman.io', 'b@rentman.io'])
      expect(paused[0]!.id).toBe(a!.id)
      expect(paused[0]!.pausedReason).toBe('replied')
    })

    it('is empty when nobody is paused', async () => {
      await db.insert(schema.contacts).values({ orgId, companyId, email: 'c@rentman.io' })
      expect(await pausedContacts(db, orgId)).toEqual([])
    })
  })
})
