/**
 * An answer to a reply that never goes puts the reply's pause back
 * (PROMPT.md §2.1, §8.4), against a real engine.
 *
 * Review round 4, finding [0]. The inbox resumes a person when an answer to
 * their reply is DRAFTED (`replyQueueDraft`) — /approvals would otherwise
 * refuse the answer itself as `paused`. Round 3 put the reply's pause back
 * when that answer was DENIED, and nowhere else: an answer that failed at
 * the mail server, was refused when it would have been sent, or was
 * cancelled by a bounce left the person resumed with their reply
 * unanswered, and every campaign live for them again (the reviewer's probe
 * 1: an SMTP 451, then a cold opener under a second campaign read
 * `send_now`).
 *
 * Now every writer that settles an answer `failed` or `refused` for good
 * goes through one helper, `repauseForUnansweredReply`, in the settle's own
 * transaction, under the same guard the deny applied: this answer is what
 * resumed them, nobody resumed them since, and no other answer of theirs is
 * on its way. What it never does: re-pause over a deferral the clock
 * resolves (the tick puts that row back and sends it later), and downgrade
 * a stronger stop — an unsubscribe, an opt-out nobody could record, an
 * erasure — to `replied`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import {
  approveDraft, contactPauseByHand, contactResumeByHand, dispatchTouch, erasureErase, handleInboundEmail,
  outreachRecordBounce, pauseContact, pauseReasonClass, previewSend, recordUnsubscribe, replyQueueDraft,
  resumeContact, schema, type AgencyDb, type MessageProvider, type TouchRow,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { failOnce } from './fault-db.js'
import { recoverStuckSends } from '../../../apps/agent/src/boot/reconcile.js'

/** Midday UTC on a Tuesday: 13:00 in London. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
const LATER = new Date('2026-09-15T15:00:00.000Z')
/** 22:30 in London (BST): inside the campaign's 21:00–08:00 quiet hours. */
const NIGHT = new Date('2026-09-15T21:30:00.000Z')
const OUR_MESSAGE_ID = '<first-touch@agency.test>'
const TEAMMATE = 'client CISO – never contact (by sam@agency.test)'
const SILENT = { error() {} }
const QUIET_LOG = { debug() {}, info() {}, warn() {}, error() {} }

function provider(fail = false): MessageProvider & { sent: string[] } {
  const sent: string[] = []
  return {
    name: 'test',
    channels: ['email'],
    sent,
    async send(m) {
      if (fail) throw Object.assign(new Error('451 4.3.0 try again later'), { name: 'SmtpError' })
      sent.push(m.to)
      return { providerId: `<sent-${sent.length}@agency.test>` }
    },
  }
}

