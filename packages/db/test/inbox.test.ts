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
  inboxUnhandledCount, isCheckViolation, replyMarkHandled, replyQueueDraft, replyReclassify, schema,
  type AgencyDb, type MessageProvider, type ReplyHumanKind,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

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
        ok: true, from: 'interested',
      })
      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
      expect(row!.replyKind).toBe('not_now')
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'reply.reclassified'))
      expect(audits).toHaveLength(1)
      expect(audits[0]!.detail).toEqual({ from: 'interested', to: 'not_now' })
      expect(audits[0]!.actor).toBe(userId)
    })

    it('reports an unclassified reply as coming from null', async () => {
      const [row] = await db
        .insert(schema.touches)
        .values({ orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', replyKind: null })
        .returning({ id: schema.touches.id })
      expect(await replyReclassify(db, { orgId, touchId: row!.id, kind: 'other', actor: userId })).toEqual({
        ok: true, from: null,
      })
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
      expect(resumed!.detail).toMatchObject({ reason: 'answering their reply from the inbox', inboundTouchId: id })
      expect(await auditActions()).toContain('reply.answer_drafted')
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
