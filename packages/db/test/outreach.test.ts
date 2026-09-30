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
import { decideSend } from '@agency/core'
import {
  approveDraft, contactsUpdate, denyDraft, dispatchTouch, dueTouches, handleInboundEmail, looksLikeOptOut,
  outreachRecordBounce, pauseContact, pendingDrafts, recordInboundReply, resumeContact, schema, sendFactsFor, sendOne,
  type AgencyDb, type InboundLog, type MessageProvider,
} from '../src/index.js'
import { migratedDb,type TestDb } from './helpers.js'

/** Counts, never sends. A test that could deliver is a test nobody dares run. */
function countingProvider(): MessageProvider & {
  sent: { to: string; subject: string }[]
  /** The headers each send carried, in order — kept apart so `sent` keeps its shape. */
  headersSeen: (Readonly<Record<string, string>> | undefined)[]
} {
  const sent: { to: string; subject: string }[] = []
  const headersSeen: (Readonly<Record<string, string>> | undefined)[] = []
  return {
    name: 'test',
    channels: ['email', 'linkedin', 'sms', 'voice', 'whatsapp'],
    sent,
    headersSeen,
    async send(m) {
      sent.push({ to: m.to, subject: m.subject })
      headersSeen.push(m.headers)
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
    test = await migratedDb()
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

/**
 * The wave-1 contract changes (0018): the exported fact-gatherer, threading
 * an answer, the duplicate flag, the company on a reply, and §2.1's two
 * precedence rules for an inbound message — the opt-out reader runs first,
 * and an opt-out that cannot be stored fails loudly.
 */
describe('the send-path contract', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let userId: string
  let provider: ReturnType<typeof countingProvider>

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    provider = countingProvider()
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db.insert(schema.companies).values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' }).returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db.insert(schema.contacts).values({ orgId, companyId, email: 'priya@rentman.io', timeZone: 'Europe/London' }).returning({ id: schema.contacts.id })
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

  const touch = async (id: string | null) =>
    (await db.select().from(schema.touches).where(eq(schema.touches.id, id!)))[0]!

  describe('sendFactsFor — the sender’s own facts, exported', () => {
    const facts = (over: Record<string, unknown> = {}) =>
      sendFactsFor(db, { orgId, campaignId, contactId, approvedByHuman: false, now: NOON, ...over })

    it('gathers the facts the decision needs, and says whose zone', async () => {
      const out = await facts()
      expect('missing' in out).toBe(false)
      if ('missing' in out) return
      expect(out.recipient).toBe('priya@rentman.io')
      expect(out.zoneFrom).toBe('contact')
      expect(out.paused).toBe(false)
      expect(out.facts.suppressed).toBe(false)
      expect(out.facts.consent).toBeNull()
      expect(out.facts.recipientTimeZone).toBe('Europe/London')
      expect(out.facts.sentToday).toBe(0)
      expect(decideSend(out.facts).code).toBe('send_now')
    })

    it('sees a suppression, by domain as well as by address', async () => {
      await db.insert(schema.suppressions).values({ orgId, kind: 'domain', value: 'rentman.io', reason: 'asked' })
      const out = await facts()
      if ('missing' in out) throw new Error(out.missing)
      expect(out.facts.suppressed).toBe(true)
    })

    it('reports a paused contact as paused, and the facts refuse as consent_revoked', async () => {
      await pauseContact(db, orgId, contactId, 'replied', NOON)
      const out = await facts()
      if ('missing' in out) throw new Error(out.missing)
      expect(out.paused).toBe(true)
      expect(decideSend(out.facts).code).toBe('consent_revoked')
    })

    it('falls back to the company zone and says so; with neither, the zone is null', async () => {
      await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, contactId))
      const company = await facts()
      if ('missing' in company) throw new Error(company.missing)
      expect(company.zoneFrom).toBe('company')
      await db.update(schema.companies).set({ timeZone: null }).where(eq(schema.companies.id, companyId))
      const none = await facts()
      if ('missing' in none) throw new Error(none.missing)
      expect(none.zoneFrom).toBeNull()
      expect(none.facts.recipientTimeZone).toBeNull()
      expect(decideSend(none.facts).code).toBe('unknown_timezone')
    })

    it('is missing for a campaign or contact that is not in this org', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect('missing' in (await facts({ orgId: other!.id }))).toBe(true)
      expect('missing' in (await facts({ campaignId: '00000000-0000-0000-0000-000000000000' }))).toBe(true)
    })

    it('passes approvedByHuman through untouched — the caller says what the row says', async () => {
      await db.update(schema.campaigns).set({ autoSend: false }).where(eq(schema.campaigns.id, campaignId))
      const a = await facts({ approvedByHuman: false })
      const b = await facts({ approvedByHuman: true })
      if ('missing' in a || 'missing' in b) throw new Error('missing')
      expect(decideSend(a.facts).code).toBe('needs_approval')
      expect(decideSend(b.facts).code).toBe('send_now')
    })
  })

  describe('threading an answer', () => {
    const inboundWith = async (providerId: string, org = orgId, direction: 'in' | 'out' = 'in') => {
      // A touch names a subject (`touches_names_a_subject`), so a row in
      // another org needs that org's own company.
      const subject =
        org === orgId
          ? { companyId, contactId }
          : { companyId: (await db.insert(schema.companies).values({ orgId: org, domain: `${providerId.length}.rival.test` }).returning({ id: schema.companies.id }))[0]!.id }
      return (await db
        .insert(schema.touches)
        .values({ orgId: org, ...subject, channel: 'email', direction, status: direction === 'in' ? 'replied' : 'sent', providerId, ...(direction === 'out' ? { sentAt: NOON } : {}) })
        .returning())[0]!
    }

    const outbound = async (answersTouchId: string | null = null) =>
      (await db
        .insert(schema.touches)
        .values({ orgId, companyId, contactId, campaignId, channel: 'email', direction: 'out', status: 'queued', subject: 'Re: your reply', body: 'Thanks.', answersTouchId })
        .returning())[0]!

    it('carries In-Reply-To and References from the inbound row’s Message-ID', async () => {
      const parent = await inboundWith('<abc@x>')
      const row = await outbound(parent.id)
      const r = await dispatchTouch(db, provider, row, { now: NOON })
      expect(r.sent).toBe(true)
      expect(provider.headersSeen[0]!['In-Reply-To']).toBe('<abc@x>')
      expect(provider.headersSeen[0]!['References']).toBe('<abc@x>')
    })

    /**
     * The database refuses a cross-org or outbound parent at insert (0018's
     * trigger), so these hand dispatchTouch an in-memory row that names one:
     * the lookup itself carries org and direction, and adds nothing.
     */
    it('adds no header for a parent in another org, or an outbound parent', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const theirs = await inboundWith('<theirs@rival>', other!.id)
      const ours = await inboundWith('<sent@x>', orgId, 'out')
      const a = await dispatchTouch(db, provider, { ...(await outbound()), answersTouchId: theirs.id }, { now: NOON })
      const b = await dispatchTouch(db, provider, { ...(await outbound()), answersTouchId: ours.id }, { now: NOON })
      expect(a.sent && b.sent).toBe(true)
      expect(provider.headersSeen[0]).toEqual({})
      expect(provider.headersSeen[1]).toEqual({})
    })

    it('merges the caller’s headers over its own, and a null return adds nothing', async () => {
      const parent = await inboundWith('<abc@x>')
      const row = await outbound(parent.id)
      await dispatchTouch(db, provider, row, {
        now: NOON,
        headersFor: (t) => (t.id === row.id ? { 'List-Unsubscribe': '<https://x.example/u/1>' } : null),
      })
      expect(provider.headersSeen[0]).toEqual({
        'In-Reply-To': '<abc@x>',
        References: '<abc@x>',
        'List-Unsubscribe': '<https://x.example/u/1>',
      })
      await dispatchTouch(db, provider, await outbound(), { now: NOON, headersFor: () => null })
      expect(provider.headersSeen[1]).toEqual({})
    })

    it('still works with a provider that ignores headers', async () => {
      const blind: MessageProvider = {
        name: 'blind',
        channels: ['email'],
        async send(m) {
          return { providerId: `blind-${m.to}` }
        },
      }
      const parent = await inboundWith('<abc@x>')
      const r = await dispatchTouch(db, blind, await outbound(parent.id), { now: NOON })
      expect(r.sent).toBe(true)
      expect((await touch(r.touchId)).providerId).toBe('blind-priya@rentman.io')
    })
  })

  describe('an inbound reply', () => {
    it('says whether it had already been recorded, and which company it is about', async () => {
      const first = await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: 'Re', text: 'yes', messageId: '<abc@rentman.io>', now: NOON,
      })
      const again = await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: 'Re', text: 'yes', messageId: '<abc@rentman.io>', now: NOON,
      })
      if (first.matched === 'none' || again.matched === 'none') throw new Error('unmatched')
      expect(first.duplicate).toBe(false)
      expect(again.duplicate).toBe(true)
      expect(first.companyDomain).toBe('rentman.io')
      expect(first.companyId).toBe(companyId)
      expect(again.companyDomain).toBe('rentman.io')
    })

    it('stamps the suppression it writes with source: reply', async () => {
      const r = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io', subject: 'Re', body: 'unsubscribe', now: NOON,
      })
      expect(r.suppressed).toBe(true)
      expect(r.optOutNotRecorded).toBe(false)
      const [row] = await db.select().from(schema.suppressions)
      expect(row!.source).toBe('reply')
    })

    /**
     * §2.1's Phase 4 obligation. The one opt-out path that runs unattended
     * used to store `opted_out` with no suppression and `suppressed: false`,
     * silently. Now: the row still says opted_out (queryable), an audit row
     * names the touch (countable), and the log shouts (visible).
     */
    it('FAILS LOUDLY when the address cannot be suppressed — audit row, log line, flag', async () => {
      const lines: { message: string; fields?: Readonly<Record<string, unknown>> }[] = []
      const log: InboundLog = { error: (message, fields) => lines.push({ message, fields }) }
      const r = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'not an address', subject: 'Re', body: 'unsubscribe', now: NOON, log,
      })
      expect(r.replyKind).toBe('opted_out')
      expect(r.suppressed).toBe(false)
      expect(r.optOutNotRecorded).toBe(true)
      expect(await db.select().from(schema.suppressions)).toEqual([])
      const audit = await db.select().from(schema.auditLog)
      const entry = audit.find((a) => a.action === 'contact.opt_out_not_recorded')
      expect(entry?.subjectId).toBe(contactId)
      expect(entry?.detail).toMatchObject({ touchId: r.touchId, why: 'unparseable_address' })
      expect(lines).toHaveLength(1)
      expect(lines[0]!.message).toContain('OPT-OUT NOT RECORDED')
      expect(lines[0]!.fields).toMatchObject({ touchId: r.touchId, why: 'unparseable_address' })
      // §2.3: ids only. The address the person typed is in the touch row, not the log.
      expect(JSON.stringify([audit, lines])).not.toContain('not an address')
      // And the person is still paused: the reply was read, whatever else failed.
      expect(r.paused).toBe(true)
    })

    it('FAILS LOUDLY when the suppression write throws', async () => {
      const lines: string[] = []
      const flaky = new Proxy(db as object, {
        get(target, prop, receiver) {
          if (prop === 'insert') {
            return (table: unknown) => {
              if (table === schema.suppressions) throw new Error('Connection terminated unexpectedly')
              return (target as AgencyDb).insert(table as typeof schema.touches)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      }) as AgencyDb
      const r = await recordInboundReply(flaky, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io', subject: 'Re', body: 'please unsubscribe me', now: NOON,
        log: { error: (m) => lines.push(m) },
      })
      expect(r.optOutNotRecorded).toBe(true)
      expect(r.replyKind).toBe('opted_out')
      expect(lines.some((l) => l.includes('OPT-OUT NOT RECORDED'))).toBe(true)
      const entry = (await db.select().from(schema.auditLog)).find((a) => a.action === 'contact.opt_out_not_recorded')
      expect(entry?.detail).toMatchObject({ why: 'Error' })
    })

    /**
     * The precedence, stated: the opt-out reader runs FIRST. An out-of-office
     * whose first line asks to be removed is an opt-out that happens to be
     * automatic, and the automatic flag must not file it as auto_reply with
     * no suppression.
     */
    it('an auto-reply whose first line says unsubscribe still writes the suppression row and is stored opted_out', async () => {
      const r = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io', subject: 'Automatic reply',
        body: 'Unsubscribe.\nI have left the company; this mailbox is not monitored and I do not want more email.',
        autoReply: true, now: NOON,
      })
      expect(r.replyKind).toBe('opted_out')
      expect(r.suppressed).toBe(true)
      expect(r.paused).toBe(true)
      expect((await db.select().from(schema.suppressions))[0]!.value).toBe('priya@rentman.io')
    })

    it('a genuine auto-reply is stored auto_reply and changes nothing about the conversation', async () => {
      const [queued] = await db
        .insert(schema.touches)
        .values({ orgId, companyId, contactId, campaignId, channel: 'email', direction: 'out', status: 'queued', subject: 's', body: 'b' })
        .returning()
      const r = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io', subject: 'Automatic reply',
        body: 'I am out of the office until Monday.', autoReply: true, now: NOON,
      })
      expect(r.replyKind).toBe('auto_reply')
      expect(r.paused).toBe(false)
      expect(r.cancelled).toBe(0)
      expect(r.suppressed).toBe(false)
      expect(r.deal).toBeNull()
      expect((await touch(queued!.id)).status).toBe('queued')
      const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      expect(contact!.pausedAt).toBeNull()
      expect(await db.select().from(schema.deals)).toEqual([])
      // The row is still there for the inbox to see.
      expect((await touch(r.touchId)).replyKind).toBe('auto_reply')
    })

    /**
     * Without headers nothing changes: the body regex still SORTS it as an
     * auto-reply, and it still pauses — the words are a hint about what the
     * mail is, never a reason to treat it differently.
     */
    it('without the header flag, an out-of-office body still pauses — a body is never read as automatic', async () => {
      const r = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io', subject: 'Automatic reply',
        body: 'I am out of the office until Monday.', now: NOON,
      })
      expect(r.replyKind).toBe('auto_reply')
      expect(r.paused).toBe(true)
    })
  })
  /**
   * What a mail says about ITSELF — headers and the delivery-status part,
   * never the body (packages/core/src/mail-signals.ts).
   *
   * An auto-reply is recorded and changes nothing about the conversation. A
   * bounce is evidence about an ADDRESS: a column and a refusal, never a
   * suppression row, and only when the report names a message this system
   * sent — anyone can mail the inbox a DSN naming anybody.
   */
  describe('mail signals: auto-replies and bounces', () => {
    const OUR_ID = '<sent-1@agency.test>'
    const MAILER = 'MAILER-DAEMON@mx.rentman.io'

    /** Provider ids shaped like SMTP's, so a DSN can name them. */
    const idProvider = (): MessageProvider & { sent: string[] } => {
      const sent: string[] = []
      return {
        name: 'ids', channels: ['email', 'linkedin'], sent,
        async send(m) {
          sent.push(m.to)
          return { providerId: `<sent-${sent.length}@agency.test>` }
        },
      }
    }
    let ids: ReturnType<typeof idProvider>
    beforeEach(() => {
      ids = idProvider()
    })

    const sendOneMail = (over: Record<string, unknown> = {}) =>
      sendOne(db, ids, { orgId, campaignId, contactId, companyId, subject: 'A gap', body: 'Hello.', now: NOON, ...over })

    const report = (lines: string[]): string =>
      ['Reporting-MTA: dns; mx.rentman.io', '', ...lines, ''].join('\r\n')
    const failed = (status = '5.1.1', recipient = 'priya@rentman.io') =>
      report([`Final-Recipient: rfc822; ${recipient}`, 'Action: failed', `Status: ${status}`])

    /** A DSN the way the IMAP parser hands it over: the report, and the returned copy's Message-ID. */
    const bounceMail = (dsn: string, originalMessageIds: string[] = [OUR_ID], over: Record<string, unknown> = {}) =>
      handleInboundEmail(db, {
        from: MAILER, subject: 'Undelivered Mail Returned to Sender', text: 'I am sorry to inform you…',
        headers: { 'Auto-Submitted': 'auto-replied' }, dsn, originalMessageIds, now: NOON, ...over,
      })

    const contactRow = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!
    const queue = async (over: Record<string, unknown> = {}) =>
      (await db
        .insert(schema.touches)
        .values({ orgId, companyId, contactId, campaignId, channel: 'email', direction: 'out', status: 'queued', subject: 's', body: 'b', ...over })
        .returning())[0]!
    const auditOf = async (action: string) => (await db.select().from(schema.auditLog)).filter((a) => a.action === action)

    describe('an auto-reply, read from its headers', () => {
      it('is logged as an inbound touch of kind auto_reply and changes nothing about the conversation', async () => {
        await sendOneMail()
        const waiting = await queue()
        const outcome = await handleInboundEmail(db, {
          from: 'priya@rentman.io', subject: 'Automatic reply: A gap', text: 'Thanks for your message. I am away until the 21st.',
          references: [OUR_ID], headers: { 'Auto-Submitted': 'auto-replied' }, now: NOON,
        })
        expect(outcome).toMatchObject({ matched: 'message', replyKind: 'auto_reply', paused: false, suppressed: false })
        if (outcome.matched === 'none') return
        expect((await touch(outcome.touchId)).replyKind).toBe('auto_reply')
        expect((await contactRow()).pausedAt).toBeNull()
        expect((await touch(waiting.id)).status).toBe('queued')
        // The deal stays where the SEND put it; an out-of-office is not a reply.
        const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
        expect(deal!.stage).toBe('contacted')
      })

      it('reads Precedence: bulk on a mail matched by address alone', async () => {
        const outcome = await handleInboundEmail(db, {
          from: 'priya@rentman.io', subject: 'Re', text: 'Your message was received.', headers: { Precedence: 'bulk' }, now: NOON,
        })
        expect(outcome).toMatchObject({ matched: 'contact', replyKind: 'auto_reply', paused: false })
      })

      /** RFC 3834: `no` means a person wrote it — and a person's reply pauses. */
      it('treats Auto-Submitted: no as a person, who pauses the sequence', async () => {
        const outcome = await handleInboundEmail(db, {
          from: 'priya@rentman.io', subject: 'Re', text: 'Thursday works.', headers: { 'Auto-Submitted': 'no' }, now: NOON,
        })
        expect(outcome).toMatchObject({ matched: 'contact', paused: true })
      })

      /**
       * THE precedence, through the inbound path this time: the header says
       * automatic, the first line says unsubscribe, and the opt-out wins —
       * suppression row, `opted_out`, paused.
       */
      it('an auto-reply whose first line says unsubscribe still writes the suppression row and is stored opted_out — from the headers too', async () => {
        await sendOneMail()
        const outcome = await handleInboundEmail(db, {
          from: 'priya@rentman.io', subject: 'Automatic reply',
          text: 'Unsubscribe.\nThis mailbox is no longer monitored.',
          references: [OUR_ID], headers: { 'Auto-Submitted': 'auto-replied', Precedence: 'bulk' }, now: NOON,
        })
        expect(outcome).toMatchObject({ matched: 'message', replyKind: 'opted_out', suppressed: true, paused: true })
        const [row] = await db.select().from(schema.suppressions)
        expect(row).toMatchObject({ kind: 'email', value: 'priya@rentman.io', source: 'reply' })
      })
    })

    describe('a permanent bounce', () => {
      it('marks the address with the report’s own code, cancels the email queue, and writes NO suppression', async () => {
        await sendOneMail()
        const queued = await queue()
        const approved = await queue({ status: 'approved', approvedBy: userId, approvedAt: NOON })
        const draft = await queue({ status: 'awaiting_approval' })
        const [li] = await db
          .insert(schema.campaigns)
          .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: false, dailyCap: 10, status: 'active' })
          .returning({ id: schema.campaigns.id })
        const onLinkedIn = await queue({ campaignId: li!.id, channel: 'linkedin' })

        const outcome = await bounceMail(failed())
        expect(outcome).toMatchObject({
          matched: 'none',
          bounce: { orgId, contactId, permanent: true, code: '5.1.1', marked: true },
        })

        const c = await contactRow()
        expect(c.emailBouncedAt?.toISOString()).toBe(NOON.toISOString())
        expect(c.emailBounceCode).toBe('5.1.1')
        // A typo is not a request to be left alone.
        expect(await db.select().from(schema.suppressions)).toEqual([])
        expect(c.pausedAt).toBeNull()
        for (const t of [queued, approved, draft]) {
          expect(await touch(t.id)).toMatchObject({ status: 'refused', refusalCode: 'bounced' })
        }
        // The address that failed is the email one.
        expect((await touch(onLinkedIn.id)).status).toBe('queued')
        // Not a reply: nothing inbound was filed, and the deal did not move to replied.
        expect((await db.select().from(schema.touches)).filter((t) => t.direction === 'in')).toEqual([])
        const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
        expect(deal!.stage).toBe('contacted')

        const [audit] = await auditOf('contact.bounced')
        expect(audit).toMatchObject({ actor: 'system', subjectType: 'contact', subjectId: contactId })
        expect(audit!.detail).toMatchObject({ code: '5.1.1', cancelledQueued: 3 })
        // §2.3: the audit row never names the address.
        expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain('priya@')
      })

      it('matches by the report’s own References, as Gmail and Exchange send them', async () => {
        await sendOneMail()
        const outcome = await bounceMail(failed(), [], { references: [OUR_ID] })
        expect(outcome).toMatchObject({ bounce: { permanent: true, marked: true } })
      })

      it('changes nothing the second time the same report arrives', async () => {
        await sendOneMail()
        await bounceMail(failed())
        const again = await bounceMail(failed('5.1.2'))
        expect(again).toMatchObject({ bounce: { marked: false } })
        expect((await contactRow()).emailBounceCode).toBe('5.1.1')
        expect(await auditOf('contact.bounced')).toHaveLength(1)
      })

      it('is then refused by the send path as bounced, before any provider', async () => {
        await sendOneMail()
        await bounceMail(failed())
        const r = await sendOneMail()
        expect(r.sent).toBe(false)
        expect(r.decision).toMatchObject({ allowed: false, code: 'bounced', humanCanResolve: true })
        expect(ids.sent).toHaveLength(1)
        expect(await touch(r.touchId)).toMatchObject({ status: 'refused', refusalCode: 'bounced' })
      })

      it('refuses an approved message too: approving does not lift it', async () => {
        await sendOneMail()
        await bounceMail(failed())
        const t = await queue({ status: 'approved', approvedBy: userId, approvedAt: NOON })
        const r = await dispatchTouch(db, provider, t, { now: NOON })
        expect(r.decision).toMatchObject({ code: 'bounced' })
        expect(provider.sent).toEqual([])
      })

      /** The fix is a corrected address. That clears the mark, and the next message goes. */
      it('is cleared by changing the address, and only by that', async () => {
        await sendOneMail()
        await bounceMail(failed())

        // The same address in another case is not a change.
        const same = await contactsUpdate(db, orgId, contactId, { email: 'PRIYA@rentman.io' })
        expect(same).toMatchObject({ ok: true, changed: [], bounceCleared: false })
        expect((await contactRow()).emailBouncedAt).not.toBeNull()
        const resumed = await resumeContact(db, orgId, contactId)
        expect(resumed).toBe(true)
        expect((await contactRow()).emailBouncedAt).not.toBeNull()

        const fixed = await contactsUpdate(db, orgId, contactId, { email: 'priya.shah@rentman.io' }, { actor: userId })
        expect(fixed).toMatchObject({ ok: true, changed: ['email'], bounceCleared: true })
        const c = await contactRow()
        expect(c.emailBouncedAt).toBeNull()
        expect(c.emailBounceCode).toBeNull()
        const [cleared] = await auditOf('contact.bounce_cleared')
        expect(cleared).toMatchObject({ actor: userId, subjectId: contactId, detail: { code: '5.1.1' } })
        expect(JSON.stringify(cleared)).not.toContain('priya')

        const next = await sendOneMail()
        expect(next.sent).toBe(true)
        expect(ids.sent.at(-1)).toBe('priya.shah@rentman.io')
      })

      /** A report about the address somebody already corrected is about an address this contact no longer has. */
      it('does not mark a contact whose address changed after the message went', async () => {
        await sendOneMail()
        await contactsUpdate(db, orgId, contactId, { email: 'priya.shah@rentman.io' })
        const outcome = await bounceMail(failed())
        expect(outcome).toMatchObject({ matched: 'none' })
        expect(outcome.matched === 'none' && outcome.bounce).toBeFalsy()
        expect((await contactRow()).emailBouncedAt).toBeNull()
        const [audit] = await auditOf('contact.bounce_unmatched')
        expect(audit!.detail).toMatchObject({ why: 'address_changed', code: '5.1.1' })
      })

      it('reads the facts only for email: the same person is still sendable on LinkedIn', async () => {
        await outreachRecordBounce(db, { orgId, contactId, code: '5.1.1', now: NOON })
        await db.update(schema.contacts).set({ linkedinUrl: 'https://linkedin.com/in/priya' }).where(eq(schema.contacts.id, contactId))
        const [li] = await db
          .insert(schema.campaigns)
          .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: true, dailyCap: 10, status: 'active' })
          .returning({ id: schema.campaigns.id })
        const email = await sendFactsFor(db, { orgId, campaignId, contactId, approvedByHuman: false, now: NOON })
        const linkedin = await sendFactsFor(db, { orgId, campaignId: li!.id, contactId, approvedByHuman: false, now: NOON })
        if ('missing' in email || 'missing' in linkedin) throw new Error('missing')
        expect(email.facts.recipientBounced).toBe(true)
        expect(linkedin.facts.recipientBounced).toBe(false)
      })

      it('refuses to mark with a code that is not an RFC 3463 status — the code is the evidence', async () => {
        for (const code of ['', 'bounced', '550', '2.0.0']) {
          expect(await outreachRecordBounce(db, { orgId, contactId, code, now: NOON }), code).toEqual({ marked: false, cancelled: 0 })
        }
        expect((await contactRow()).emailBouncedAt).toBeNull()
      })
    })

    describe('a bounce that is not acted on', () => {
      it('records a transient failure in the audit log and nothing else', async () => {
        await sendOneMail()
        const waiting = await queue()
        const outcome = await bounceMail(failed('4.2.2'))
        expect(outcome).toMatchObject({ matched: 'none', bounce: { permanent: false, code: '4.2.2', marked: false } })
        expect((await contactRow()).emailBouncedAt).toBeNull()
        expect((await touch(waiting.id)).status).toBe('queued')
        const [audit] = await auditOf('contact.bounce_transient')
        expect(audit).toMatchObject({ subjectId: contactId, detail: { code: '4.2.2' } })
        expect(await auditOf('contact.bounced')).toEqual([])
      })

      /**
       * §2.2, and the reason the Message-ID gate exists: a well-formed DSN
       * naming a real contact, mailed in by anybody. It names no message
       * this system sent, so it changes nobody.
       */
      it('ignores a forged report that names no message this system sent', async () => {
        await sendOneMail()
        for (const forged of [
          () => bounceMail(failed(), ['<forged@evil.test>']),
          () => bounceMail(failed(), []),
          () => handleInboundEmail(db, { from: 'priya@rentman.io', subject: 'x', text: 'x', dsn: failed(), now: NOON }),
        ]) {
          const outcome = await forged()
          expect(outcome).toMatchObject({ matched: 'none' })
          expect(outcome.matched === 'none' && outcome.bounce).toBeFalsy()
        }
        expect((await contactRow()).emailBouncedAt).toBeNull()
        expect((await contactRow()).pausedAt).toBeNull()
        expect((await db.select().from(schema.auditLog)).filter((a) => a.action.startsWith('contact.bounce'))).toEqual([])
        expect((await db.select().from(schema.touches)).filter((t) => t.direction === 'in')).toEqual([])
      })

      it('audits, and does not act on, a report whose address is not the one the message went to', async () => {
        await sendOneMail()
        const outcome = await bounceMail(failed('5.1.1', 'someone.else@rentman.io'))
        expect(outcome).toMatchObject({ matched: 'none' })
        expect((await contactRow()).emailBouncedAt).toBeNull()
        const [audit] = await auditOf('contact.bounce_unmatched')
        expect(audit).toMatchObject({ subjectId: contactId, detail: { why: 'recipient_mismatch', code: '5.1.1' } })
        expect(JSON.stringify(audit)).not.toContain('someone.else')
      })

      it('does not act on a report that names no recipient', async () => {
        await sendOneMail()
        await bounceMail(report(['Action: failed', 'Status: 5.1.1']))
        expect((await contactRow()).emailBouncedAt).toBeNull()
        expect((await auditOf('contact.bounce_unmatched'))[0]!.detail).toMatchObject({ why: 'no_recipient' })
      })

      /**
       * Before this, a delivery report from a server that sets References was
       * filed as the contact REPLYING. A report is never a reply.
       */
      it('files a delayed report as nothing at all — not a reply, not a bounce', async () => {
        await sendOneMail()
        const outcome = await bounceMail(report(['Final-Recipient: rfc822; priya@rentman.io', 'Action: delayed', 'Status: 4.4.7']), [], {
          references: [OUR_ID],
        })
        expect(outcome).toMatchObject({ matched: 'none' })
        if (outcome.matched === 'none') expect(outcome.why).toContain('delayed')
        expect((await db.select().from(schema.touches)).filter((t) => t.direction === 'in')).toEqual([])
        expect((await contactRow()).pausedAt).toBeNull()
      })
    })

    /** Without headers or a DSN, every inbound path is exactly what it was. */
    it('behaves as before when a caller passes neither headers nor a DSN', async () => {
      await sendOneMail()
      const outcome = await handleInboundEmail(db, {
        from: 'priya@rentman.io', subject: 'Re', text: 'I am out of the office until Monday.', references: [OUR_ID], now: NOON,
      })
      // The body sorts it as an auto-reply; without the header it still pauses.
      expect(outcome).toMatchObject({ matched: 'message', replyKind: 'auto_reply', paused: true })
    })
  })
})
