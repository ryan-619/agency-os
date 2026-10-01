/**
 * The inbox, against a real engine (PROMPT.md §8.4, §2.1).
 *
 * The replies here arrive the way real ones do — through `handleInboundEmail`
 * and `recordInboundReply` — so the rows the inbox reads are the rows the
 * product writes: paused, classified, with a deal moved and, for an opt-out,
 * a suppression. Only the grouping-order test inserts rows by hand, because
 * it needs one of every kind and a clock it controls.
 *
 * The answer is followed all the way to the wire: drafted here, approved the
 * way /approvals approves it, and dispatched through the ONE send path with a
 * provider that counts rather than sends and records the headers it was
 * handed. That is the end-to-end proof of wave 1's threading: the answer's
 * In-Reply-To is the reply's own Message-ID.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import {
  approveDraft, denyDraft, dispatchTouch, handleInboundEmail, inboxKindFilter, inboxTouches,
  inboxUnhandledCount, isCheckViolation, pauseReasonClass, recordInboundReply, recordInboundSms, replyMarkHandled,
  replyQueueDraft, replyReclassify, schema, type AgencyDb, type MessageProvider, type ReplyHumanKind,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { throughTransactions } from './fault-db.js'

/** Counts, never sends, and keeps the headers each send carried. */
function countingProvider(): MessageProvider & {
  sent: { to: string; subject: string }[]
  headersSeen: (Readonly<Record<string, string>> | undefined)[]
} {
  const sent: { to: string; subject: string }[] = []
  const headersSeen: (Readonly<Record<string, string>> | undefined)[] = []
  return {
    name: 'test',
    channels: ['email', 'linkedin'],
    sent,
    headersSeen,
    async send(m) {
      sent.push({ to: m.to, subject: m.subject })
      headersSeen.push(m.headers)
      return { providerId: `<sent-${sent.length}@agency.test>` }
    },
  }
}

/** Midday UTC on a Tuesday: 13:00 in London. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
/** 00:30 in London — inside the default 21:00–08:00 quiet window. */
const NIGHT = new Date('2026-09-15T23:30:00.000Z')

const OUR_MESSAGE_ID = '<first-touch@agency.test>'
const THEIR_MESSAGE_ID = '<reply-1@rentman.io>'
const ANSWER_SUBJECT = 'Re: the gap on your security page'
const ANSWER_BODY = 'Thanks Priya — Thursday at 14:00 works on our side.'
const REPLY_BODY = 'Sounds good, tell me more about the CSP finding.'

