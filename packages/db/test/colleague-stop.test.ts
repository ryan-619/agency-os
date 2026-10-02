/**
 * A colleague's stop, end to end (review round 8, [1], [2], [8]).
 *
 * We mailed Priya. Her colleague Sam replies all "Please remove me from your
 * list." `handleInboundEmail` files the reply under Priya — our message went
 * to her — and round 7 made `recordInboundReply` tell the stop is Sam's
 * (`fromIsContact: false`): Priya keeps only a reply's pause, and the audit
 * row names her only as `filedUnder`. When Sam's suppression cannot be
 * written, three things still treated it as Priya's, or as nobody's:
 *
 *  - [2] nobody who IS Sam was held. Sam, a contact here too with an
 *    approved message, was sent it on the next tick — §2.1's "must never
 *    fall through to sending", broken for the one person who asked.
 *  - [1] Resume and the inbox's answer said "This person asked to stop …
 *    record it by hand", and the Resume gate was satisfied by suppressing
 *    PRIYA's address: following the instruction suppressed somebody who
 *    never asked, unlocked the Resume, and left Sam unrecorded.
 *  - [8] /inbox judged the opted-out row's "on the suppression list" by
 *    Priya's address as well as Sam's, so recording Priya cleared the
 *    warning; and it could not tell the screen whose the words were.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import {
  addSuppression, contactResumeByHand, dispatchTouch, handleInboundEmail, inboxTouches, pauseReasonClass,
  recordInboundReply, replyIsFromTheContact, replyQueueDraft, schema, type AgencyDb, type InboundLog,
  type MessageProvider, type TouchRow,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { failOnce } from './fault-db.js'

const NOON = new Date('2026-09-15T12:00:00.000Z')
const OUR_ID = '<sent-1@agency.test>'
const SAM = 'sam@rentman.io'

function provider(): MessageProvider & { sent: string[] } {
  const sent: string[] = []
  return {
    name: 'test',
    channels: ['email'],
    sent,
    async send(m) {
      sent.push(m.to)
      return { providerId: `<probe-${sent.length}@agency.test>` }
    },
  }
}

describe('a stop from a colleague on the thread', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let priyaId: string
  let samId: string
  let opsId: string
  let campaignId: string
  let elsewhere: { orgId: string; samId: string; messageId: string }
  /** Messages a person already approved, as the worker read them before any reply arrived. */
  let approved: { priya: TouchRow; sam: TouchRow; ops: TouchRow }
  let lines: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[]
  let log: InboundLog

  const approvedFor = async (org: string, campaign: string, contactId: string, companyId: string, approver: string) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId: org, campaignId: campaign, contactId, companyId, channel: 'email', direction: 'out', status: 'approved',
        subject: 'A follow-up', body: 'Hello again.', approvedBy: approver, approvedAt: NOON,
      })
      .returning()
    return row!
  }

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
    ownerId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    const companyId = company!.id
    const contact = async (email: string, firstName: string) =>
      (
        await db
          .insert(schema.contacts)
          .values({ orgId, companyId, email, firstName, lastName: 'Shah', timeZone: 'Europe/London' })
          .returning({ id: schema.contacts.id })
      )[0]!.id
    priyaId = await contact('priya@rentman.io', 'Priya')
    // Stored as somebody typed it: the key is what is compared, never the spelling.
    samId = await contact('Sam@Rentman.io', 'Sam')
    // Same company, same domain, a different person: never held for Sam.
    opsId = await contact('ops@rentman.io', 'Ops')
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active',
        quietStart: '23:59', quietEnd: '00:00',
      })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
    await db.insert(schema.touches).values({
      orgId, campaignId, contactId: priyaId, companyId, channel: 'email', direction: 'out', status: 'sent',
      subject: 'A gap on your security page', body: 'Hello.', recipient: 'priya@rentman.io',
      sentAt: new Date(NOON.getTime() - 2 * 86_400_000), providerId: OUR_ID,
    })
    approved = {
      priya: await approvedFor(orgId, campaignId, priyaId, companyId, ownerId),
      sam: await approvedFor(orgId, campaignId, samId, companyId, ownerId),
      ops: await approvedFor(orgId, campaignId, opsId, companyId, ownerId),
    }

    // Another org that also has Sam on file: a suppression is per org, and so is this.
    const [other] = await db.insert(schema.orgs).values({ name: 'Other agency' }).returning({ id: schema.orgs.id })
    const [otherUser] = await db
      .insert(schema.users)
      .values({ orgId: other!.id, email: 'owner@other.test', role: 'owner' })
      .returning({ id: schema.users.id })
    const [otherCompany] = await db
      .insert(schema.companies)
      .values({ orgId: other!.id, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    const [otherSam] = await db
      .insert(schema.contacts)
      .values({ orgId: other!.id, companyId: otherCompany!.id, email: SAM, timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    const [otherCampaign] = await db
      .insert(schema.campaigns)
      .values({ orgId: other!.id, name: 'Theirs', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const otherMessage = await approvedFor(other!.id, otherCampaign!.id, otherSam!.id, otherCompany!.id, otherUser!.id)
    elsewhere = { orgId: other!.id, samId: otherSam!.id, messageId: otherMessage.id }
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const fromSam = (text = 'Please remove me from your list.', messageId = '<sam-1@rentman.io>') => ({
    from: SAM, subject: 'Re: A gap on your security page', text, messageId, references: [OUR_ID], now: NOON, log,
  })
  const contactRow = async (id: string) => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!
  const touchRow = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const resume = async (id: string) =>
    contactResumeByHand(db, { orgId, contact: { id }, expectedReason: (await contactRow(id)).pausedReason, actor: ownerId })
  const suppress = (value: string) =>
    addSuppression(db, { orgId, kind: 'email', value, reason: 'recorded by hand', source: 'manual' })
  /**
   * Sam's message, claimed by a worker's tick BEFORE the reply landed — the
   * row a reply's cancel cannot reach — and handed to the sender as the tick
   * read it. Only the sender's last look stands between it and the wire.
   */
  const claimSams = () => db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, approved.sam.id))
  const sendSams = (p: MessageProvider) => dispatchTouch(db, p, approved.sam, { now: NOON })

  describe('[2] the sender is held when their own suppression fails', () => {
    it('pauses the contact at the address that asked, refuses their messages, and audits it as theirs', async () => {
      await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
      const r = await handleInboundEmail(db, fromSam())
      if (r.matched === 'none') throw new Error(r.why)
      expect(r).toMatchObject({ contactId: priyaId, optOutNotRecorded: true, fromIsContact: false, suppressed: false })

      // Sam: held as an opt-out nobody recorded, which no Resume lifts.
      const sam = await contactRow(samId)
      expect(sam.pausedReason).toBe(`opt-out not recorded: reply ${NOON.toISOString()} (Error)`)
      expect(pauseReasonClass(sam.pausedReason)).toBe('opt_out_not_recorded')
      expect(await touchRow(approved.sam.id)).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
      expect(await resume(samId)).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })

      // Priya: only the reply's pause, as round 7 left it. Her queue was
      // cancelled by the reply, as any reply cancels it.
      expect((await contactRow(priyaId)).pausedReason).toBe(`replied ${NOON.toISOString()}`)
      expect(await touchRow(approved.priya.id)).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })

      // Nobody else: not a colleague who merely shares the domain, and not
      // Sam's namesake in another org.
      expect((await contactRow(opsId)).pausedAt).toBeNull()
      expect(await touchRow(approved.ops.id)).toMatchObject({ status: 'approved', refusalCode: null })
      expect((await contactRow(elsewhere.samId)).pausedAt).toBeNull()
      expect(await touchRow(elsewhere.messageId)).toMatchObject({ status: 'approved', refusalCode: null })

      // The rows: the reply's, naming Priya only as `filedUnder`, and Sam's own.
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'contact.opt_out_not_recorded')))
      expect(rows.map((a) => ({ subjectType: a.subjectType, subjectId: a.subjectId, detail: a.detail }))).toEqual(
        expect.arrayContaining([
          {
            subjectType: 'touch',
            subjectId: r.touchId,
            detail: { touchId: r.touchId, channel: 'email', why: 'Error', fromIsContact: false, filedUnder: priyaId },
          },
          { subjectType: 'contact', subjectId: samId, detail: { touchId: r.touchId, channel: 'email', why: 'Error' } },
        ]),
      )
      expect(rows).toHaveLength(2)

      expect(lines).toEqual([
        {
          message: 'OPT-OUT NOT RECORDED — follow up by hand',
          fields: expect.objectContaining({ fromIsContact: false, sendersHeld: 1 }),
        },
      ])
      expect(JSON.stringify(lines)).not.toContain('@')
    })

    it('never sends the sender the message a worker had already claimed', async () => {
      await claimSams()
      await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
      await handleInboundEmail(db, fromSam())
      const p = provider()
      expect(await sendSams(p)).toMatchObject({ sent: false, decision: { code: 'paused' } })
      expect(p.sent).toEqual([])
    })

    it('names the sender’s contacts, by id, on the line a rolled-back reply leaves', async () => {
      await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: "NEW.direction = 'in'" })
      await expect(handleInboundEmail(db, fromSam())).rejects.toThrow()
      expect(lines).toEqual([
        {
          message: expect.stringMatching(/^OPT-OUT NOT RECORDED — the reply was rolled back/),
          fields: expect.objectContaining({ orgId, contactId: priyaId, fromIsContact: false, senderContactIds: [samId] }),
        },
      ])
      expect(JSON.stringify(lines)).not.toContain('@')
      // Rolled back: nobody was held by the recorder itself. The caller holds them.
      expect((await contactRow(samId)).pausedAt).toBeNull()
    })

    it('holds nobody when the suppression is written: the suppression is what stops the sender', async () => {
      await claimSams()
      const r = await handleInboundEmail(db, fromSam())
      if (r.matched === 'none') throw new Error(r.why)
      expect(r).toMatchObject({ optOutNotRecorded: false, suppressed: true })
      expect((await contactRow(samId)).pausedAt).toBeNull()
      const p = provider()
      expect(await sendSams(p)).toMatchObject({ sent: false, decision: { code: 'suppressed' } })
      expect(p.sent).toEqual([])
    })

    it('says a hold that failed, and still commits the reply and the rest of the hold', async () => {
      await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
      await failOnce(test.pg, { table: 'contacts', event: 'UPDATE', when: `NEW.id = '${samId}'` })
      const r = await handleInboundEmail(db, fromSam())
      if (r.matched === 'none') throw new Error(r.why)
      expect(r).toMatchObject({ contactId: priyaId, optOutNotRecorded: true })

      // The pause failed in its own savepoint; the cancel and the row did not.
      expect((await contactRow(samId)).pausedAt).toBeNull()
      expect(await touchRow(approved.sam.id)).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
      const own = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.subjectType, 'contact'), eq(schema.auditLog.subjectId, samId)))
      expect(own.map((a) => a.action)).toEqual(['contact.opt_out_not_recorded'])
      expect((await contactRow(priyaId)).pausedReason).toBe(`replied ${NOON.toISOString()}`)

      expect(lines).toEqual([
        {
          message: 'an opt-out that was not recorded could not hold the contact at the address that asked to stop',
          fields: { touchId: r.touchId, contactId: samId, orgId, step: 'pause', error: 'Error' },
        },
        {
          message: 'OPT-OUT NOT RECORDED — follow up by hand',
          fields: expect.objectContaining({ fromIsContact: false, sendersHeld: 0 }),
        },
      ])
    })
  })

  describe('[1] Resume and the inbox name the address to record', () => {
    let priyasOwnReply: string

    beforeEach(async () => {
      // Priya's own earlier reply, unanswered.
      const own = await recordInboundReply(db, {
        orgId, contactId: priyaId, channel: 'email', from: 'priya@rentman.io', subject: 'Re: A gap',
        body: 'Tell me more', providerId: '<priya-1@rentman.io>', inReplyTo: null,
        now: new Date(NOON.getTime() - 86_400_000), log,
      })
      priyasOwnReply = own.touchId
      await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
      await handleInboundEmail(db, fromSam())
      lines.length = 0
    })

    const answerPriya = () =>
      replyQueueDraft(db, {
        orgId, inboundTouchId: priyasOwnReply, subject: 'Re: A gap', body: 'Happy to.', campaignId,
        actor: ownerId, now: NOON,
      })

    it('words the refusal as the sender’s, never as the contact’s', async () => {
      const resumed = await resume(priyaId)
      expect(resumed).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
      if (resumed.ok) throw new Error('resumed')
      expect(resumed.message).toContain('A reply from another address on this thread')
      expect(resumed.message).toContain('never this contact’s')
      expect(resumed.message).not.toMatch(/^This person asked to stop/)

      const answer = await answerPriya()
      expect(answer).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
      if (answer.ok) throw new Error('drafted')
      expect(answer.message).toContain('A reply from another address on this thread')
      expect(answer.message).not.toMatch(/^This person asked to stop/)
      // Still her own reply's pause: nobody was resumed.
      expect(pauseReasonClass((await contactRow(priyaId)).pausedReason)).toBe('replied')
    })

    it('is not satisfied by suppressing the contact’s own address', async () => {
      expect(await suppress('priya@rentman.io')).toMatchObject({ ok: true })
      expect(await resume(priyaId)).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
      expect((await contactRow(priyaId)).pausedAt).not.toBeNull()
    })

    it('is satisfied by suppressing the address the stop came from', async () => {
      expect(await suppress(SAM)).toMatchObject({ ok: true })
      expect(await answerPriya()).toMatchObject({ ok: true, resumed: true })
    })

    it('keeps the contact’s own unrecorded opt-out as it was', async () => {
      // An opted-out reply of Priya's own, from her own address, that no
      // suppression row matches: her own words, unchanged.
      await db.insert(schema.touches).values({
        orgId, contactId: priyaId, channel: 'email', direction: 'in', status: 'replied', subject: 'Re: A gap',
        body: 'Stop', recipient: 'priya@rentman.io', replyKind: 'opted_out', sentAt: NOON,
      })
      const resumed = await resume(priyaId)
      expect(resumed).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
      if (resumed.ok) throw new Error('resumed')
      expect(resumed.message).toMatch(/^This person asked to stop/)
      const answer = await answerPriya()
      if (answer.ok) throw new Error('drafted')
      expect(answer.message).toMatch(/^This person asked to stop/)

      // Hers is ended by a suppression on her address, as before — and Sam's
      // still holds her, in the sender's words.
      await suppress('priya@rentman.io')
      const again = await resume(priyaId)
      if (again.ok) throw new Error('resumed')
      expect(again.message).toContain('A reply from another address on this thread')
      await suppress(SAM)
      expect(await resume(priyaId)).toEqual({ ok: true })
    })
  })

  describe('[8] /inbox reads the opted-out row by the address it came from', () => {
    const rowsByFrom = async () => {
      const rows = await inboxTouches(db, orgId)
      return new Map(rows.map((r) => [r.touch.recipient, r]))
    }

    it('says the stop came from another address, and is not satisfied by the contact’s', async () => {
      await recordInboundReply(db, {
        orgId, contactId: priyaId, channel: 'email', from: 'priya@rentman.io', subject: 'Re: A gap',
        body: 'Tell me more', providerId: '<priya-1@rentman.io>', inReplyTo: null,
        now: new Date(NOON.getTime() - 86_400_000), log,
      })
      await failOnce(test.pg, { table: 'suppressions', event: 'INSERT' })
      await handleInboundEmail(db, fromSam())

      let rows = await rowsByFrom()
      expect(rows.get(SAM)).toMatchObject({ fromIsContact: false, suppressed: false, contact: { id: priyaId } })
      expect(rows.get('priya@rentman.io')).toMatchObject({ fromIsContact: true, suppressed: false })

      // Recording Priya — whom the screen used to name — clears nothing about Sam's stop.
      await suppress('priya@rentman.io')
      rows = await rowsByFrom()
      expect(rows.get(SAM)).toMatchObject({ suppressed: false })
      // Her own ordinary reply is still read by her address, as before.
      expect(rows.get('priya@rentman.io')).toMatchObject({ suppressed: true })

      await suppress(SAM)
      expect((await rowsByFrom()).get(SAM)).toMatchObject({ suppressed: true })
    })

    it('reads a recorded colleague’s stop as recorded', async () => {
      await handleInboundEmail(db, fromSam())
      expect((await rowsByFrom()).get(SAM)).toMatchObject({ fromIsContact: false, suppressed: true })
    })
  })
})

