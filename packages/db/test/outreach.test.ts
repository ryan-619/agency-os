/**
 * The send path, against a real engine (PROMPT.md §8.4, §10).
 *
 * §10: "Integration tests for the send path. This is where a bug becomes a
 * legal problem."
 *
 * `packages/core/test/send.test.ts` proves the DECISION — the rules, their
 * order, and every way "we do not know" could be mistaken for "go ahead".
 * This proves the wiring: that the facts handed to that decision are the right
 * facts, read from the right rows, and that the outcome is recorded in a way
 * somebody can audit.
 *
 * The provider here COUNTS rather than sends, and every test asserts against
 * that count. A refusal that still called the provider would be the worst
 * possible bug in this file, and it is checked on every path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  approveDraft, denyDraft, dispatchTouch, dueTouches, handleInboundEmail, looksLikeOptOut,
  pauseContact, pendingDrafts, recordInboundReply, resumeContact, schema, sendOne,
  type AgencyDb, type MessageProvider,
} from '../src/index.js'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'

/** Counts, never sends. A test that could deliver is a test nobody dares run. */
function countingProvider(): MessageProvider & { sent: { to: string; subject: string }[] } {
  const sent: { to: string; subject: string }[] = []
  return {
    name: 'test',
    channels: ['email', 'linkedin', 'sms', 'voice', 'whatsapp'],
    sent,
    async send(m) {
      sent.push({ to: m.to, subject: m.subject })
      return { providerId: `test-${sent.length}` }
    },
  }
}

