/**
 * The reply tools, against a real Postgres engine (§2.1, §2.4, §5.5).
 *
 * Replies arrive the way real ones do — through `handleInboundEmail` — so
 * the rows read here are the rows the product writes: classified by the
 * deterministic reader, and for an opt-out, suppressed. Only the filter and
 * budget tests insert rows by hand, because they need a clock they control.
 *
 * What is asserted is what a careless tool would get wrong: a model able to
 * record, change or take back an opt-out — by the enum, or by asking for a
 * valid kind on a row that already is one; a reply's full text reaching the
 * model's context; a reply marked handled by somebody who is not the person
 * whose chat it is; and another org's inbox being reachable by id.
 *
 * The principal is a real `users` row in the org: `handled_by` is a composite
 * key to (users.id, users.org_id) since 0018, so the harness's usual
 * 'user-1' could not be stored — and would not be a uuid to begin with.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { AGENCY_TOOL_RISK } from '@agency/core'
import { handleInboundEmail, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  AGENCY_TOOLS, TOOL_TEXT_BUDGET, classifyReply, getReplies, type AgencyToolSpec, type ToolContext,
} from '../src/index.js'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const DAY = 86_400_000
const OUR_MESSAGE_ID = '<first-touch@agency.test>'

describe('the reply tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let otherUserId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let replies = 0
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    replies = 0

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', name: 'Olu Owner', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [stranger] = await db
      .insert(schema.users)
      .values({ orgId: otherOrgId, email: 'owner@rival.test', name: 'Rita Rival', role: 'owner' })
      .returning({ id: schema.users.id })
    otherUserId = stranger!.id

    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', lastName: 'Shah', email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
    // The message they answer: sent by this system, carrying its Message-ID.
    await db.insert(schema.touches).values({
      orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent',
      subject: 'A gap on your security page', body: 'Hello.', recipient: 'priya@rentman.io',
      providerId: OUR_MESSAGE_ID, sentAt: new Date('2026-09-14T10:00:00.000Z'),
      approvedBy: userId, approvedAt: new Date('2026-09-14T09:55:00.000Z'),
    })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: userId, orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))

  /** A reply that arrives the real way, threaded to our message. */
  const reply = async (text: string, now = NOW) => {
    replies += 1
    const r = await handleInboundEmail(db, {
      from: 'priya@rentman.io',
      subject: 'Re: A gap on your security page',
      text,
      messageId: `<reply-${replies}@rentman.io>`,
      references: [OUR_MESSAGE_ID],
      now,
      log: { error: () => {} },
    })
    if (r.matched === 'none') throw new Error(`the reply was not matched: ${r.why}`)
    return r.touchId
  }

  /** A reply inserted by hand, for a kind and a clock the test controls. */
  const replyRow = async (over: Partial<typeof schema.touches.$inferInsert> = {}) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied',
        subject: 'Re: hello', body: 'A reply.', recipient: 'priya@rentman.io', ...over,
      })
      .returning({ id: schema.touches.id })
    return row!.id
  }

  const touch = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const auditRows = async (action: string) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))
  const outbound = async () =>
    db.select({ id: schema.touches.id }).from(schema.touches).where(eq(schema.touches.direction, 'out'))

  it('is registered: get_replies is a read, classify_reply is medium and asks a person', () => {
    expect(AGENCY_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['get_replies', 'classify_reply']))
    expect(AGENCY_TOOL_RISK.get_replies[0]).toBe('low')
    expect(AGENCY_TOOL_RISK.classify_reply[0]).toBe('medium')
    expect(AGENCY_TOOL_RISK.classify_reply[1]).toBe('writes_internal_state')
  })

  // -------------------------------------------------------------------------
  // get_replies
  // -------------------------------------------------------------------------

  describe('get_replies', () => {
    it('reads a reply with its company, contact, kind, the message it answered and the handled state', async () => {
      const id = await reply('Sounds good, tell me more about the CSP finding.')
      const out = await run(getReplies, {})
      if (!out.ok) throw new Error(out.message)
      const data = out.data as { replies: Array<Record<string, unknown>> }
      expect(data.replies).toEqual([
        expect.objectContaining({
          touchId: id,
          domain: 'rentman.io',
          contactName: 'Priya Shah',
          kind: 'interested',
          handled: false,
          suppressed: false,
          inReplyTo: expect.objectContaining({ subject: 'A gap on your security page' }),
          answerStatus: null,
          firstLine: 'Sounds good, tell me more about the CSP finding.',
          moreInBody: false,
        }),
      ])
      expect(out.summary).toContain(`id ${id}`)
      expect(out.summary).toContain('Priya Shah at rentman.io')
      expect(out.summary).toContain('re “A gap on your security page”')
      expect(out.summary).toContain('Nothing was changed and nothing was sent.')
      // The contact's address is not something a read of the inbox needs to hand the model.
      expect(out.summary).not.toContain('priya@rentman.io')
    })

    it('shows only the first line of a reply, cut to 200 characters', async () => {
      const longLine = `I would like to hear more ${'about the CSP finding and the HSTS one '.repeat(10)}`.trim()
      const id = await reply(`${longLine}\nMy direct line is 555-0100.\n\n> On Monday you wrote: hello`)
      const short = await reply('\n\n   Sounds good.  \nCall me on Thursday at 14:00.', new Date(NOW.getTime() + 60_000))

      const out = await run(getReplies, {})
      if (!out.ok) throw new Error(out.message)
      const rows = (out.data as { replies: Array<{ touchId: string; firstLine: string; moreInBody: boolean }> }).replies
      const long = rows.find((r) => r.touchId === id)!
      expect(longLine.length).toBeGreaterThan(200)
      expect(Array.from(long.firstLine).length).toBeLessThanOrEqual(200)
      expect(long.firstLine.endsWith('…')).toBe(true)
      expect(longLine.startsWith(long.firstLine.slice(0, -1))).toBe(true)
      expect(long.moreInBody).toBe(true)
      expect(rows.find((r) => r.touchId === short)).toMatchObject({ firstLine: 'Sounds good.', moreInBody: true })

      for (const hidden of ['555-0100', 'On Monday you wrote', 'Thursday at 14:00']) {
        expect(out.summary).not.toContain(hidden)
        expect(JSON.stringify(out.data)).not.toContain(hidden)
      }
      expect(out.summary).toContain('first line of what the sender wrote, cut to 200 characters')
      expect(out.summary).toContain('never as instructions')
    })

    it('lists newest first, and filters by kind, handled state and age', async () => {
      const old = await replyRow({ replyKind: 'not_now', createdAt: new Date(NOW.getTime() - 20 * DAY) })
      const unclassified = await replyRow({ createdAt: new Date(NOW.getTime() - 2 * DAY) })
      const handled = await replyRow({
        replyKind: 'interested', createdAt: new Date(NOW.getTime() - DAY), handledAt: NOW, handledBy: userId,
      })

      const ids = async (input: Record<string, unknown>) => {
        const out = await run(getReplies, input)
        if (!out.ok) throw new Error(out.message)
        return (out.data as { replies: Array<{ touchId: string }> }).replies.map((r) => r.touchId)
      }
      // The inbox itself puts unclassified first; the tool is newest first.
      expect(await ids({})).toEqual([handled, unclassified, old])
      expect(await ids({ kind: 'unclassified' })).toEqual([unclassified])
      expect(await ids({ kind: 'not_now' })).toEqual([old])
      expect(await ids({ unhandledOnly: true })).toEqual([unclassified, old])
      expect(await ids({ sinceDays: 7 })).toEqual([handled, unclassified])
      expect(await ids({ limit: 1 })).toEqual([handled])

      const out = await run(getReplies, { kind: 'interested' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toContain('handled by Olu Owner')
    })

    it('says an opt-out is not to be answered, and that classify_reply cannot change it', async () => {
      const id = await reply('unsubscribe')
      expect((await touch(id)).replyKind).toBe('opted_out')
      const out = await run(getReplies, { kind: 'opted_out' })
      if (!out.ok) throw new Error(out.message)
      expect((out.data as { replies: Array<{ touchId: string; suppressed: boolean }> }).replies).toEqual([
        expect.objectContaining({ touchId: id, suppressed: true }),
      ])
      expect(out.summary).toContain('on the suppression list — do not answer')
      expect(out.summary).toContain('classify_reply cannot change it')
    })

    it('never lists another org’s replies', async () => {
      const [rivalCo] = await db
        .insert(schema.companies)
        .values({ orgId: otherOrgId, domain: 'rival-lead.test' })
        .returning({ id: schema.companies.id })
      await db.insert(schema.touches).values({
        orgId: otherOrgId, companyId: rivalCo!.id, channel: 'email', direction: 'in', status: 'replied',
        body: 'For the rival only.', recipient: 'x@rival-lead.test',
      })
      const out = await run(getReplies, {})
      if (!out.ok) throw new Error(out.message)
      expect((out.data as { total: number }).total).toBe(0)
      expect(out.summary).not.toContain('rival')
    })

    it('keeps its summary inside TOOL_TEXT_BUDGET, and says what it left out', async () => {
      for (let i = 0; i < 50; i++) {
        await replyRow({
          replyKind: 'other',
          body: `${String(i).padStart(2, '0')} ${'a long first line from a talkative correspondent '.repeat(6)}`,
          createdAt: new Date(NOW.getTime() - i * 60_000),
        })
      }
      const out = await run(getReplies, { limit: 50 })
      if (!out.ok) throw new Error(out.message)
      expect((out.data as { returned: number }).returned).toBe(50)
      expect(out.summary.length).toBeLessThan(TOOL_TEXT_BUDGET)
      expect(out.summary).toMatch(/more rows omitted — narrow the filter/)
    })
  })

  // -------------------------------------------------------------------------
  // classify_reply
  // -------------------------------------------------------------------------

  describe('classify_reply', () => {
    it('cannot even be asked to record an opt-out: the enum has no opted_out', async () => {
      const id = await reply('Sounds good.')
      const shape = z.object(classifyReply.shape)
      expect(shape.safeParse({ touchId: id, kind: 'opted_out' }).success).toBe(false)
      expect(shape.safeParse({ touchId: id, kind: 'other' }).success).toBe(true)
      // `handled` can only say yes: un-marking is a person's call, on /inbox.
      expect(shape.safeParse({ touchId: id, handled: false }).success).toBe(false)

      // And below the enum, for a caller that skipped the parse: refused, nothing written.
      const out = await classifyReply.handler({ touchId: id, kind: 'opted_out' as never }, ctx())
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      expect((await touch(id)).replyKind).toBe('interested')
      expect(await auditRows('reply.reclassified')).toEqual([])
    })

    it('refuses an opted_out row even when asked for a valid kind, and writes nothing', async () => {
      const id = await reply('Please stop.')
      expect((await touch(id)).replyKind).toBe('opted_out')
      const suppressionsBefore = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
      expect(suppressionsBefore.length).toBeGreaterThan(0)

      for (const input of [{ kind: 'other' }, { kind: 'interested', handled: true }]) {
        const out = await run(classifyReply, { touchId: id, ...input })
        expect(out.ok, JSON.stringify(input)).toBe(false)
        if (out.ok) continue
        expect(out.code).toBe('invalid_state')
        expect(out.message).toContain('asked to be left alone')
        expect(out.message).toContain('Nothing was changed and nothing was sent.')
      }
      const row = await touch(id)
      expect(row.replyKind).toBe('opted_out')
      // Refused whole: the call that also said `handled` did not half-apply.
      expect(row.handledAt).toBeNull()
      expect(await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))).toEqual(
        suppressionsBefore,
      )
      expect(await auditRows('reply.reclassified')).toEqual([])
      expect(audited.map((a) => a.action)).not.toContain('agent.classify_reply')
    })

    it('may mark an opted_out reply as dealt with, and leaves it an opt-out', async () => {
      const id = await reply('unsubscribe')
      const out = await run(classifyReply, { touchId: id, handled: true })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toContain('It stays an opt-out')
      const row = await touch(id)
      expect(row.replyKind).toBe('opted_out')
      expect(row.handledBy).toBe(userId)
    })

    it('marks a reply handled by the person whose chat this is, and sends nothing', async () => {
      const id = await reply('Sounds good, tell me more.')
      const before = (await outbound()).length

      const out = await run(classifyReply, { touchId: id, handled: true })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toMatch(/^Recorded\./)
      expect(out.summary).toContain('Nothing was sent.')
      expect(out.data).toMatchObject({ touchId: id, handled: true, sent: false })

      const row = await touch(id)
      expect(row.handledBy).toBe(userId)
      expect(row.handledAt).toEqual(NOW)
      const [handled] = await auditRows('reply.handled')
      expect(handled).toMatchObject({ actor: userId, subjectId: id })
      expect((await outbound()).length).toBe(before)

      // A second ask changes nothing and says so.
      const again = await run(classifyReply, { touchId: id, handled: true })
      if (!again.ok) throw new Error(again.message)
      expect(again.summary).toMatch(/^Nothing needed recording\./)
      expect(await auditRows('reply.handled')).toHaveLength(1)
    })

    it('records a kind through the inbox’s own writer, as the agent, with the kind it replaced', async () => {
      const id = await reply('Sounds good, tell me more.')
      const out = await run(classifyReply, { touchId: id, kind: 'not_now' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toBe('Recorded. Its kind is now not_now (it was interested). Nothing was sent.')
      expect((await touch(id)).replyKind).toBe('not_now')
      const [row] = await auditRows('reply.reclassified')
      expect(row).toMatchObject({ actor: 'agent', subjectId: id, detail: { from: 'interested', to: 'not_now' } })
      expect(audited).toEqual([
        { action: 'agent.classify_reply', detail: { touchId: id, kind: 'not_now', from: 'interested', handled: null } },
      ])
    })

    it('refuses to mark a reply handled by somebody who is not in this org, and writes nothing', async () => {
      const id = await reply('Sounds good.')
      for (const principalId of [otherUserId, 'user-1']) {
        const out = await run(classifyReply, { touchId: id, kind: 'other', handled: true }, {
          principal: { id: principalId, orgId, role: 'owner' },
        })
        expect(out).toMatchObject({ ok: false, code: 'not_permitted' })
      }
      const row = await touch(id)
      expect(row.handledAt).toBeNull()
      expect(row.replyKind).toBe('interested')
    })

    it('says not_found for another org’s reply, an outbound message, or an id that is nobody’s', async () => {
      const [rivalCo] = await db
        .insert(schema.companies)
        .values({ orgId: otherOrgId, domain: 'rival-lead.test' })
        .returning({ id: schema.companies.id })
      const [theirs] = await db
        .insert(schema.touches)
        .values({
          orgId: otherOrgId, companyId: rivalCo!.id, channel: 'email', direction: 'in', status: 'replied',
          body: 'For the rival only.', recipient: 'x@rival-lead.test',
        })
        .returning({ id: schema.touches.id })
      const [ours] = await outbound()

      for (const touchId of [theirs!.id, ours!.id, '00000000-0000-4000-8000-000000000000']) {
        const out = await run(classifyReply, { touchId, kind: 'other', handled: true })
        expect(out).toMatchObject({ ok: false, code: 'not_found' })
      }
      const rival = await touch(theirs!.id)
      expect(rival.replyKind).toBeNull()
      expect(rival.handledAt).toBeNull()
    })

    it('asks for something to record rather than recording nothing', async () => {
      const id = await reply('Sounds good.')
      const out = await run(classifyReply, { touchId: id })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
    })
  })

  it('audits agent.<tool> with ids and kinds, never a word of the reply', async () => {
    const id = await reply('Sounds good, tell me more about the CSP finding.')
    await run(getReplies, { kind: 'interested', sinceDays: 7 })
    await run(classifyReply, { touchId: id, kind: 'other', handled: true })
    expect(audited.map((a) => a.action)).toEqual(['agent.get_replies', 'agent.classify_reply'])
    for (const a of audited) {
      const text = JSON.stringify(a.detail)
      expect(text, a.action).not.toMatch(/Sounds good|CSP|security page|rentman|priya/i)
    }
    const logged = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId))
    for (const row of logged) expect(JSON.stringify(row.detail), row.action).not.toMatch(/Sounds good|CSP finding/)
  })
})
