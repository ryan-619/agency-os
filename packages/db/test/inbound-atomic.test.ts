/**
 * A reply survives a fault and the retry after it (review round 3, finding 1).
 *
 * `recordInboundReply` stored the inbound row, then wrote the kind, the
 * pause, the cancel and the suppression as separate statements. A fault in
 * any of them answered 500, the provider retried — and the retry met the
 * Message-ID dedupe, which answered `duplicate` and wrote nothing. A "Stop"
 * reply was left unclassified, the person unpaused and unsuppressed, and the
 * approved follow-up went on the next tick. The retry built for a database
 * fault was defeated by exactly that fault, and nothing said so.
 *
 * Now the reply and every consequence are ONE transaction: a fault rolls the
 * reply back with them, so the retry is not a duplicate and records it all.
 * The writes that are allowed to fail on their own — the suppression (whose
 * failure is the loud not-recorded path), the deal move and the audit rows —
 * each run in a savepoint, and the last describes below prove each one with
 * a fault the ENGINE raises: a COMMIT after a swallowed failure with no
 * savepoint would silently discard the whole reply (see fault-db.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { handleInboundEmail, pauseReasonClass, schema, type AgencyDb, type InboundLog } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { failOnce, throughTransactions } from './fault-db.js'

const NOON = new Date('2026-09-15T12:00:00.000Z')
const OUR_ID = '<sent-1@agency.test>'

describe('an inbound reply, a fault, and the retry', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let contactId: string
  let followUpId: string
  let lines: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[]
  let log: InboundLog

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    lines = []
    log = { error: (message, fields) => lines.push({ message, fields }) }

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const companyId = company!.id
    const campaignId = campaign!.id
    // What they are answering, and the follow-up a person already approved.
    await db.insert(schema.touches).values({
      orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent',
      subject: 'A gap on your security page', body: 'Hello.', recipient: 'priya@rentman.io',
      sentAt: new Date(NOON.getTime() - 86_400_000), providerId: OUR_ID,
    })
    const [followUp] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'approved',
        subject: 'A follow-up', body: 'Hello again.', approvedBy: user!.id, approvedAt: NOON,
      })
      .returning({ id: schema.touches.id })
    followUpId = followUp!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const mail = (text = 'Stop', messageId = '<stop-1@rentman.io>') => ({
    from: 'priya@rentman.io', subject: 'Re: A gap on your security page', text,
    messageId, references: [OUR_ID], now: NOON, log,
  })

  /** Everything a reply's consequences touch, read back from the database. */
  const state = async () => {
    const inbound = await db.select().from(schema.touches).where(eq(schema.touches.direction, 'in'))
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
    const [followUp] = await db.select().from(schema.touches).where(eq(schema.touches.id, followUpId))
    const suppressions = await db.select().from(schema.suppressions)
    const audit = await db.select().from(schema.auditLog)
    return {
      inbound,
      pausedReason: contact!.pausedReason,
      followUp: { status: followUp!.status, refusalCode: followUp!.refusalCode },
      suppressions: suppressions.map((s) => ({ kind: s.kind, value: s.value, source: s.source })),
      actions: audit.map((a) => a.action),
      audit,
    }
  }

  /** The first delivery left nothing behind, so the retry is not a duplicate. */
  const expectNothingRecorded = async () => {
    const s = await state()
    expect(s.inbound).toEqual([])
    expect(s.pausedReason).toBeNull()
    expect(s.followUp).toEqual({ status: 'approved', refusalCode: null })
    expect(s.suppressions).toEqual([])
    expect(s.actions).not.toContain('contact.replied')
  }

  /** The retry recorded the reply and every consequence of it. */
  const expectEverythingRecorded = async (retry: Awaited<ReturnType<typeof handleInboundEmail>>) => {
    if (retry.matched === 'none') throw new Error(retry.why)
    expect(retry).toMatchObject({
      matched: 'message', duplicate: false, paused: true, suppressed: true, replyKind: 'opted_out', optOutNotRecorded: false,
    })
    const s = await state()
    expect(s.inbound).toHaveLength(1)
    expect(s.inbound[0]!.replyKind).toBe('opted_out')
    expect(s.pausedReason).toBe(`replied ${NOON.toISOString()}`)
    expect(s.followUp).toEqual({ status: 'refused', refusalCode: 'consent_revoked' })
    expect(s.suppressions).toEqual([{ kind: 'email', value: 'priya@rentman.io', source: 'reply' }])
    expect(s.actions).toContain('contact.replied')
    expect(s.actions).not.toContain('contact.opt_out_not_recorded')
  }

  /**
   * The reviewer's probe A: a database whose first UPDATE after the reply's
   * insert throws. Before, the insert stood on its own, the retry was
   * answered `duplicate` with a 200, and the follow-up was still approved.
   */
  it('records everything on the retry when the first UPDATE after the insert throws', async () => {
    let armed = false
    const faulty = throughTransactions(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === schema.touches) armed = true
            return (target as AgencyDb).insert(table as typeof schema.touches)
          }
        }
        if (prop === 'update' && armed) {
          armed = false
          return () => { throw new Error('Connection terminated unexpectedly') }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    await expect(handleInboundEmail(faulty, mail())).rejects.toThrow('Connection terminated unexpectedly')
    await expectNothingRecorded()

    await expectEverythingRecorded(await handleInboundEmail(db, mail()))
  })

  /**
   * The same, with faults the engine raises — which abort the transaction,
   * as a real one does — at each write a reply makes after its row.
   */
  it.each([
    { what: 'the pause', table: 'contacts', event: 'UPDATE' as const },
    { what: 'the cancel', table: 'touches', event: 'UPDATE' as const, when: "OLD.direction = 'out'" },
  ])('records everything on the retry when $what fails', async ({ table, event, when }) => {
    const raised = await failOnce(test.pg, { table, event, ...(when ? { when } : {}) })
    await expect(handleInboundEmail(db, mail())).rejects.toThrow()
    await expectNothingRecorded()

    await expectEverythingRecorded(await handleInboundEmail(db, mail()))
    expect(JSON.stringify(lines)).not.toContain(raised)
  })

  /**
   * §2.1's Phase 4 obligation, for the delivery that rolled back: a "stop"
   * that was not stored is said out loud. The webhook's provider retries it,
   * and the worker's IMAP path leaves it unseen and retries it a bounded
   * number of times; until one records it, and after the last, the line is
   * what a person sees. Ids and a reason class — no address, no words.
   */
  it('says OPT-OUT NOT RECORDED when a stop reply is rolled back, and nothing for an ordinary one', async () => {
    await failOnce(test.pg, { table: 'contacts', event: 'UPDATE' })
    await expect(handleInboundEmail(db, mail('Stop'))).rejects.toThrow()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.message).toContain('OPT-OUT NOT RECORDED')
    // The message it answered, by id: what the email webhook names in the
    // alarm it raises for a stop it could not record.
    const [answered] = await db.select({ id: schema.touches.id }).from(schema.touches).where(eq(schema.touches.providerId, OUR_ID))
    expect(lines[0]!.fields).toMatchObject({ contactId, orgId, why: 'Error', inReplyTo: answered!.id })
    expect(JSON.stringify(lines)).not.toContain('priya@rentman.io')
    expect(JSON.stringify(lines)).not.toContain('Stop')

    lines.length = 0
    await failOnce(test.pg, { table: 'contacts', event: 'UPDATE' })
    await expect(handleInboundEmail(db, mail('Yes, send pricing', '<yes-1@rentman.io>'))).rejects.toThrow()
    expect(lines).toEqual([])
  })

  /**
   * Review round 5: Postgres refuses U+0000 in text, and only the SMS path
   * replaced it. An email reply carrying one — mailparser keeps a NUL
   * decoded from quoted-printable `=00` — failed its INSERT on every retry,
   * on IMAP, Resend and the generic webhook alike: a "stop" recorded
   * nowhere, the person unpaused, their approved follow-up still going.
   * Replaced in `recordInboundReply`, once, for every channel.
   */
  it.each([
    { by: 'the message it answers', references: [OUR_ID], matched: 'message' },
    { by: 'the address alone', references: [], matched: 'contact' },
  ])('records an email reply carrying U+0000, matched by $by, with the character kept visible', async ({ references, matched }) => {
    const words = 'Please unsubscribe me.\n\nJo Bloggs\u0000 +44 7700 900123'
    const r = await handleInboundEmail(db, { ...mail(words, '<nul-1@rentman.io>'), subject: 'Re: A gap\u0000', references })
    expect(r).toMatchObject({ matched, duplicate: false, paused: true, suppressed: true, replyKind: 'opted_out', optOutNotRecorded: false })
    const s = await state()
    expect(s.pausedReason).toBe(`replied ${NOON.toISOString()}`)
    expect(s.followUp).toEqual({ status: 'refused', refusalCode: 'consent_revoked' })
    expect(s.suppressions).toEqual([{ kind: 'email', value: 'priya@rentman.io', source: 'reply' }])
    const [row] = s.inbound
    expect(row).toMatchObject({ body: 'Please unsubscribe me.\n\nJo Bloggs\uFFFD +44 7700 900123', subject: 'Re: A gap\uFFFD' })
    expect(lines).toEqual([])
  })

  describe('the writes allowed to fail on their own still leave the reply recorded', () => {
    /**
     * The suppression runs in a savepoint, and its failure is the loud path
     * — inside the same transaction, so it commits with the reply. Without
     * the savepoint the engine's fault aborts the transaction, every later
     * write in it fails, and the COMMIT quietly discards the reply.
     */
    it('a suppression the engine refuses: paused as not recorded, cancelled, audited, said', async () => {
      await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
      const r = await handleInboundEmail(db, mail())
      if (r.matched === 'none') throw new Error(r.why)
      expect(r).toMatchObject({ duplicate: false, paused: true, suppressed: false, replyKind: 'opted_out', optOutNotRecorded: true })

      const s = await state()
      expect(s.inbound).toHaveLength(1)
      expect(s.inbound[0]!.replyKind).toBe('opted_out')
      expect(s.pausedReason).toBe(`opt-out not recorded: reply ${NOON.toISOString()} (Error)`)
      expect(pauseReasonClass(s.pausedReason)).toBe('opt_out_not_recorded')
      expect(s.followUp).toEqual({ status: 'refused', refusalCode: 'consent_revoked' })
      expect(s.suppressions).toEqual([])
      expect(s.audit.find((a) => a.action === 'contact.opt_out_not_recorded')?.detail)
        .toMatchObject({ touchId: r.touchId, why: 'Error' })
      expect(s.actions).toContain('contact.replied')
      expect(lines.map((l) => l.message)).toEqual(['OPT-OUT NOT RECORDED — follow up by hand'])

      // A redelivery is a duplicate: the first delivery took the loud path.
      const again = await handleInboundEmail(db, mail())
      if (again.matched === 'none') throw new Error(again.why)
      expect(again.duplicate).toBe(true)
    })

    it('an audit row the engine refuses: the reply and its consequences stand', async () => {
      await failOnce(test.pg, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'contact.replied'" })
      const r = await handleInboundEmail(db, mail())
      if (r.matched === 'none') throw new Error(r.why)
      expect(r).toMatchObject({ duplicate: false, paused: true, suppressed: true })
      const s = await state()
      expect(s.inbound).toHaveLength(1)
      expect(s.pausedReason).toBe(`replied ${NOON.toISOString()}`)
      expect(s.followUp).toEqual({ status: 'refused', refusalCode: 'consent_revoked' })
      expect(s.suppressions).toHaveLength(1)
      expect(s.actions).not.toContain('contact.replied')
    })

    it('a deal move the engine refuses: the reply and its consequences stand, and no deal', async () => {
      await failOnce(test.pg, { table: 'deals', event: 'INSERT' })
      const r = await handleInboundEmail(db, mail())
      if (r.matched === 'none') throw new Error(r.why)
      expect(r).toMatchObject({ duplicate: false, paused: true, suppressed: true })
      const s = await state()
      expect(s.inbound).toHaveLength(1)
      expect(s.followUp).toEqual({ status: 'refused', refusalCode: 'consent_revoked' })
      expect(s.suppressions).toHaveLength(1)
      expect(await db.select().from(schema.deals)).toEqual([])
      expect(s.audit.find((a) => a.action === 'contact.replied')?.detail).toMatchObject({ deal: null })
    })
  })
})