/** Midday UTC on a Tuesday: midday in London, 08:00 in New York. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
const NIGHT = new Date('2026-09-15T23:30:00.000Z')

describe('the single send path', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let userId: string
  let provider: ReturnType<typeof countingProvider>

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    provider = countingProvider()

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: true, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const send = (over: Record<string, unknown> = {}) =>
    sendOne(db, provider, {
      orgId,
      campaignId,
      contactId,
      companyId,
      subject: 'A gap on your security page',
      body: 'Hello.',
      now: NOON,
      ...over,
    })

  const touch = async (id: string | null) =>
    (await db.select().from(schema.touches).where(eq(schema.touches.id, id!)))[0]!

  it('sends when every rule passes, and records it', async () => {
    const result = await send()
    expect(result.sent).toBe(true)
    expect(provider.sent).toEqual([{ to: 'priya@rentman.io', subject: 'A gap on your security page' }])

    const row = await touch(result.touchId)
    expect(row.status).toBe('sent')
    expect(row.sentAt).not.toBeNull()
    expect(row.providerId).toBe('test-1')
    expect(row.refusalCode).toBeNull()
  })

  /**
   * §2.3: the audit log records that a message went and to whom by ID. Not the
   * subject and not the body — a log is read by more people than a database,
   * and §2.1 makes the content of outreach a compliance artefact.
   */
  it('audits the send without recording what was said', async () => {
    await send()
    const rows = await db.select().from(schema.auditLog)
    const dumped = JSON.stringify(rows)
    expect(dumped).toContain('send.sent')
    expect(dumped).not.toContain('A gap on your security page')
    expect(dumped).not.toContain('Hello.')
  })

  describe('§2.1 rule 1 — suppression', () => {
    it('refuses a suppressed address, and calls no provider', async () => {
      await db
        .insert(schema.suppressions)
        .values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out' })
      const result = await send()
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(result.touchId)).refusalCode).toBe('suppressed')
    })

    /**
     * THE suppression test. Somebody suppressed the whole company; a lookup
     * that checked only the address would send to `priya@` regardless.
     */
    it('refuses when the DOMAIN is suppressed, not just the address', async () => {
      await db
        .insert(schema.suppressions)
        .values({ orgId, kind: 'domain', value: 'rentman.io', reason: 'their legal team asked' })
      const result = await send()
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(result.touchId)).refusalCode).toBe('suppressed')
    })

    it('does not apply another org’s suppression list', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      await db
        .insert(schema.suppressions)
        .values({ orgId: other!.id, kind: 'email', value: 'priya@rentman.io', reason: 'theirs' })
      expect((await send()).sent).toBe(true)
    })

    it('beats a granted consent', async () => {
      await db.insert(schema.suppressions).values({
        orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out',
      })
      await db.insert(schema.consents).values({
        orgId, contactId, channel: 'email', granted: true, source: 'webform',
      })
      const result = await send()
      expect(result.sent).toBe(false)
      expect((await touch(result.touchId)).refusalCode).toBe('suppressed')
    })
  })

  describe('§2.1 rule 2 — consent', () => {
    it('refuses a channel the contact has declined', async () => {
      await db.insert(schema.consents).values({
        orgId, contactId, channel: 'email', granted: false, source: 'reply 2026-08-02',
      })
      const result = await send()
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(result.touchId)).refusalCode).toBe('consent_revoked')
    })

    /**
     * §2.1: "sms_consent and voice_consent are separate booleans". An email
     * opt-in must not imply anything about SMS — the whole reason consent is
     * per channel.
     */
    it('does not let an email consent authorise an SMS', async () => {
      await db.insert(schema.consents).values({
        orgId, contactId, channel: 'email', granted: true, source: 'webform',
      })
      await db.update(schema.contacts).set({ phone: '+14155550100' }).where(eq(schema.contacts.id, contactId))
      // auto_send must come off first: `campaigns_no_auto_send_on_voice_or_sms`
      // forbids the combination outright, which is §2.1 enforced in the schema
      // and is why this test cannot be written the obvious way.
      await db
        .update(schema.campaigns)
        .set({ channel: 'sms', autoSend: false })
        .where(eq(schema.campaigns.id, campaignId))

      const result = await send()
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(result.touchId)).refusalCode).toBe('cold_channel_forbidden')
    })
  })

  describe('§2.1 rule 3 — quiet hours in the recipient’s timezone', () => {
    it('refuses during the recipient’s night', async () => {
      const result = await send({ now: NIGHT })
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(result.touchId)).refusalCode).toBe('quiet_hours')
    })

    /**
     * The same instant, two recipients. This is the rule that looks right from
     * the sender's desk and is wrong for half the list.
     */
    it('allows the same instant for a recipient whose local time is daytime', async () => {
      await db
        .update(schema.contacts)
        .set({ timeZone: 'Pacific/Auckland' }) // 11:30 next morning at 23:30 UTC.
        .where(eq(schema.contacts.id, contactId))
      expect((await send({ now: NIGHT })).sent).toBe(true)
    })

    it('falls back to the company’s timezone when the contact has none', async () => {
      await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, contactId))
      const result = await send({ now: NIGHT })
      expect(result.sent).toBe(false)
      expect((await touch(result.touchId)).refusalCode).toBe('quiet_hours')
    })

    /**
     * Not knowing where somebody is is a reason to WAIT. The obvious shortcut
     * — use the sender's zone — is the exact mistake §2.1 names.
     */
    it('refuses when neither the contact nor the company has a timezone', async () => {
      await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, contactId))
      await db.update(schema.companies).set({ timeZone: null }).where(eq(schema.companies.id, companyId))
      const result = await send()
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(result.touchId)).refusalCode).toBe('unknown_timezone')
    })
  })

  describe('§2.1 rule 4 — the daily cap', () => {
    it('stops at the cap, counting only what actually went', async () => {
      await db.update(schema.campaigns).set({ dailyCap: 2 }).where(eq(schema.campaigns.id, campaignId))
      expect((await send()).sent).toBe(true)
      expect((await send()).sent).toBe(true)
      const third = await send()
      expect(third.sent).toBe(false)
      expect(provider.sent).toHaveLength(2)
      expect((await touch(third.touchId)).refusalCode).toBe('daily_cap')
    })

    /**
     * The cap counts SENT messages. A refusal is not a send, and counting it
     * would let a suppressed contact consume somebody else's slot.
     */
    it('does not count a refused message against the cap', async () => {
      await db.update(schema.campaigns).set({ dailyCap: 1 }).where(eq(schema.campaigns.id, campaignId))
      await db.insert(schema.suppressions).values({
        orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out',
      })
      await send() // refused
      await db.delete(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
      expect((await send()).sent).toBe(true)
    })

    it('counts yesterday’s sends separately', async () => {
      await db.update(schema.campaigns).set({ dailyCap: 1 }).where(eq(schema.campaigns.id, campaignId))
      expect((await send({ now: new Date('2026-09-14T12:00:00.000Z') })).sent).toBe(true)
      expect((await send({ now: NOON })).sent).toBe(true)
      expect(provider.sent).toHaveLength(2)
    })
  })

  describe('§2.4 — the approval gate', () => {
    it('queues for a human when the campaign has no auto-send, and sends nothing', async () => {
      await db.update(schema.campaigns).set({ autoSend: false }).where(eq(schema.campaigns.id, campaignId))
      const result = await send()
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])

      const row = await touch(result.touchId)
      expect(row.status).toBe('awaiting_approval')
      // A message waiting for a person is not refused, so it carries no
      // refusal code — the constraint requires exactly that correspondence.
      expect(row.refusalCode).toBeNull()
    })
  })

  describe('a provider that fails', () => {
    /**
     * The rules said yes and the transport did not work. That is a thing to
     * retry, which is why `error` and `refusal_code` are separate columns and
     * why the status is `failed` rather than `refused`.
     */
    it('records a failure, not a refusal, and re-throws', async () => {
      const broken: MessageProvider = {
        name: 'broken',
        channels: ['email'],
        async send() {
          throw new Error('SMTP 421 service not available')
        },
      }
      await expect(
        sendOne(db, broken, {
          orgId, campaignId, contactId, companyId, subject: 's', body: 'b', now: NOON,
        }),
      ).rejects.toThrow(/421/)

      const rows = await db.select().from(schema.touches)
      expect(rows[0]!.status).toBe('failed')
      expect(rows[0]!.refusalCode).toBeNull()
      expect(rows[0]!.sentAt).toBeNull()
    })
  })

  describe('a reply pauses everything, immediately (§8.4)', () => {
    it('pauses the contact and refuses the next message', async () => {
      const reply = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io',
        subject: 'Re: your note', body: 'Interested — can we talk Thursday?', now: NOON,
      })
      expect(reply.paused).toBe(true)

      const next = await send()
      expect(next.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(next.touchId)).refusalCode).toBe('consent_revoked')
    })

    it('cancels what was already queued for them', async () => {
      await db.update(schema.campaigns).set({ autoSend: false }).where(eq(schema.campaigns.id, campaignId))
      const queued = await send()
      expect((await touch(queued.touchId)).status).toBe('awaiting_approval')

      const reply = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io',
        subject: null, body: 'stop', now: NOON,
      })
      expect(reply.cancelled).toBe(1)
      const after = await touch(queued.touchId)
      expect(after.status).toBe('refused')
      expect(after.refusalCode).toBe('consent_revoked')
    })

    it('logs the reply itself as an inbound touch', async () => {
      const reply = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io',
        subject: 'Re: your note', body: 'yes please', now: NOON,
      })
      const row = await touch(reply.touchId)
      expect(row.direction).toBe('in')
      expect(row.status).toBe('replied')
    })

    /**
     * The first reason is the one that explains the pause. A second reply must
     * not overwrite it with a later timestamp.
     */
    it('does not re-pause an already paused contact', async () => {
      expect(await pauseContact(db, orgId, contactId, 'replied first', NOON)).toBe(true)
      expect(await pauseContact(db, orgId, contactId, 'replied again', NIGHT)).toBe(false)
      const [row] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      expect(row!.pausedReason).toBe('replied first')
    })

    it('can be resumed deliberately', async () => {
      await pauseContact(db, orgId, contactId, 'replied', NOON)
      expect((await send()).sent).toBe(false)
      expect(await resumeContact(db, orgId, contactId)).toBe(true)
      expect((await send()).sent).toBe(true)
    })

    it('never records the reply’s text in the audit log (§2.3)', async () => {
      await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io',
        subject: 'Re: your note', body: 'my private answer', now: NOON,
      })
      const rows = await db.select().from(schema.auditLog)
      expect(JSON.stringify(rows)).not.toContain('my private answer')
    })
  })

  describe('rows that are gone', () => {
    /**
     * No touch row, deliberately: one here would carry a dangling contact_id.
     * The attempt is audited instead, which is where something with no valid
     * subject belongs.
     */
    it('refuses for a contact that does not exist, rather than throwing', async () => {
      const result = await send({ contactId: '00000000-0000-4000-8000-00000000dead' })
      expect(result.sent).toBe(false)
      expect(result.touchId).toBeNull()
      expect(provider.sent).toEqual([])
      expect(await db.select().from(schema.touches)).toEqual([])
      expect(JSON.stringify(await db.select().from(schema.auditLog))).toContain('send.no_such_subject')
    })

    it('refuses for another org’s campaign, and files nothing in their org', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const result = await send({ orgId: other!.id })
      expect(result.sent).toBe(false)
      expect(result.touchId).toBeNull()
      expect(provider.sent).toEqual([])
      expect(await db.select().from(schema.touches)).toEqual([])
    })
  })

  /**
   * The claim the whole design rests on, asserted once, bluntly: across every
   * refusal this file can produce, the provider was never called.
   */
  it('never reaches the provider on any refusal', async () => {
    await db.insert(schema.suppressions).values({
      orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out',
    })
    await send()
    await send({ now: NIGHT })
    await db.update(schema.campaigns).set({ autoSend: false }).where(eq(schema.campaigns.id, campaignId))
    await send()
    await send({ contactId: '00000000-0000-4000-8000-00000000dead' })
    await send({ now: new Date('2026-09-15T12:00:00.000Z'), contactId })
    expect(provider.sent).toEqual([])
  })
  /**
   * A draft from chat has no recipient and no campaign (Phase 2 had no
   * contacts). The person approving names both, and their name goes on the
   * row. Approving does not send: the worker's tick re-checks every rule at
   * the moment of sending.
   */
  describe('a person decides on a draft (§2.4)', () => {
    const draft = async () => {
      const [row] = await db
        .insert(schema.touches)
        .values({
          orgId, companyId, contactId: null, campaignId: null, channel: 'email', direction: 'out',
          status: 'awaiting_approval', subject: 'A gap', body: 'Hello.',
        })
        .returning()
      return row!
    }

    it('lists what is waiting, with what it is about', async () => {
      const d = await draft()
      const pending = await pendingDrafts(db, orgId)
      expect(pending.map((p) => p.touch.id)).toEqual([d.id])
      expect(pending[0]!.company?.domain).toBe('rentman.io')
      expect(pending[0]!.contact).toBeNull()
    })

    it('approves with a recipient, a campaign, and a name', async () => {
      const d = await draft()
      const r = await approveDraft(db, { orgId, touchId: d.id, contactId, campaignId, approvedBy: userId, note: 'good' })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.touch.status).toBe('approved')
      expect(r.touch.contactId).toBe(contactId)
      expect(r.touch.campaignId).toBe(campaignId)
      expect(r.touch.approvedBy).toBe(userId)
      expect(r.touch.approvedAt).not.toBeNull()
      expect(r.touch.decisionNote).toBe('good')
      // Nothing was sent by approving.
      expect(provider.sent).toEqual([])
    })

    it('is then picked up as due, and sends through every rule', async () => {
      const d = await draft()
      await approveDraft(db, { orgId, touchId: d.id, contactId, campaignId, approvedBy: userId })
      const due = await dueTouches(db, 10, NOON)
      expect(due.map((t) => t.id)).toEqual([d.id])
      // The campaign has auto-send here, but even without it the human's
      // approval is what satisfies the gate — and only the gate.
      await db.update(schema.campaigns).set({ autoSend: false }).where(eq(schema.campaigns.id, campaignId))
      const result = await dispatchTouch(db, provider, due[0]!, { now: NOON })
      expect(result.sent).toBe(true)
      expect((await touch(d.id)).status).toBe('sent')
    })

    it('still refuses an approved draft for a suppression at the moment of sending', async () => {
      const d = await draft()
      await approveDraft(db, { orgId, touchId: d.id, contactId, campaignId, approvedBy: userId })
      await db.insert(schema.suppressions).values({
        orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out after approval',
      })
      const [row] = await dueTouches(db, 10, NOON)
      const result = await dispatchTouch(db, provider, row!, { now: NOON })
      expect(result.sent).toBe(false)
      expect((await touch(d.id)).refusalCode).toBe('suppressed')
      expect(provider.sent).toEqual([])
    })

    /**
     * The draft quotes one company's findings (§2.2). Sending it to a person
     * at another company is a claim about the wrong company.
     */
    it('refuses to approve a draft to a contact at a different company', async () => {
      const [other] = await db
        .insert(schema.companies)
        .values({ orgId, domain: 'other.io' })
        .returning({ id: schema.companies.id })
      const [stranger] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId: other!.id, email: 'x@other.io' })
        .returning({ id: schema.contacts.id })
      const d = await draft()
      const r = await approveDraft(db, { orgId, touchId: d.id, contactId: stranger!.id, campaignId, approvedBy: userId })
      expect(r).toEqual({ ok: false, reason: 'wrong_company' })
      expect((await touch(d.id)).status).toBe('awaiting_approval')
    })

    it('lets exactly one of two simultaneous approvers win', async () => {
      const d = await draft()
      const [a, b] = await Promise.all([
        approveDraft(db, { orgId, touchId: d.id, contactId, campaignId, approvedBy: userId }),
        approveDraft(db, { orgId, touchId: d.id, contactId, campaignId, approvedBy: userId }),
      ])
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    })

    it('refuses an approver from another org', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const [outsider] = await db
        .insert(schema.users)
        .values({ orgId: other!.id, email: 'o@rival.test', role: 'owner' })
        .returning({ id: schema.users.id })
      const d = await draft()
      const r = await approveDraft(db, { orgId, touchId: d.id, contactId, campaignId, approvedBy: outsider!.id })
      expect(r.ok).toBe(false)
      expect((await touch(d.id)).status).toBe('awaiting_approval')
    })

    it('denies with a note, and the note is kept', async () => {
      const d = await draft()
      const r = await denyDraft(db, { orgId, touchId: d.id, decidedBy: userId, note: 'wrong tone' })
      expect(r.ok).toBe(true)
      const row = await touch(d.id)
      expect(row.status).toBe('refused')
      expect(row.decisionNote).toBe('wrong tone')
      expect(await dueTouches(db, 10, NOON)).toEqual([])
    })

    it('cannot approve or deny a draft twice', async () => {
      const d = await draft()
      await denyDraft(db, { orgId, touchId: d.id, decidedBy: userId })
      expect((await approveDraft(db, { orgId, touchId: d.id, contactId, campaignId, approvedBy: userId })).ok).toBe(false)
      expect((await denyDraft(db, { orgId, touchId: d.id, decidedBy: userId })).ok).toBe(false)
    })

    it('does not dispatch anything that is not approved or queued', async () => {
      const d = await draft()
      const result = await dispatchTouch(db, provider, d, { now: NOON })
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(d.id)).status).toBe('awaiting_approval')
    })
  })

  describe('dueTouches', () => {
    it('leaves a message scheduled for later, and picks it up once due', async () => {
      const d = await send()
      await db
        .update(schema.touches)
        .set({ status: 'approved', approvedBy: userId, approvedAt: NOON, scheduledFor: new Date(NOON.getTime() + 3_600_000) })
        .where(eq(schema.touches.id, d.touchId!))
      expect(await dueTouches(db, 10, NOON)).toEqual([])
      expect((await dueTouches(db, 10, new Date(NOON.getTime() + 3_600_001))).length).toBe(1)
    })
  })

  describe('matching an inbound email (§8.4)', () => {
    /** Send one, so there is a Message-ID to reply to. */
    const sent = async () => {
      const r = await send()
      return (await touch(r.touchId!)).providerId!
    }

    it('matches by the Message-ID the reply names, and ties the reply to it', async () => {
      const messageId = await sent()
      const outcome = await handleInboundEmail(db, {
        from: 'Priya Sharma <priya@rentman.io>'.replace(/.*<|>.*/g, ''),
        subject: 'Re: A gap',
        text: 'Thursday works.',
        references: [messageId],
        now: NOON,
      })
      expect(outcome.matched).toBe('message')
      if (outcome.matched === 'none') return
      const reply = await touch(outcome.touchId)
      expect(reply.direction).toBe('in')
      expect(reply.inReplyTo).not.toBeNull()
      expect(outcome.paused).toBe(true)
    })

    it('matches by address when there is no reference and the address is unambiguous', async () => {
      const outcome = await handleInboundEmail(db, {
        from: 'PRIYA@rentman.io', subject: null, text: 'hi', references: [], now: NOON,
      })
      expect(outcome.matched).toBe('contact')
    })

    /**
     * Two orgs, one address. Nothing says which conversation this belongs to,
     * and guessing files somebody's reply under the wrong agency.
     */
    it('drops a reply whose address belongs to contacts in two orgs', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const [c2] = await db.insert(schema.companies).values({ orgId: other!.id, domain: 'rentman.io' }).returning({ id: schema.companies.id })
      await db.insert(schema.contacts).values({ orgId: other!.id, companyId: c2!.id, email: 'priya@rentman.io' })
      const outcome = await handleInboundEmail(db, { from: 'priya@rentman.io', subject: null, text: 'hi', now: NOON })
      expect(outcome.matched).toBe('none')
      expect(await db.select().from(schema.touches)).toEqual([])
    })

    it('drops a message from nobody it knows', async () => {
      const outcome = await handleInboundEmail(db, { from: 'stranger@example.com', subject: null, text: 'hi', now: NOON })
      expect(outcome).toMatchObject({ matched: 'none' })
    })

    it('prefers the reference over the address when both are present', async () => {
      const messageId = await sent()
      const outcome = await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: null, text: 'ok', references: [messageId], now: NOON,
      })
      expect(outcome.matched).toBe('message')
    })

    /**
     * "Stop" in a reply IS the opt-out. It goes on the suppression list —
     * anything weaker is a promise the send path does not keep.
     */
    it('suppresses the address when the reply says stop', async () => {
      const outcome = await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: 'Re', text: 'Please unsubscribe me.', now: NOON,
      })
      expect(outcome).toMatchObject({ suppressed: true })
      const rows = await db.select().from(schema.suppressions)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.value).toBe('priya@rentman.io')
      expect(rows[0]!.reason).toMatch(/replied asking to stop/)
    })

    it('does not suppress a reply that merely mentions stopping', async () => {
      await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: 'Re',
        text: 'We had to stop the migration last week, but yes, let us talk Thursday.', now: NOON,
      })
      expect(await db.select().from(schema.suppressions)).toEqual([])
    })
  })

  describe('looksLikeOptOut', () => {
    it.each([
      'stop',
      'STOP',
      'Unsubscribe',
      'please remove me',
      'Opt out.',
      'Do not contact me again',
      'No more emails!',
      'take me off your list',
      'Unsubscribe\n\n> On Tue, you wrote:\n> A gap on your security page',
    ])('reads %j as an opt-out', (body) => {
      expect(looksLikeOptOut(body)).toBe(true)
    })

    it.each([
      'We had to stop the migration; let us talk Thursday.',
      'Interested — can we stop by your office?',
      'Thanks, I will unsubscribe from the newsletter but keep me on this one.',
      '',
      null,
      // Their quoted footer, not their words.
      'Sounds good.\n\n> Reply STOP to unsubscribe',
    ])('does not read %j as an opt-out', (body) => {
      expect(looksLikeOptOut(body)).toBe(false)
    })
  })

  describe('findings from review', () => {
    /**
     * A LinkedIn draft approved under an email campaign used to have its
     * channel silently rewritten to email — a message written for one medium
     * sent through another.
     */
    it('refuses to approve a draft under a campaign on a different channel', async () => {
      const [li] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'LinkedIn Q4', channel: 'linkedin', autoSend: false, dailyCap: 10, status: 'active' })
        .returning({ id: schema.campaigns.id })
      const [draft] = await db
        .insert(schema.touches)
        .values({ orgId, companyId, channel: 'linkedin', direction: 'out', status: 'awaiting_approval', subject: 's', body: 'b' })
        .returning()
      const wrong = await approveDraft(db, { orgId, touchId: draft!.id, contactId, campaignId, approvedBy: userId })
      expect(wrong).toEqual({ ok: false, reason: 'wrong_channel' })
      expect((await touch(draft!.id)).channel).toBe('linkedin')
      const right = await approveDraft(db, { orgId, touchId: draft!.id, contactId, campaignId: li!.id, approvedBy: userId })
      expect(right.ok).toBe(true)
    })

    /**
     * An SMTP transport carries email and only email. Handed a LinkedIn touch
     * it would have mailed whatever was in `linkedin_url`, with the email
     * suppression list never consulted. The row is left exactly as it was.
     */
    it('leaves a message on a channel the provider cannot carry untouched', async () => {
      await db.update(schema.contacts).set({ linkedinUrl: 'https://linkedin.com/in/priya' }).where(eq(schema.contacts.id, contactId))
      const [li] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'LinkedIn Q4', channel: 'linkedin', autoSend: true, dailyCap: 10, status: 'active' })
        .returning({ id: schema.campaigns.id })
      const [row] = await db
        .insert(schema.touches)
        .values({ orgId, companyId, contactId, campaignId: li!.id, channel: 'linkedin', direction: 'out', status: 'queued', subject: 's', body: 'b' })
        .returning()
      const emailOnly: MessageProvider = { name: 'smtp-like', channels: ['email'], send: provider.send }
      const result = await dispatchTouch(db, emailOnly, row!, { now: NOON })
      expect(result.sent).toBe(false)
      expect(provider.sent).toEqual([])
      expect((await touch(row!.id)).status).toBe('queued')
      // And the due query never offers it to an email-only sender.
      expect(await dueTouches(db, 10, NOON, ['email'])).toEqual([])
      expect((await dueTouches(db, 10, NOON, ['linkedin'])).map((t) => t.id)).toEqual([row!.id])
    })

    /**
     * A webhook provider retries; an IMAP reconnect re-presents. The same
     * Message-ID must be one reply, one pause, one audit row.
     */
    it('records a reply with the same Message-ID once', async () => {
      const first = await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: 'Re', text: 'yes', messageId: '<abc@rentman.io>', now: NOON,
      })
      const again = await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: 'Re', text: 'yes', messageId: '<abc@rentman.io>', now: NOON,
      })
      expect(first.matched).toBe('contact')
      expect(again.matched).toBe('message')
      if (again.matched === 'none' || first.matched === 'none') return
      expect(again.touchId).toBe(first.touchId)
      const inbound = await db.select().from(schema.touches).where(eq(schema.touches.direction, 'in'))
      expect(inbound).toHaveLength(1)
    })

    /**
     * `sendOne` claims its freshly inserted row before dispatching, so a tick
     * that reads the queue in between finds nothing to pick up.
     */
    it('claims the row it inserts before the provider sees it', async () => {
      const slow: MessageProvider = {
        name: 'slow',
        channels: ['email'],
        async send(m) {
          // While the provider is "on the wire", the queue must not offer the row.
          expect(await dueTouches(db, 10, NOON)).toEqual([])
          return provider.send(m)
        },
      }
      const r = await sendOne(db, slow, { orgId, campaignId, contactId, companyId, subject: 's', body: 'b', now: NOON })
      expect(r.sent).toBe(true)
    })
  })

})