describe('the inbox', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let linkedinCampaignId: string
  let outboundId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', name: 'Olu Owner', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
    const [linkedin] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'LinkedIn follow-ups', channel: 'linkedin', autoSend: false, status: 'active' })
      .returning({ id: schema.campaigns.id })
    linkedinCampaignId = linkedin!.id

    // The message they answer: sent by this system, approved by a person,
    // carrying the Message-ID the provider gave it.
    const [out] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent',
        subject: 'A gap on your security page', body: 'Hello.', recipient: 'priya@rentman.io',
        providerId: OUR_MESSAGE_ID, sentAt: new Date('2026-09-14T10:00:00.000Z'),
        approvedBy: userId, approvedAt: new Date('2026-09-14T09:55:00.000Z'),
      })
      .returning({ id: schema.touches.id })
    outboundId = out!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A reply that arrives the real way, threaded to our message. */
  const reply = async (text = REPLY_BODY, over: { messageId?: string; references?: string[]; from?: string } = {}) => {
    const r = await handleInboundEmail(db, {
      from: over.from ?? 'priya@rentman.io',
      subject: 'Re: A gap on your security page',
      text,
      messageId: over.messageId ?? THEIR_MESSAGE_ID,
      references: over.references ?? [OUR_MESSAGE_ID],
      now: NOON,
    })
    if (r.matched === 'none') throw new Error(`the reply was not matched: ${r.why}`)
    return r.touchId
  }

  const contactRow = async () =>
    (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!

  const answersTo = async (inboundId: string) =>
    db.select().from(schema.touches).where(eq(schema.touches.answersTouchId, inboundId))

  const auditActions = async () => (await db.select().from(schema.auditLog)).map((a) => a.action)

  const draft = (inboundTouchId: string, over: Partial<Parameters<typeof replyQueueDraft>[1]> = {}) =>
    replyQueueDraft(db, {
      orgId, inboundTouchId, subject: ANSWER_SUBJECT, body: ANSWER_BODY, actor: userId, now: NOON, ...over,
    })

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  describe('inboxTouches', () => {
    it('shows a reply with the message it answered, the company, the open deal and the pause', async () => {
      const id = await reply()
      const rows = await inboxTouches(db, orgId)
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.touch.id).toBe(id)
      expect(row.touch.replyKind).toBe('interested')
      expect(row.touch.body).toBe(REPLY_BODY)
      expect(row.parent).toEqual({
        id: outboundId,
        subject: 'A gap on your security page',
        sentAt: new Date('2026-09-14T10:00:00.000Z'),
        approvedBy: { id: userId, email: 'owner@agency.test', name: 'Olu Owner' },
        campaignId,
        campaignName: 'Q4 security gaps',
      })
      expect(row.company).toMatchObject({ id: companyId, domain: 'rentman.io', timeZone: 'Europe/London' })
      expect(row.contact).toMatchObject({ id: contactId, firstName: 'Priya', email: 'priya@rentman.io' })
      // The reply paused them and moved the deal forward (recordInboundReply).
      expect(row.contact?.pausedAt).not.toBeNull()
      expect(row.dealStage).toBe('replied')
      expect(row.suppressed).toBe(false)
      expect(row.handledBy).toBeNull()
      expect(row.answered).toBeNull()
    })

    it('says a reply matched by address has no parent', async () => {
      await reply(REPLY_BODY, { references: [] })
      const [row] = await inboxTouches(db, orgId)
      expect(row!.parent).toBeNull()
      expect(row!.touch.inReplyTo).toBeNull()
    })

    it('never shows an outbound message', async () => {
      expect(await inboxTouches(db, orgId)).toEqual([])
      expect(await inboxUnhandledCount(db, orgId)).toBe(0)
    })

    /**
     * Unclassified first — nobody has looked — then the kinds in triage
     * order, opted_out last; newest first inside a kind. The same order
     * decides which rows survive the limit.
     */
    it('groups unclassified first, then interested … opted_out, newest first within a kind', async () => {
      const at = (minute: number) => new Date(Date.UTC(2026, 8, 15, 12, minute))
      const kinds: [string | null, number][] = [
        ['opted_out', 1], ['auto_reply', 2], ['other', 3], ['not_now', 4], ['wrong_person', 5],
        ['interested', 6], [null, 7], ['interested', 8], [null, 9],
      ]
      for (const [kind, minute] of kinds) {
        await db.insert(schema.touches).values({
          orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied',
          subject: `m${minute}`, replyKind: kind, createdAt: at(minute),
        })
      }
      const rows = await inboxTouches(db, orgId)
      expect(rows.map((r) => [r.touch.replyKind, r.touch.subject])).toEqual([
        [null, 'm9'], [null, 'm7'],
        ['interested', 'm8'], ['interested', 'm6'],
        ['wrong_person', 'm5'], ['not_now', 'm4'], ['other', 'm3'], ['auto_reply', 'm2'], ['opted_out', 'm1'],
      ])

      // The limit keeps the urgent ones.
      const top = await inboxTouches(db, orgId, { limit: 3 })
      expect(top.map((r) => r.touch.subject)).toEqual(['m9', 'm7', 'm8'])

      // A filter, including the one for rows nobody classified.
      expect((await inboxTouches(db, orgId, { kind: 'unclassified' })).map((r) => r.touch.subject)).toEqual(['m9', 'm7'])
      expect((await inboxTouches(db, orgId, { kind: 'not_now' })).map((r) => r.touch.subject)).toEqual(['m4'])
    })

    it('reads a kind filter off a query string without trusting it', () => {
      expect(inboxKindFilter('unclassified')).toBe('unclassified')
      expect(inboxKindFilter('opted_out')).toBe('opted_out')
      expect(inboxKindFilter('interested')).toBe('interested')
      expect(inboxKindFilter("interested' OR 1=1")).toBeNull()
      expect(inboxKindFilter(undefined)).toBeNull()
    })

    it('marks a reply whose address is suppressed, by the reply’s own From as well as the address on file', async () => {
      await reply('Please stop', { from: 'priya.personal@example.org', references: [OUR_MESSAGE_ID] })
      const [row] = await inboxTouches(db, orgId)
      expect(row!.touch.replyKind).toBe('opted_out')
      // recordInboundReply suppressed the From address, not the one on file.
      expect(row!.contact?.email).toBe('priya@rentman.io')
      expect(row!.suppressed).toBe(true)
    })

    it('never includes another org’s replies', async () => {
      await reply()
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      expect(await inboxTouches(db, other!.id)).toEqual([])
      expect(await inboxUnhandledCount(db, other!.id)).toBe(0)
      expect(await inboxUnhandledCount(db, orgId)).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Handled
  // -------------------------------------------------------------------------

  describe('replyMarkHandled', () => {
    it('names who handled it and when, once', async () => {
      const id = await reply()
      expect(await replyMarkHandled(db, { orgId, touchId: id, userId, now: NOON })).toEqual({ ok: true })
      const [row] = await inboxTouches(db, orgId)
      expect(row!.touch.handledAt).toEqual(NOON)
      expect(row!.handledBy).toEqual({ id: userId, email: 'owner@agency.test', name: 'Olu Owner' })
      expect(await inboxUnhandledCount(db, orgId)).toBe(0)
      expect(await inboxTouches(db, orgId, { unhandledOnly: true })).toEqual([])

      // The second click is told, not shown a 500.
      expect(await replyMarkHandled(db, { orgId, touchId: id, userId })).toEqual({ ok: false, reason: 'already_handled' })
      expect(await auditActions()).toContain('reply.handled')
    })

    it('refuses an outbound message — in the predicate, and in the CHECK behind it', async () => {
      expect(await replyMarkHandled(db, { orgId, touchId: outboundId, userId })).toEqual({ ok: false, reason: 'not_found' })
      const err = await db
        .update(schema.touches)
        .set({ handledAt: NOON, handledBy: userId })
        .where(eq(schema.touches.id, outboundId))
        .then(() => null, (e: unknown) => e)
      expect(isCheckViolation(err, 'touches_handled_is_inbound_only')).toBe(true)
    })

    it('refuses a user or a reply from another org', async () => {
      const id = await reply()
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      const [stranger] = await db
        .insert(schema.users)
        .values({ orgId: other!.id, email: 'someone@other.test', role: 'owner' })
        .returning({ id: schema.users.id })
      expect(await replyMarkHandled(db, { orgId, touchId: id, userId: stranger!.id })).toEqual({ ok: false, reason: 'not_found' })
      expect(await replyMarkHandled(db, { orgId: other!.id, touchId: id, userId: stranger!.id })).toEqual({
        ok: false, reason: 'not_found',
      })
      expect(await inboxUnhandledCount(db, orgId)).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Reclassify
  // -------------------------------------------------------------------------

  describe('replyReclassify', () => {
    it('moves a reply among the five kinds a person may choose, and audits from and to', async () => {
      const id = await reply()
      expect(await replyReclassify(db, { orgId, touchId: id, kind: 'not_now', actor: userId })).toEqual({
        ok: true, from: 'interested', paused: false, cancelled: 0,
      })
      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
      expect(row!.replyKind).toBe('not_now')
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'reply.reclassified'))
      expect(audits).toHaveLength(1)
      expect(audits[0]!.detail).toEqual({ from: 'interested', to: 'not_now', paused: false, cancelledQueued: 0 })
      expect(audits[0]!.actor).toBe(userId)
    })

    it('reports an unclassified reply as coming from null', async () => {
      const [row] = await db
        .insert(schema.touches)
        .values({ orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', replyKind: null })
        .returning({ id: schema.touches.id })
      expect(await replyReclassify(db, { orgId, touchId: row!.id, kind: 'other', actor: userId })).toEqual({
        ok: true, from: null, paused: false, cancelled: 0,
      })
    })

    /**
     * The kind column is not the only record of an opt-out. A reply from a
     * suppressed person keeps its kind, and so does an UNCLASSIFIED one — every
     * reply before 0017 — whose own words read as a stop: its NULL means
     * "never classified", and relabelling it `interested` would be a second,
     * contradicting claim about a reply that asked to be left alone.
     */
    it('keeps the kind of a reply from somebody on the suppression list, by address or by the From', async () => {
      const id = await reply()
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'unsubscribed' })
      expect(await replyReclassify(db, { orgId, touchId: id, kind: 'not_now', actor: userId })).toEqual({
        ok: false, reason: 'suppressed',
      })
      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
      expect(row!.replyKind).toBe('interested')
      expect(await auditActions()).not.toContain('reply.reclassified')

      const other = await reply(REPLY_BODY, { from: 'priya.personal@example.org', messageId: '<reply-2@example.org>' })
      await db.insert(schema.suppressions).values({ orgId, kind: 'domain', value: 'example.org', reason: 'asked by their CISO' })
      expect(await replyReclassify(db, { orgId, touchId: other, kind: 'other', actor: userId })).toMatchObject({
        ok: false, reason: 'suppressed',
      })
    })

    it('keeps the kind of an unclassified reply whose own words read as an opt-out', async () => {
      const [row] = await db
        .insert(schema.touches)
        .values({
          orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', replyKind: null,
          body: 'Please remove me', recipient: 'priya@rentman.io',
        })
        .returning({ id: schema.touches.id })
      expect(await replyReclassify(db, { orgId, touchId: row!.id, kind: 'interested', actor: userId })).toEqual({
        ok: false, reason: 'reads_as_opt_out',
      })
      const [after] = await db.select().from(schema.touches).where(eq(schema.touches.id, row!.id))
      expect(after!.replyKind).toBeNull()
    })

    /**
     * A genuine auto-reply pauses nobody (`recordInboundReply`). A person who
     * reads it and says it was a human's is correcting that, so the move does
     * what the reply would have done: the pause, with the reason a reply
     * writes — so answering it later resumes them — and the cancel.
     */
    it('moving a reply off auto_reply pauses the person and cancels what was queued, as a reply would', async () => {
      const recorded = await recordInboundReply(db, {
        orgId, contactId, channel: 'email', from: 'priya@rentman.io', subject: 'Out of office',
        body: 'I am away until Monday.', autoReply: true, now: NOON,
      })
      expect(recorded).toMatchObject({ replyKind: 'auto_reply', paused: false })
      expect((await contactRow()).pausedAt).toBeNull()
      const [queued] = await db
        .insert(schema.touches)
        .values({
          orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'approved',
          subject: 'A follow-up', body: 'Hello again.', approvedBy: userId, approvedAt: NOON,
        })
        .returning({ id: schema.touches.id })

      const later = new Date(NOON.getTime() + 3_600_000)
      const r = await replyReclassify(db, { orgId, touchId: recorded.touchId, kind: 'interested', actor: userId, now: later })
      expect(r).toEqual({ ok: true, from: 'auto_reply', paused: true, cancelled: 1 })
      const c = await contactRow()
      expect(c.pausedAt).toEqual(later)
      expect(c.pausedReason).toBe(`replied ${NOON.toISOString()}`)
      expect(pauseReasonClass(c.pausedReason)).toBe('replied')
      const [cancelled] = await db.select().from(schema.touches).where(eq(schema.touches.id, queued!.id))
      expect(cancelled).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
      const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'reply.reclassified'))
      expect(audit!.detail).toEqual({ from: 'auto_reply', to: 'interested', paused: true, cancelledQueued: 1 })

      // And because the pause is a reply's, answering the reply ends it.
      const answered = await draft(recorded.touchId, { campaignId })
      expect(answered).toMatchObject({ ok: true, resumed: true })
    })

    it('a move between two human kinds pauses nobody', async () => {
      const id = await reply()
      await db.update(schema.contacts).set({ pausedAt: null, pausedReason: null }).where(eq(schema.contacts.id, contactId))
      expect(await replyReclassify(db, { orgId, touchId: id, kind: 'other', actor: userId })).toMatchObject({
        ok: true, paused: false, cancelled: 0,
      })
      expect((await contactRow()).pausedAt).toBeNull()
    })

    it('never clears an opt-out', async () => {
      const id = await reply('unsubscribe')
      const r = await replyReclassify(db, { orgId, touchId: id, kind: 'interested', actor: userId })
      expect(r).toEqual({ ok: false, reason: 'opt_out_is_not_a_choice' })
      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
      expect(row!.replyKind).toBe('opted_out')
      expect(await auditActions()).not.toContain('reply.reclassified')
    })

    it('never sets one, even from a caller that cast past the type', async () => {
      const id = await reply()
      const r = await replyReclassify(db, {
        orgId, touchId: id, kind: 'opted_out' as unknown as ReplyHumanKind, actor: userId,
      })
      expect(r).toEqual({ ok: false, reason: 'opt_out_is_not_a_choice' })
      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
      expect(row!.replyKind).toBe('interested')
      expect(await auditActions()).not.toContain('reply.reclassified')
    })

    it('refuses an outbound row and another org', async () => {
      const id = await reply()
      expect(await replyReclassify(db, { orgId, touchId: outboundId, kind: 'other', actor: userId })).toEqual({
        ok: false, reason: 'not_found',
      })
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      expect(await replyReclassify(db, { orgId: other!.id, touchId: id, kind: 'other', actor: userId })).toEqual({
        ok: false, reason: 'not_found',
      })
    })
  })

  // -------------------------------------------------------------------------
  // Answer
  // -------------------------------------------------------------------------

  /**
   * 0019's handoff: an SMS or WhatsApp answer must be a registered template,
   * and 0019's CHECK refuses a free-text outbound row on either channel — so
   * without the guard, answering a text from /inbox was a 500 (nothing
   * written, but no sentence). Now it is a refusal that names the way that
   * works, and it writes nothing: no draft, no resume, no audit row.
   */
  describe('replyQueueDraft on a template channel (0019)', () => {
    const PHONE = '+919876543210'
    let smsCampaignId: string

    beforeEach(async () => {
      await db.update(schema.contacts).set({ phone: PHONE }).where(eq(schema.contacts.id, contactId))
      const [sms] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Opted-in SMS', channel: 'sms', autoSend: false, status: 'active' })
        .returning({ id: schema.campaigns.id })
      smsCampaignId = sms!.id
    })

    const text = async (body: string, providerMessageId: string) => {
      const r = await recordInboundSms(db, { from: PHONE, text: body, providerMessageId, receivedAt: NOON, orgId })
      if (r.matched !== 'contact') throw new Error(`the text was not matched: ${r.why}`)
      return r.touchId
    }

    it('refuses to answer an SMS with free text, names Draft SMS, and writes nothing', async () => {
      const id = await text('Yes, call me on Thursday', 'mo-1')
      const before = await auditActions()
      for (const campaign of [undefined, smsCampaignId]) {
        const r = await draft(id, campaign ? { campaignId: campaign } : {})
        expect(r).toEqual({
          ok: false,
          reason: 'template_required',
          message:
            'This reply came by SMS, and under DLT an answer must be a registered template, not free text. Use Draft SMS ' +
            'on this contact on /contacts, which drafts from an active template. Nothing was drafted and nobody was resumed.',
        })
      }
      expect(await answersTo(id)).toEqual([])
      // Their reply paused them; refusing to draft leaves the pause where it was.
      expect((await contactRow()).pausedAt).not.toBeNull()
      expect(await auditActions()).toEqual(before)
    })

    it('answers an SMS that asked to stop as an opt-out, never as "use Draft SMS"', async () => {
      const id = await text('STOP', 'mo-2')
      const r = await draft(id, { campaignId: smsCampaignId })
      expect(r).toMatchObject({ ok: false, reason: 'opted_out' })
      expect(await answersTo(id)).toEqual([])
    })

    it('refuses a WhatsApp reply too, and says sending WhatsApp is not available', async () => {
      const [row] = await db
        .insert(schema.touches)
        .values({
          orgId, contactId, companyId, channel: 'whatsapp', direction: 'in', status: 'replied',
          body: 'Interested', recipient: PHONE, replyKind: 'interested',
        })
        .returning({ id: schema.touches.id })
      const r = await draft(row!.id)
      expect(r).toMatchObject({ ok: false, reason: 'template_required' })
      if (r.ok) return
      expect(r.message).toContain('sending WhatsApp is not available yet')
      expect(await answersTo(row!.id)).toEqual([])
    })

    it('leaves an email reply exactly as it was', async () => {
      const id = await reply()
      expect(await draft(id)).toMatchObject({ ok: true })
    })
  })

  describe('replyQueueDraft', () => {
    it('parks an awaiting_approval answer naming the reply, under the parent’s campaign, and no in_reply_to', async () => {
      const id = await reply()
      const r = await draft(id)
      expect(r).toMatchObject({ ok: true, resumed: true, wouldHold: null })
      if (!r.ok) throw new Error('unreachable')

      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, r.touchId))
      expect(row).toMatchObject({
        orgId, contactId, companyId, campaignId, channel: 'email', direction: 'out', status: 'awaiting_approval',
        subject: ANSWER_SUBJECT, body: ANSWER_BODY, answersTouchId: id, inReplyTo: null,
        approvedBy: null, sentAt: null, providerId: null,
      })

      const [inbox] = await inboxTouches(db, orgId)
      expect(inbox!.answered).toEqual({ touchId: r.touchId, status: 'awaiting_approval' })
    })

    it('resumes the person their reply paused, and says why in the audit log', async () => {
      const id = await reply()
      expect((await contactRow()).pausedAt).not.toBeNull()
      await draft(id)
      const c = await contactRow()
      expect(c.pausedAt).toBeNull()
      expect(c.pausedReason).toBeNull()

      const [resumed] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, 'contact.resumed'), eq(schema.auditLog.subjectId, contactId)))
      expect(resumed!.actor).toBe(userId)
      // The pause's CLASS, never its text: a reason can carry a teammate's
      // address and the contact's words, and this log outlives an erasure.
      expect(resumed!.detail).toEqual({
        reason: 'answering their reply from the inbox', inboundTouchId: id, pausedFor: 'replied',
      })
      expect(JSON.stringify(resumed!.detail)).not.toContain('replied 20')
      expect(await auditActions()).toContain('reply.answer_drafted')
    })

    /**
     * Answering ends only the pause the reply caused. A pause somebody else
     * put on them — a teammate, or a failure path that paused them because
     * an opt-out could not be recorded — is refused, and stays exactly as it
     * was, reason included.
     */
    describe('ends only the pause the reply caused', () => {
      for (const reason of [
        'asked us to hold until Q1 (by sam@agency.test)',
        'replied on the phone, wants no email (by sam@agency.test)',
        'erasure requested 2026-09-15; not completed (unreadable_phone)',
        'unsubscribed 2026-09-15T11:00:00.000Z',
      ]) {
        it(`refuses a person paused "${reason.slice(0, 32)}…"`, async () => {
          const id = await reply()
          await db.update(schema.contacts).set({ pausedReason: reason }).where(eq(schema.contacts.id, contactId))
          const before = await contactRow()

          const r = await draft(id)
          expect(r).toMatchObject({ ok: false, reason: 'paused_for_another_reason' })
          if (r.ok) return
          expect(r.message).toMatch(/\/contacts/)
          expect(await answersTo(id)).toEqual([])
          const after = await contactRow()
          expect(after.pausedAt).toEqual(before.pausedAt)
          expect(after.pausedReason).toBe(reason)
          expect(await auditActions()).not.toContain('contact.resumed')
        })
      }

      it('classes each writer’s reason by its shape', () => {
        expect(pauseReasonClass(`replied ${NOON.toISOString()}`)).toBe('replied')
        expect(pauseReasonClass('replied on the phone (by sam@agency.test)')).toBe('manual')
        expect(pauseReasonClass('unsubscribed 2026-09-15T11:00:00.000Z')).toBe('unsubscribed')
        expect(pauseReasonClass('erasure requested 2026-09-15; not completed (Error)')).toBe('erasure')
        expect(pauseReasonClass('opt-out not recorded: one-click unsubscribe 2026-09-15T11:00:00.000Z (Error)')).toBe(
          'opt_out_not_recorded',
        )
        expect(pauseReasonClass('something else')).toBe('other')
        expect(pauseReasonClass(null)).toBe('other')
      })
    })

    it('takes a chosen campaign for a reply matched by address, and refuses without one', async () => {
      const id = await reply(REPLY_BODY, { references: [] })
      const none = await draft(id)
      expect(none).toMatchObject({ ok: false, reason: 'no_campaign' })
      expect(await answersTo(id)).toEqual([])
      // Nothing written, so nobody was resumed either.
      expect((await contactRow()).pausedAt).not.toBeNull()

      const chosen = await draft(id, { campaignId })
      expect(chosen).toMatchObject({ ok: true })
    })

    it('refuses a campaign on another channel — an answer goes back the way the reply came', async () => {
      const id = await reply()
      const r = await draft(id, { campaignId: linkedinCampaignId })
      expect(r).toMatchObject({ ok: false, reason: 'wrong_channel' })
      expect(await answersTo(id)).toEqual([])
      expect((await contactRow()).pausedAt).not.toBeNull()
    })

    it('refuses a second live answer, but not one after the first was refused', async () => {
      const id = await reply()
      const first = await draft(id)
      expect(first.ok).toBe(true)
      expect(await draft(id)).toMatchObject({ ok: false, reason: 'already_queued' })

      if (!first.ok) throw new Error('unreachable')
      expect(await denyDraft(db, { orgId, touchId: first.touchId, decidedBy: userId, note: 'wrong tone' })).toMatchObject({
        ok: true,
      })
      const again = await draft(id)
      expect(again).toMatchObject({ ok: true })
      const [inbox] = await inboxTouches(db, orgId)
      // The screen shows where the LATEST answer got to.
      expect(inbox!.answered).toEqual({ touchId: again.ok ? again.touchId : '', status: 'awaiting_approval' })
    })

    it('refuses a reply from another org as not found, and writes nothing', async () => {
      const id = await reply()
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      const r = await draft(id, { orgId: other!.id })
      expect(r).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await answersTo(id)).toEqual([])
      expect((await contactRow()).pausedAt).not.toBeNull()
    })

    it('refuses to answer an outbound row', async () => {
      expect(await draft(outboundId)).toMatchObject({ ok: false, reason: 'not_found' })
    })

    /**
     * §2.1: "an approver offered enough impossible things learns to click
     * yes." A reply that asked to stop is never answered, and the person is
     * never un-paused on the way to finding that out.
     */
    describe('never answers somebody who asked to stop', () => {
      it('refuses a reply whose kind is opted_out, and leaves the pause where it was', async () => {
        const id = await reply('Unsubscribe me')
        const before = (await contactRow()).pausedAt
        expect(before).not.toBeNull()

        const r = await draft(id)
        expect(r).toMatchObject({ ok: false, reason: 'opted_out' })
        expect(await answersTo(id)).toEqual([])
        expect((await contactRow()).pausedAt).toEqual(before)
        const actions = await auditActions()
        expect(actions).not.toContain('contact.resumed')
        expect(actions).not.toContain('reply.answer_drafted')
      })

      it('refuses a person whose address is suppressed, by domain as well as address', async () => {
        const id = await reply()
        await db.insert(schema.suppressions).values({ orgId, kind: 'domain', value: 'rentman.io', reason: 'asked by their CISO' })
        const before = (await contactRow()).pausedAt

        const r = await draft(id)
        expect(r).toMatchObject({ ok: false, reason: 'opted_out' })
        expect(await answersTo(id)).toEqual([])
        expect((await contactRow()).pausedAt).toEqual(before)
        expect(await auditActions()).not.toContain('contact.resumed')
      })

      it('refuses when only the address the reply came from is suppressed', async () => {
        const id = await reply(REPLY_BODY, { from: 'priya.personal@example.org' })
        await db.insert(schema.suppressions).values({
          orgId, kind: 'email', value: 'priya.personal@example.org', reason: 'unsubscribed',
        })
        expect(await draft(id)).toMatchObject({ ok: false, reason: 'opted_out' })
        expect((await contactRow()).pausedAt).not.toBeNull()
      })

      /**
       * An opt-out that FAILED to record leaves no suppression row — only
       * the audit row that says so. Nothing else stands between that person
       * and an answer, so it is refused however old the row is.
       */
      for (const [action, subject] of [
        ['unsubscribe.not_recorded', 'touch'],
        ['contact.erasure_failed', 'contact'],
        ['contact.opt_out_not_recorded', 'contact'],
      ] as const) {
        it(`refuses a person with ${action} on the audit log, however old`, async () => {
          const id = await reply()
          await db.insert(schema.auditLog).values({
            orgId,
            actor: 'system',
            action,
            subjectType: subject,
            subjectId: subject === 'touch' ? outboundId : contactId,
            detail: subject === 'touch' ? { touchId: outboundId, contactId, why: 'Error' } : { why: 'Error' },
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
          })
          const before = (await contactRow()).pausedAt

          const r = await draft(id)
          expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
          expect(await answersTo(id)).toEqual([])
          expect((await contactRow()).pausedAt).toEqual(before)
          expect(await auditActions()).not.toContain('contact.resumed')
        })
      }

      it('is not refused by another contact’s unrecorded opt-out', async () => {
        const id = await reply()
        const [someone] = await db
          .insert(schema.contacts)
          .values({ orgId, companyId, firstName: 'Sam', email: 'sam@rentman.io' })
          .returning({ id: schema.contacts.id })
        await db.insert(schema.auditLog).values({
          orgId, actor: 'system', action: 'unsubscribe.not_recorded', subjectType: 'touch', subjectId: outboundId,
          detail: { touchId: outboundId, contactId: someone!.id, why: 'Error' },
        })
        expect(await draft(id)).toMatchObject({ ok: true })
      })

      /**
       * The review's probe. A fault fails the suppression AND the audit row
       * that would have said so — that write is `.catch(() => {})` — so the
       * log alone leaves the hold nothing to find. Two things stop the answer
       * now: the pause says `opt-out not recorded`, and the hold reads the
       * opted_out reply itself against the suppression list, as the
       * compliance page does. Before, a later "why are you still writing?"
       * resumed them and drafted an answer.
       */
      it('refuses an answer to a later reply when an earlier opt-out and its audit row both failed to write', async () => {
        // Through every transaction: the reply's writes are one, with the
        // suppression and the audit rows in savepoints inside it.
        const faulty = throughTransactions(db, {
          get(target, prop, receiver) {
            if (prop === 'insert') {
              return (table: unknown) => {
                if (table === schema.suppressions || table === schema.auditLog) throw new Error('Connection terminated unexpectedly')
                return (target as AgencyDb).insert(table as typeof schema.touches)
              }
            }
            return Reflect.get(target, prop, receiver)
          },
        })
        const stop = await handleInboundEmail(faulty, {
          from: 'priya@rentman.io', subject: 'Re: A gap on your security page', text: 'Unsubscribe',
          messageId: '<stop@rentman.io>', references: [OUR_MESSAGE_ID], now: NOON, log: { error: () => {} },
        })
        if (stop.matched === 'none') throw new Error('unmatched')
        expect(stop.optOutNotRecorded).toBe(true)
        expect(await db.select().from(schema.suppressions)).toEqual([])
        expect(await auditActions()).not.toContain('contact.opt_out_not_recorded')
        expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('opt_out_not_recorded')

        const later = await reply('Why are you still writing to me?', { messageId: '<later@rentman.io>' })
        const r = await draft(later)
        expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
        expect(await answersTo(later)).toEqual([])
        expect((await contactRow()).pausedAt).not.toBeNull()
        expect(await auditActions()).not.toContain('contact.resumed')
      })

      /**
       * The hold's second reading on its own: an opted_out reply whose From
       * no suppression row matches, with a reply's own pause and no audit
       * row — the state a failed opt-out left before the pause said so.
       */
      it('refuses a person with an opted_out reply the suppression list does not match, with nothing on the audit log', async () => {
        const [out] = await db
          .insert(schema.touches)
          .values({
            orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', subject: 'Re', body: 'Unsubscribe',
            recipient: 'priya@rentman.io', replyKind: 'opted_out', sentAt: NOON,
          })
          .returning({ id: schema.touches.id })
        expect(out).toBeDefined()
        const later = await reply()
        expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('replied')
        expect(await draft(later)).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
        expect((await contactRow()).pausedAt).not.toBeNull()
      })

      it('is not held by an opted_out reply whose From IS on the suppression list', async () => {
        await db.insert(schema.touches).values({
          orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', subject: 'Re', body: 'Unsubscribe',
          recipient: 'priya.personal@example.org', replyKind: 'opted_out', sentAt: NOON,
        })
        await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya.personal@example.org', reason: 'replied stop', source: 'reply' })
        const later = await reply()
        expect(await draft(later)).toMatchObject({ ok: true, resumed: true })
      })

      it('refuses a person with a recorded refusal of the channel, and rolls the resume back', async () => {
        const id = await reply()
        await db.insert(schema.consents).values({
          orgId, contactId, channel: 'email', granted: false, source: 'said no on a call, 2026-09-01',
        })
        const before = (await contactRow()).pausedAt

        const r = await draft(id)
        expect(r).toMatchObject({ ok: false, reason: 'consent_refused' })
        expect(await answersTo(id)).toEqual([])
        // The resume ran inside the transaction and was undone with the draft.
        expect((await contactRow()).pausedAt).toEqual(before)
        const actions = await auditActions()
        expect(actions).not.toContain('contact.resumed')
        expect(actions).not.toContain('reply.answer_drafted')
      })
    })

    it('drafts an answer the rules would hold right now, and says what would hold it', async () => {
      const id = await reply()
      const r = await draft(id, { now: NIGHT })
      expect(r).toMatchObject({ ok: true, wouldHold: { code: 'quiet_hours' } })
    })

    /**
     * Wave 1 threads an answer inside `dispatchTouch`. This proves it end to
     * end: the inbox drafts, a person approves on /approvals, the worker's
     * dispatch re-checks every rule and hands the provider In-Reply-To and
     * References equal to the reply's own Message-ID.
     */
    it('threads under their reply when the approved answer is dispatched', async () => {
      const id = await reply()
      const r = await draft(id)
      if (!r.ok) throw new Error(`not drafted: ${r.reason}`)

      const approved = await approveDraft(db, { orgId, touchId: r.touchId, contactId, campaignId, approvedBy: userId, now: NOON })
      if (!approved.ok) throw new Error(`not approved: ${approved.reason}`)

      const provider = countingProvider()
      const sent = await dispatchTouch(db, provider, approved.touch, { now: NOON })
      expect(sent.sent).toBe(true)
      expect(provider.sent).toEqual([{ to: 'priya@rentman.io', subject: ANSWER_SUBJECT }])
      expect(provider.headersSeen[0]).toMatchObject({ 'In-Reply-To': THEIR_MESSAGE_ID, References: THEIR_MESSAGE_ID })

      const [inbox] = await inboxTouches(db, orgId)
      expect(inbox!.answered).toEqual({ touchId: r.touchId, status: 'sent' })
    })
  })

  /** §2.3: the words of a message are never in an audit row. */
  it('writes no subject and no body into the audit log', async () => {
    const id = await reply()
    await replyReclassify(db, { orgId, touchId: id, kind: 'not_now', actor: userId })
    await draft(id)
    await replyMarkHandled(db, { orgId, touchId: id, userId })
    const dumped = JSON.stringify(await db.select().from(schema.auditLog))
    expect(dumped).toContain('reply.answer_drafted')
    expect(dumped).toContain('reply.handled')
    expect(dumped).not.toContain(ANSWER_SUBJECT)
    expect(dumped).not.toContain(ANSWER_BODY)
    expect(dumped).not.toContain(REPLY_BODY)
    expect(dumped).not.toContain('CSP finding')
  })
})
