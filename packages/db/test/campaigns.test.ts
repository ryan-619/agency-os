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
import { eq, inArray } from 'drizzle-orm'
import {
  addSuppression, appendAudit, campaignActivity, campaignAutoPause, campaignAutoPauses, campaignBounceRates,
  campaignInput, createCampaign, listCampaigns, listSuppressions, pausedContacts, removeSuppression, schema,
  updateCampaign, type AgencyDb,
} from '../src/index.js'
import { migratedDb,type TestDb } from './helpers.js'

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
   * The database refuses a cap of zero (`campaigns_daily_cap_check`), so the
   * form must too — otherwise "0" is a 500. A campaign is paused by its
   * status, not by starving its cap.
   */
  it('refuses a cap of zero, as the database does', () => {
    expect(campaignInput.safeParse({ ...valid, dailyCap: 0 }).success).toBe(false)
    expect(campaignInput.safeParse({ ...valid, dailyCap: -1 }).success).toBe(false)
    expect(campaignInput.safeParse({ ...valid, dailyCap: 1 }).success).toBe(true)
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
    test = await migratedDb()
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
      expect(await updateCampaign(db, orgId, row.id, input)).toMatchObject({ ok: true, row: { name: 'Renamed' } })
      expect(await updateCampaign(db, otherOrgId, row.id, input)).toEqual({ ok: false, reason: 'not_found' })
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
        waitingToSend: 0,
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
     * 0018: WHICH path recorded the opt-out is a column, stamped by the
     * writer. A caller that says nothing writes null — never an invented
     * 'manual'.
     */
    it('stores the source the writer names, and null when none is named', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'a@example.com', reason: 'asked', source: 'manual' })
      await addSuppression(db, { orgId, kind: 'email', value: 'b@example.com', reason: 'asked' })
      const rows = await listSuppressions(db, orgId)
      expect(rows.find((r) => r.value === 'a@example.com')!.source).toBe('manual')
      expect(rows.find((r) => r.value === 'b@example.com')!.source).toBeNull()
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

    /**
     * Two replies saying "stop" in the same second are two inserts. The
     * loser used to throw — out of `recordInboundReply`, after the pause and
     * before the audit row. Both now succeed, and exactly one row exists.
     */
    it('survives two identical suppressions arriving at once', async () => {
      const results = await Promise.all([
        addSuppression(db, { orgId, kind: 'email', value: 'stop@example.com', reason: 'first' }),
        addSuppression(db, { orgId, kind: 'email', value: 'STOP@example.com', reason: 'second' }),
      ])
      expect(results.every((r) => r.ok)).toBe(true)
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
  /**
   * A campaign whose addresses bounce past a threshold pauses itself. The
   * RATE is people, not messages; the pause is one UPDATE with
   * `status = 'active'` in its predicate, so it happens — and is audited —
   * once; and a person re-activating it starts a fresh window, so the
   * addresses that caused the pause do not cause the next one.
   */
  describe('bounce rates and the automatic pause', () => {
    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    const since = new Date(now - 30 * DAY)
    const sentAt = new Date(now - 5 * DAY)
    const bouncedAt = new Date(now - 4 * DAY)

    const active = async (over: { org?: string; channel?: 'email' | 'linkedin'; status?: 'active' | 'paused' } = {}) =>
      createCampaign(db, over.org ?? orgId, {
        name: `Q4 ${Math.random()}`,
        channel: over.channel ?? 'email',
        icpProfileId: null,
        dailyCap: 25,
        quietStart: '21:00',
        quietEnd: '08:00',
        autoSend: false,
        status: over.status ?? 'active',
      })

    /** `n` new people, each written to once by this campaign at `at`. */
    const sendTo = async (campaignId: string, n: number, at = sentAt, org = orgId, company = companyId) => {
      const ids: string[] = []
      for (let i = 0; i < n; i += 1) {
        const [c] = await db
          .insert(schema.contacts)
          .values({ orgId: org, companyId: company, email: `p${i}-${Math.random().toString(36).slice(2, 10)}@rentman.io` })
          .returning({ id: schema.contacts.id })
        ids.push(c!.id)
      }
      await db.insert(schema.touches).values(
        ids.map((contactId) => ({
          orgId: org, campaignId, contactId, companyId: company, channel: 'email', direction: 'out',
          status: 'sent', sentAt: at, subject: 's', body: 'b',
        })),
      )
      return ids
    }
    const bounce = (ids: string[], at = bouncedAt) =>
      db.update(schema.contacts).set({ emailBouncedAt: at, emailBounceCode: '5.1.1' }).where(inArray(schema.contacts.id, ids))

    it('counts the people a campaign wrote to, and how many of their addresses bounced since', async () => {
      const c = await active()
      const ids = await sendTo(c.id, 20)
      await bounce(ids.slice(0, 3))
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toEqual([
        { orgId, campaignId: c.id, sentTo: 20, bounced: 3, pct: 15 },
      ])
    })

    it('counts a person once however many messages went to them', async () => {
      const c = await active()
      const ids = await sendTo(c.id, 20)
      await db.insert(schema.touches).values({
        orgId, campaignId: c.id, contactId: ids[0]!, companyId, channel: 'email', direction: 'out',
        status: 'sent', sentAt, subject: 'follow-up', body: 'b',
      })
      await bounce([ids[0]!])
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toMatchObject([{ sentTo: 20, bounced: 1, pct: 5 }])
    })

    it('leaves out a campaign that has written to fewer people than the minimum', async () => {
      const c = await active()
      await bounce(await sendTo(c.id, 19))
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toEqual([])
    })

    /** An address already dead was refused, never sent: it cannot count against this campaign. */
    it('does not count a mark that came BEFORE the campaign wrote to the person', async () => {
      const c = await active()
      const ids = await sendTo(c.id, 20)
      await bounce(ids.slice(0, 5), new Date(sentAt.getTime() - DAY))
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toMatchObject([{ bounced: 0 }])
    })

    it('reads only the window, only email, and only active campaigns', async () => {
      const old = await active()
      await bounce(await sendTo(old.id, 20, new Date(since.getTime() - DAY)))
      const paused = await active({ status: 'paused' })
      await bounce(await sendTo(paused.id, 20))
      const li = await active({ channel: 'linkedin' })
      await sendTo(li.id, 20)
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toEqual([])
    })

    it('reads every org, as the worker must', async () => {
      const [otherCompany] = await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'rival.io' }).returning({ id: schema.companies.id })
      const mine = await active()
      const theirs = await active({ org: otherOrgId })
      await sendTo(mine.id, 20)
      await bounce((await sendTo(theirs.id, 20, sentAt, otherOrgId, otherCompany!.id)).slice(0, 2))
      const rates = await campaignBounceRates(db, { since, minSentTo: 20 })
      expect(rates.map((r) => [r.orgId, r.bounced]).sort()).toEqual([[orgId, 0], [otherOrgId, 2]].sort())
    })

    const detail = { bouncePct: 15, threshold: 5, sentTo: 20, bounced: 3 }

    it('pauses an active campaign once, and audits exactly that once', async () => {
      const c = await active()
      expect(await campaignAutoPause(db, { orgId, campaignId: c.id, detail })).toBe(true)
      expect(await campaignAutoPause(db, { orgId, campaignId: c.id, detail })).toBe(false)
      const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, c.id))
      expect(row!.status).toBe('paused')
      const audit = (await db.select().from(schema.auditLog)).filter((a) => a.action === 'campaign.auto_paused')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ actor: 'system', subjectType: 'campaign', subjectId: c.id, detail })
    })

    /** The predicate is `status = 'active'`: a campaign a person paused, drafted or finished is not touched. */
    it.each(['paused', 'draft', 'done'] as const)('does nothing to a %s campaign', async (status) => {
      const c = await active()
      await db.update(schema.campaigns).set({ status }).where(eq(schema.campaigns.id, c.id))
      expect(await campaignAutoPause(db, { orgId, campaignId: c.id, detail })).toBe(false)
      const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, c.id))
      expect(row!.status).toBe(status)
      expect((await db.select().from(schema.auditLog)).filter((a) => a.action === 'campaign.auto_paused')).toEqual([])
    })

    it('will not pause another org’s campaign', async () => {
      const c = await active()
      expect(await campaignAutoPause(db, { orgId: otherOrgId, campaignId: c.id, detail })).toBe(false)
      const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, c.id))
      expect(row!.status).toBe('active')
    })

    /**
     * The people who caused the pause are not counted again after a person
     * re-activates it — otherwise the next tick pauses it for the problem
     * that person just fixed.
     */
    it('starts a fresh window after the pause, so re-activating is not undone on the next tick', async () => {
      const c = await active()
      await bounce((await sendTo(c.id, 20)).slice(0, 5))
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toHaveLength(1)
      await campaignAutoPause(db, { orgId, campaignId: c.id, detail })
      await db.update(schema.campaigns).set({ status: 'active' }).where(eq(schema.campaigns.id, c.id))
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toEqual([])

      // Twenty NEW people, written to after the pause, and it can be judged again.
      const later = new Date(Date.now() + 60_000)
      await bounce((await sendTo(c.id, 20, later)).slice(0, 4), new Date(later.getTime() + 60_000))
      expect(await campaignBounceRates(db, { since, minSentTo: 20 })).toMatchObject([{ campaignId: c.id, sentTo: 20, bounced: 4 }])
    })

    describe('campaignAutoPauses — what the campaigns page quotes', () => {
      const saved = (campaignId: string, action: string, status: string, at: Date) =>
        db.insert(schema.auditLog).values({
          orgId, actor: 'someone', action, subjectType: 'campaign', subjectId: campaignId,
          detail: { name: 'Q4', status }, createdAt: at,
        })

      it('names the numbers the pause was made on', async () => {
        const c = await active()
        await campaignAutoPause(db, { orgId, campaignId: c.id, detail })
        const pauses = await campaignAutoPauses(db, orgId)
        expect(pauses.get(c.id)).toMatchObject(detail)
        expect(pauses.get(c.id)!.at).toBeInstanceOf(Date)
        expect(await campaignAutoPauses(db, otherOrgId)).toEqual(new Map())
      })

      it('forgets it once a person sets the campaign active again, and not when they only rename it', async () => {
        const c = await active()
        await campaignAutoPause(db, { orgId, campaignId: c.id, detail })
        await saved(c.id, 'campaign.updated', 'paused', new Date(Date.now() + 60_000))
        expect((await campaignAutoPauses(db, orgId)).has(c.id)).toBe(true)
        await saved(c.id, 'campaign.auto_send_off', 'active', new Date(Date.now() + 120_000))
        expect((await campaignAutoPauses(db, orgId)).has(c.id)).toBe(false)
      })

      it('does not quote a row that is missing its numbers', async () => {
        const c = await active()
        await appendAudit(db, {
          orgId, actor: 'system', action: 'campaign.auto_paused', subjectType: 'campaign', subjectId: c.id,
          detail: { bouncePct: 12 },
        })
        expect(await campaignAutoPauses(db, orgId)).toEqual(new Map())
      })
    })
  })
})