describe('an answer to a reply that never goes', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let campaign2Id: string
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
    const campaigns = await db
      .insert(schema.campaigns)
      .values([
        { orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 50, status: 'active', quietStart: '21:00', quietEnd: '08:00' },
        { orgId, name: 'Q1 follow-ups', channel: 'email', autoSend: false, dailyCap: 50, status: 'active', quietStart: '21:00', quietEnd: '08:00' },
      ])
      .returning({ id: schema.campaigns.id })
    campaignId = campaigns[0]!.id
    campaign2Id = campaigns[1]!.id
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

  /** A reply that arrives the real way: it pauses them `replied <instant>`. */
  const reply = async (messageId = '<reply-1@rentman.io>', now = NOON) => {
    const r = await handleInboundEmail(db, {
      from: 'priya@rentman.io',
      subject: 'Re: A gap on your security page',
      text: 'Not now, maybe in the new year.',
      messageId,
      references: [OUR_MESSAGE_ID],
      now,
    })
    if (r.matched === 'none') throw new Error(`the reply was not matched: ${r.why}`)
    return r.touchId
  }
  const contactRow = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!
  const touchRow = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const auditRows = async (action: string) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))

  /** Reply, answer (which resumes them), approve. Returns the reply's pause and the approved answer. */
  const answered = async (): Promise<{ inboundId: string; replied: string; answer: TouchRow }> => {
    const inboundId = await reply()
    const replied = (await contactRow()).pausedReason!
    expect(pauseReasonClass(replied)).toBe('replied')
    const drafted = await replyQueueDraft(db, {
      orgId, inboundTouchId: inboundId, subject: 'Re: the gap', body: 'Happy to wait — talk in January.', actor: userId, now: NOON,
    })
    expect(drafted).toMatchObject({ ok: true, resumed: true })
    if (!drafted.ok) throw new Error('unreachable')
    expect((await contactRow()).pausedAt).toBeNull()
    const approved = await approveDraft(db, { orgId, touchId: drafted.touchId, contactId, campaignId, approvedBy: userId, now: NOON })
    if (!approved.ok) throw new Error(`not approved: ${approved.reason}`)
    return { inboundId, replied, answer: approved.touch }
  }

  /** What the sender's tick does: claim the row `sending`, then dispatch the row as it read it. */
  const send = async (answer: TouchRow, p: MessageProvider, now = LATER) => {
    await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, answer.id))
    return dispatchTouch(db, p, answer, { now })
  }

  /** What a cold opener under ANOTHER campaign would be told now. */
  const coldOpener = async (now = LATER) => previewSend(db, { orgId, contactId, campaignId: campaign2Id, now })

  // -------------------------------------------------------------------------
  // dispatchTouch's settle paths
  // -------------------------------------------------------------------------

  describe('at sending', () => {
    it('an answer the provider refused (probe 1): the reply’s own pause goes back on, and a cold opener is refused', async () => {
      const { replied, answer } = await answered()
      await expect(send(answer, provider(true))).rejects.toThrow(/451/)
      expect((await touchRow(answer.id)).status).toBe('failed')

      const after = await contactRow()
      expect(after.pausedAt).not.toBeNull()
      expect(after.pausedReason).toBe(replied)
      expect(await coldOpener()).toMatchObject({ ok: true, decision: { allowed: false, code: 'paused' } })

      // In the audit log, by what happened — never the deny's sentence, and
      // never the reason's text.
      const [paused] = await auditRows('contact.paused')
      expect(paused).toMatchObject({ actor: 'system', subjectType: 'contact', subjectId: contactId })
      expect(paused!.detail).toEqual({
        reason: 'their reply is unanswered again: the answer to it failed to send',
        alreadyPaused: false,
        answerTouchId: answer.id,
        answerEnded: 'failed',
      })
      expect(JSON.stringify(paused!.detail)).not.toContain('replied 20')
    })

    for (const [label, refuse, code] of [
      [
        'their address bounced after it was approved',
        async (db: AgencyDb, id: string) =>
          db.update(schema.contacts).set({ emailBouncedAt: NOON, emailBounceCode: '5.1.1' }).where(eq(schema.contacts.id, id)),
        'bounced',
      ],
      [
        'nobody knows their timezone any more',
        async (db: AgencyDb, id: string) => {
          await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, id))
          await db.update(schema.companies).set({ timeZone: null })
        },
        'unknown_timezone',
      ],
    ] as const) {
      it(`an answer refused at sending because ${label}: the reply’s pause goes back on`, async () => {
        const { replied, answer } = await answered()
        await refuse(db, contactId)
        const r = await send(answer, provider())
        expect(r).toMatchObject({ sent: false, decision: { allowed: false, code } })
        expect(await touchRow(answer.id)).toMatchObject({ status: 'refused', refusalCode: code })
        expect((await contactRow()).pausedReason).toBe(replied)
        const [paused] = await auditRows('contact.paused')
        expect(paused!.detail).toMatchObject({
          reason: 'their reply is unanswered again: the answer to it was refused at sending',
          answerEnded: 'refused',
        })
      })
    }

    it('an answer with no recipient left (unparseable_recipient): the reply’s pause goes back on', async () => {
      const { replied, answer } = await answered()
      // Approved, then the row lost its contact — the refusal `gatherFacts` writes.
      const r = await dispatchTouch(db, provider(), { ...answer, contactId: null }, { now: LATER })
      expect(r).toMatchObject({ sent: false, decision: { code: 'unparseable_recipient' } })
      expect((await contactRow()).pausedReason).toBe(replied)
    })

    it('an answer held for quiet hours is a deferral, not an ending: nobody is paused', async () => {
      const { answer } = await answered()
      const r = await send(answer, provider(), NIGHT)
      expect(r).toMatchObject({ sent: false, decision: { code: 'quiet_hours' } })
      // The tick puts the row back `approved` with `scheduled_for`, and it
      // goes in the morning — re-pausing here would refuse it then.
      expect((await contactRow()).pausedAt).toBeNull()
      expect(await auditRows('contact.paused')).toEqual([])
    })

    it('an answer refused as suppressed is not re-paused over: the opt-out’s own pause wins', async () => {
      const { answer } = await answered()
      // An unsubscribe click writes the suppression, then its own pause. The
      // answer is refused between the two.
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'one-click', source: 'unsubscribe' })
      expect(await send(answer, provider())).toMatchObject({ sent: false, decision: { code: 'suppressed' } })
      expect((await contactRow()).pausedAt).toBeNull()
      expect(await pauseContact(db, orgId, contactId, `unsubscribed ${LATER.toISOString()}`, LATER)).toBe(true)
      expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('unsubscribed')
    })

    it('an answer that went resumes nobody and pauses nobody', async () => {
      const { answer } = await answered()
      expect(await send(answer, provider())).toMatchObject({ sent: true })
      expect((await contactRow()).pausedAt).toBeNull()
      expect(await auditRows('contact.paused')).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // A stuck-send recovery that guessed wrong
  // -------------------------------------------------------------------------

  /**
   * Review round 5, [12] (probe-r5-dataint). A new worker's
   * `recoverStuckSends` marks a claimed answer `failed` — "may or may not
   * have gone" — and puts the reply's pause back, while the old worker's
   * provider call is still in flight. The provider then accepts, and
   * `dispatchTouch`'s documented correction records the row `sent`. Nothing
   * lifted the re-pause: the person stayed paused under an audit row saying
   * the answer failed to send, and drafting another answer to the reply that
   * WAS answered resumed them again. Now the correction lifts the recovery's
   * own pause, in the same transaction — and only that pause.
   */
  describe('an answer a stuck-send recovery gave up on', () => {
    const BOOT = () => new Date(Date.now() + 60_000)

    /**
     * The old worker's provider: while its call is in flight `before` runs,
     * a new worker recovers, `between` runs, and then it accepts.
     */
    const recoveredInFlight = (
      between: () => Promise<void> = async () => {},
      before: () => Promise<void> = async () => {},
    ): MessageProvider => ({
      name: 'test',
      channels: ['email'],
      async send() {
        await before()
        expect(await recoverStuckSends(db as never, BOOT(), QUIET_LOG)).toBe(1)
        await between()
        return { providerId: '<answer@agency.test>' }
      },
    })

    it('that went after all: the recovery’s re-pause is lifted, and the log says why', async () => {
      const { inboundId, replied, answer } = await answered()
      let mid: string | null = null
      const p = recoveredInFlight(async () => {
        mid = (await contactRow()).pausedReason
      })
      expect(await send(answer, p)).toMatchObject({ sent: true })
      // The recovery did re-pause them while it could not know.
      expect(mid).toBe(replied)

      expect(await touchRow(answer.id)).toMatchObject({ status: 'sent', error: null, providerId: '<answer@agency.test>' })
      const after = await contactRow()
      expect(after.pausedAt).toBeNull()
      expect(after.pausedReason).toBeNull()

      // The recovery's row stays (the log is append-only); the lift sits beside it, naming the answer.
      const [paused] = await auditRows('contact.paused')
      expect(paused!.detail).toMatchObject({ answerTouchId: answer.id, answerEnded: 'failed' })
      const lifted = (await auditRows('contact.resumed')).filter((r) => r.actor === 'system')
      expect(lifted).toHaveLength(1)
      expect(lifted[0]).toMatchObject({ subjectType: 'contact', subjectId: contactId })
      expect(lifted[0]!.detail).toEqual({
        reason: 'the answer to their reply went after all',
        pausedFor: 'replied',
        answerTouchId: answer.id,
      })
      expect(JSON.stringify(lifted[0]!.detail)).not.toContain('replied 20')

      // The reply is answered: answering it again resumes nobody.
      const again = await replyQueueDraft(db, {
        orgId, inboundTouchId: inboundId, subject: 'Re: the gap', body: 'A second answer.', actor: userId, now: LATER,
      })
      expect(again).toMatchObject({ ok: true, resumed: false })
    })

    it('leaves the pause when they replied again meanwhile — that reply is unanswered', async () => {
      const { replied, answer } = await answered()
      expect(await send(answer, recoveredInFlight(async () => void (await reply('<reply-2@rentman.io>', LATER))))).toMatchObject({ sent: true })
      expect(await touchRow(answer.id)).toMatchObject({ status: 'sent' })
      const after = await contactRow()
      expect(after.pausedAt).not.toBeNull()
      expect(after.pausedReason).toBe(replied)
      expect((await auditRows('contact.resumed')).filter((r) => r.actor === 'system')).toEqual([])
    })

    /**
     * Review round 6, [15]. The guard above read only the audit log — rows
     * stamped at or after the recovery's `contact.paused` — and a reply's
     * `contact.replied` row is neither certain nor late enough: it is
     * written best-effort (a caught savepoint), and stamped with `now()`,
     * the reply transaction's START, which can be before the recovery's
     * though the reply committed after it. Either way the lift resumed the
     * person with that reply unanswered (the reviewer's probe, variants A
     * and B). Now the touches decide: an inbound row of theirs, other than
     * the reply answered, stored at or after the answer row, keeps them
     * paused — compared in SQL against the answer's stored `created_at`.
     */
    it('leaves the pause when a reply that landed meanwhile has a log row stamped BEFORE the recovery’s', async () => {
      const { replied, answer } = await answered()
      // The reply's transaction began 3 ms before the recovery's: its row is
      // stamped then, as `now()` stamps it on a real Postgres.
      await test.pg.exec(`
        CREATE FUNCTION stamp_reply_early() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.created_at := (SELECT created_at FROM audit_log WHERE action = 'contact.paused' ORDER BY created_at DESC LIMIT 1)
            - interval '3 milliseconds';
          RETURN NEW;
        END $$;
        CREATE TRIGGER stamp_reply_early BEFORE INSERT ON audit_log
          FOR EACH ROW WHEN (NEW.action = 'contact.replied') EXECUTE FUNCTION stamp_reply_early();
      `)
      let second: string | null = null
      const p = recoveredInFlight(async () => {
        second = await reply('<reply-2@rentman.io>', LATER)
      })
      expect(await send(answer, p)).toMatchObject({ sent: true })
      // The shape the old guard could not see: the second reply's row sits
      // before the recovery's.
      const [repaused] = await auditRows('contact.paused')
      const late = (await auditRows('contact.replied')).filter((r) => r.createdAt < repaused!.createdAt)
      expect(late).toHaveLength(2)
      expect(second).not.toBeNull()

      expect(await touchRow(answer.id)).toMatchObject({ status: 'sent' })
      const after = await contactRow()
      expect(after.pausedAt).not.toBeNull()
      expect(after.pausedReason).toBe(replied)
      expect((await auditRows('contact.resumed')).filter((r) => r.actor === 'system')).toEqual([])
    })

    it('leaves the pause when a reply that landed meanwhile left no log row at all', async () => {
      const { replied, answer } = await answered()
      // The reply's audit write is best-effort: a fault there loses the row
      // and keeps the reply.
      await failOnce(test.pg, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'contact.replied'" })
      let second: string | null = null
      const p = recoveredInFlight(async () => {
        second = await reply('<reply-2@rentman.io>', LATER)
      })
      expect(await send(answer, p)).toMatchObject({ sent: true })
      expect(second).not.toBeNull()
      expect(await touchRow(second!)).toMatchObject({ direction: 'in', contactId })
      // Only the first reply's row is in the log.
      expect(await auditRows('contact.replied')).toHaveLength(1)

      expect(await touchRow(answer.id)).toMatchObject({ status: 'sent' })
      const after = await contactRow()
      expect(after.pausedAt).not.toBeNull()
      expect(after.pausedReason).toBe(replied)
      expect((await auditRows('contact.resumed')).filter((r) => r.actor === 'system')).toEqual([])
    })

    it('a reply from before the answer was drafted does not hold the lift: it was in front of whoever answered', async () => {
      // Two replies, then one answer: the person answering read both, and
      // drafting resumed them. Only a reply stored AFTER the answer is new.
      const inboundId = await reply()
      await reply('<reply-0@rentman.io>', NOON)
      const drafted = await replyQueueDraft(db, {
        orgId, inboundTouchId: inboundId, subject: 'Re: the gap', body: 'Talk in January.', actor: userId, now: NOON,
      })
      if (!drafted.ok) throw new Error(`not drafted: ${drafted.reason}`)
      const approved = await approveDraft(db, { orgId, touchId: drafted.touchId, contactId, campaignId, approvedBy: userId, now: NOON })
      if (!approved.ok) throw new Error(`not approved: ${approved.reason}`)
      expect(await send(approved.touch, recoveredInFlight())).toMatchObject({ sent: true })
      expect((await contactRow()).pausedAt).toBeNull()
      expect((await auditRows('contact.resumed')).filter((r) => r.actor === 'system')).toHaveLength(1)
    })

    it('leaves a teammate’s hold placed meanwhile', async () => {
      const { answer } = await answered()
      const hold = async () => {
        expect(await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: LATER })).toMatchObject({ ok: true })
      }
      expect(await send(answer, recoveredInFlight(hold))).toMatchObject({ sent: true })
      expect((await contactRow()).pausedReason).toBe(TEAMMATE)
      expect((await auditRows('contact.resumed')).filter((r) => r.actor === 'system')).toEqual([])
    })

    it('lifts nothing the recovery did not put on: a teammate’s hold from before it stands', async () => {
      const { answer } = await answered()
      // Held after the send's checks and before the recovery, which then finds them paused and pauses nobody.
      const hold = async () => {
        expect(await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: LATER })).toMatchObject({ ok: true })
      }
      expect(await send(answer, recoveredInFlight(async () => {}, hold))).toMatchObject({ sent: true })
      expect((await contactRow()).pausedReason).toBe(TEAMMATE)
      expect(await auditRows('contact.paused')).toEqual([])
    })

    it('that never reached the provider: the reply stays paused, and the row stops saying it may have gone', async () => {
      const { replied, answer } = await answered()
      await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, answer.id))
      // The new worker recovers BEFORE the old one's checks: they find the pause.
      expect(await recoverStuckSends(db as never, BOOT(), QUIET_LOG)).toBe(1)
      const p = provider()
      expect(await dispatchTouch(db, p, answer, { now: LATER })).toMatchObject({ sent: false, decision: { code: 'paused' } })
      expect(p.sent).toEqual([])
      // It never went. "May or may not have gone … re-approve to send it
      // again" is false of it, and an instruction nobody can follow.
      expect(await touchRow(answer.id)).toMatchObject({ status: 'refused', refusalCode: 'paused', error: null, sentAt: null })
      expect((await contactRow()).pausedReason).toBe(replied)
      expect((await auditRows('contact.resumed')).filter((r) => r.actor === 'system')).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // The cancels
  // -------------------------------------------------------------------------

  describe('cancelled', () => {
    it('by a bounce: the reply’s pause goes back on, in the bounce’s own transaction', async () => {
      const { replied, answer } = await answered()
      const r = await outreachRecordBounce(db, {
        orgId, contactId, code: '5.1.1', address: 'priya@rentman.io', touchId: outboundId, now: LATER,
      })
      expect(r).toEqual({ marked: true, cancelled: 1 })
      expect(await touchRow(answer.id)).toMatchObject({ status: 'refused', refusalCode: 'bounced' })
      expect((await contactRow()).pausedReason).toBe(replied)
      const [paused] = await auditRows('contact.paused')
      expect(paused!.detail).toMatchObject({
        reason: 'their reply is unanswered again: the answer to it was cancelled by a bounce',
        answerEnded: 'bounced',
        answerTouchId: answer.id,
      })
    })

    it('by an unsubscribe: their unsubscribe is the pause, never downgraded to `replied`', async () => {
      const { answer } = await answered()
      const r = await recordUnsubscribe(db, { touchId: outboundId, now: LATER, log: SILENT })
      expect(r).toMatchObject({ ok: true, paused: true, cancelled: 1 })
      expect(await touchRow(answer.id)).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
      expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('unsubscribed')
      expect(await auditRows('contact.paused')).toEqual([])
    })

    it('by an unsubscribe that could not be recorded: the opt-out’s pause stands', async () => {
      const { answer } = await answered()
      await db.update(schema.touches).set({ recipient: null }).where(eq(schema.touches.id, outboundId))
      const r = await recordUnsubscribe(db, { touchId: outboundId, now: LATER, log: SILENT })
      expect(r).toMatchObject({ ok: false, reason: 'not_recorded' })
      expect(await touchRow(answer.id)).toMatchObject({ status: 'refused' })
      expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('opt_out_not_recorded')
    })

    it('by an erasure that did not finish: the erasure’s pause stands, and a later refusal of the answer keeps it', async () => {
      const { answer } = await answered()
      await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
      const r = await erasureErase(db, { orgId, contactId, actor: userId, now: LATER, log: SILENT })
      expect(r).toMatchObject({ ok: false })
      const erasure = (await contactRow()).pausedReason
      expect(pauseReasonClass(erasure)).toBe('erasure')
      // Rolled back whole, so the answer is still approved — and refused when
      // it would be sent, as `paused`. The erasure's reason is what remains.
      expect(await send(answer, provider())).toMatchObject({ sent: false, decision: { code: 'paused' } })
      expect((await contactRow()).pausedReason).toBe(erasure)
    })

    it('by a later reply: that reply’s own pause is the one they carry', async () => {
      const { answer } = await answered()
      await reply('<reply-2@rentman.io>', LATER)
      expect(await touchRow(answer.id)).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
      expect((await contactRow()).pausedReason).toBe(`replied ${LATER.toISOString()}`)
    })
  })

  // -------------------------------------------------------------------------
  // The guard, the same one the deny applies
  // -------------------------------------------------------------------------

  describe('the guard', () => {
    it('does not undo a person’s own Resume since the answer was drafted', async () => {
      const { answer } = await answered()
      await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: NOON })
      const held = await contactRow()
      expect(await contactResumeByHand(db, { orgId, contact: held, expectedReason: held.pausedReason, actor: userId }))
        .toEqual({ ok: true })
      await expect(send(answer, provider(true))).rejects.toThrow()
      expect((await contactRow()).pausedAt).toBeNull()
    })

    it('leaves a teammate’s pause since as it is', async () => {
      const { answer } = await answered()
      await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: NOON })
      await outreachRecordBounce(db, { orgId, contactId, code: '5.1.1', address: 'priya@rentman.io', now: LATER })
      expect((await touchRow(answer.id)).status).toBe('refused')
      expect((await contactRow()).pausedReason).toBe(TEAMMATE)
    })

    it('waits for another answer of theirs that is still on its way', async () => {
      const { inboundId, answer } = await answered()
      await db.insert(schema.touches).values({
        orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval',
        subject: 'Re: the gap', body: 'A second thought.', answersTouchId: inboundId,
      })
      await expect(send(answer, provider(true))).rejects.toThrow()
      expect((await contactRow()).pausedAt).toBeNull()
    })

    it('pauses nobody when drafting the answer did not resume them', async () => {
      const inboundId = await reply()
      await resumeContact(db, orgId, contactId)
      const drafted = await replyQueueDraft(db, {
        orgId, inboundTouchId: inboundId, subject: 'Re: the gap', body: 'Thanks.', actor: userId, now: NOON,
      })
      expect(drafted).toMatchObject({ ok: true, resumed: false })
      if (!drafted.ok) return
      const approved = await approveDraft(db, { orgId, touchId: drafted.touchId, contactId, campaignId, approvedBy: userId, now: NOON })
      if (!approved.ok) throw new Error('unreachable')
      await expect(send(approved.touch, provider(true))).rejects.toThrow()
      expect((await contactRow()).pausedAt).toBeNull()
      expect(await auditRows('contact.paused')).toEqual([])
    })

    it('a cold message that fails pauses nobody', async () => {
      const [cold] = await db
        .insert(schema.touches)
        .values({
          orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'approved',
          subject: 'Hello', body: 'A gap.', approvedBy: userId, approvedAt: NOON,
        })
        .returning()
      await expect(send(cold!, provider(true))).rejects.toThrow()
      expect((await contactRow()).pausedAt).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // One transaction
  // -------------------------------------------------------------------------

  it('settles the answer and puts the pause back together, or neither', async () => {
    const { answer } = await answered()
    const fault = await failOnce(test.pg, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'contact.paused'" })
    const thrown = await send(answer, provider(true)).then(() => null, (err: unknown) => err)
    let cause = thrown as { message?: string; cause?: unknown } | null
    while (cause?.cause) cause = cause.cause as typeof cause
    expect(cause?.message).toBe(fault)
    // Neither landed: the row is still the claim, which the stuck-send
    // recovery turns into `failed` the safe way — never a `failed` row with
    // the person left resumed and no record of why.
    expect((await touchRow(answer.id)).status).toBe('sending')
    expect((await contactRow()).pausedAt).toBeNull()
  })

  it('is one helper, called from every settle of an answer, under a lock on the contact (pinned by source)', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/outreach.ts', import.meta.url)), 'utf8')
    expect(src).toContain('export async function repauseForUnansweredReply(')
    expect(src).not.toContain('async function repauseForDeniedAnswer(')
    const helper = src.slice(src.indexOf('export async function repauseForUnansweredReply('))
    const body = helper.slice(0, helper.indexOf('\n}\n'))
    // The contact is locked before the audit log is read, so a resume in
    // flight is waited for and then seen.
    expect(body.indexOf(".for('update')")).toBeGreaterThan(-1)
    expect(body.indexOf(".for('update')")).toBeLessThan(body.indexOf("'contact.resumed'"))
    // Every settle of a touch goes through `settle`, which calls the helper;
    // the deny and the bounce's cancel call it too.
    const dispatch = src.slice(src.indexOf('export async function dispatchTouch('), src.indexOf('async function settle('))
    expect(dispatch).not.toMatch(/\.update\(schema\.touches\)[\s\S]{0,80}status: '(?:refused|failed)'/)
    expect(src.match(/repauseForUnansweredReply\(tx\b/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