describe('replyIsFromTheContact', () => {
  const priya = { email: 'Priya@Rentman.io', phone: '+447700900123', linkedinUrl: null }

  it('compares the address key, never the domain', () => {
    expect(replyIsFromTheContact('priya@rentman.io', 'email', priya)).toBe(true)
    expect(replyIsFromTheContact(' PRIYA@rentman.io ', 'email', priya)).toBe(true)
    expect(replyIsFromTheContact('sam@rentman.io', 'email', priya)).toBe(false)
  })

  it('reads "could not tell" as the contact’s own', () => {
    expect(replyIsFromTheContact(null, 'email', priya)).toBe(true)
    expect(replyIsFromTheContact('not an address', 'email', priya)).toBe(true)
    expect(replyIsFromTheContact('sam@rentman.io', 'email', { email: null })).toBe(true)
  })
})

/**
 * The lock order every writer that holds a person and their messages keeps
 * (`lock-order.test.ts`): the person first. A source pin, because PGlite has
 * one session and cannot show a deadlock.
 */
describe('holding the sender', () => {
  const src = readFileSync(new URL('../src/outreach.ts', import.meta.url), 'utf8')
  const body = (signature: string): string => {
    const start = src.indexOf(signature)
    expect(start, signature).toBeGreaterThan(-1)
    const rest = src.slice(start)
    return rest.slice(0, rest.indexOf('\n}\n')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  }

  it('pauses each sender before it refuses their messages, each write in its own savepoint', () => {
    const fn = body('async function holdTheSender(')
    const pause = fn.indexOf('pauseContactOverriding(')
    const cancel = fn.indexOf('.update(schema.touches)')
    expect(pause).toBeGreaterThan(-1)
    expect(cancel).toBeGreaterThan(pause)
    expect(fn.match(/tx\.transaction\(/g)).toHaveLength(3)
  })

  it('finds them in one order, by id, and before the reply writes anything that may fail', () => {
    expect(body('async function contactsAtTheAddress(')).toContain('.orderBy(asc(schema.contacts.id))')
    const record = body('export async function recordInboundReply(')
    const found = record.indexOf('contactsAtTheAddress(')
    expect(found).toBeGreaterThan(-1)
    expect(found).toBeLessThan(record.indexOf('.insert(schema.touches)'))
  })
})
