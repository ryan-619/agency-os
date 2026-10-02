/**
 * Reply triage (§5.5's `classify_reply`), and the two things it may not do.
 *
 * The deterministic kind is already stored by the time this runs, so every
 * test below asks the same question in a different way: when the model is
 * absent, refused, broken or wrong, does the answer the product already had
 * survive?
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { recordInboundReply, replyReclassify, schema, type AgencyDb } from '@agency/db'
import type { LlmProvider } from '@agency/core'
import { fakeProvider } from '@agency/llm'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { refineReplyKind } from '../src/outreach/classify.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Records what would have been written, without a database. */
function spyDb(): { db: AgencyDb; writes: unknown[] } {
  const writes: unknown[] = []
  const db = {
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          writes.push(values)
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as AgencyDb
  return { db, writes }
}

const base = (over: Partial<Parameters<typeof refineReplyKind>[0]> = {}) => {
  const { db, writes } = spyDb()
  return {
    writes,
    args: {
      db,
      log: silent,
      llm: null as LlmProvider | null,
      allowRemoteForLeadData: false,
      touchId: 'touch-1',
      body: 'Sounds good, can you send pricing?',
      deterministic: 'other' as const,
      ...over,
    },
  }
}

describe('refining a reply kind', () => {
  /**
   * THE rule (§2.1). An opt-out is decided by a pure function over the
   * person's own words, and a model is not asked — not asked-and-overruled,
   * NOT ASKED. The suppression row that word implies has already been
   * written by the send path; this function has no business revisiting it.
   */
  it('never consults a model about a reply already read as an opt-out', async () => {
    const llm = fakeProvider('interested')
    const { args, writes } = base({ llm, deterministic: 'opted_out', body: 'take me off your list' })
    expect(await refineReplyKind(args)).toBe('opted_out')
    expect(llm.seen).toEqual([])
    expect(writes).toEqual([])
  })

  /**
   * And the same rule from the other side: a model that answers `opted_out`
   * for an ordinary reply is IGNORED. Obeying it would imply a suppression
   * nobody wrote — a row saying somebody asked to be left alone when they
   * did not.
   */
  it('ignores a model that claims a reply was an opt-out', async () => {
    const llm = fakeProvider('opted_out')
    const { args, writes } = base({ llm, deterministic: 'interested' })
    expect(await refineReplyKind(args)).toBe('interested')
    expect(writes).toEqual([])
  })

  it('writes nothing when the model agrees with what is already stored', async () => {
    const llm = fakeProvider('interested')
    const { args, writes } = base({ llm, deterministic: 'interested' })
    expect(await refineReplyKind(args)).toBe('interested')
    expect(writes).toEqual([])
  })

  it('keeps the deterministic kind when the model answers nonsense', async () => {
    for (const nonsense of ['very interested indeed', 'CATEGORY: none', '']) {
      const { args, writes } = base({ llm: fakeProvider(nonsense), deterministic: 'not_now' })
      expect(await refineReplyKind(args), nonsense).toBe('not_now')
      expect(writes).toEqual([])
    }
  })

  it('keeps it when the model is unreachable', async () => {
    const boom: LlmProvider = {
      name: 'ollama', model: 'llama3', local: true,
      complete: () => Promise.reject(new Error('ECONNREFUSED')),
    }
    const { args, writes } = base({ llm: boom, deterministic: 'auto_reply' })
    expect(await refineReplyKind(args)).toBe('auto_reply')
    expect(writes).toEqual([])
  })

  /** A reply is a named person's words — §5.5 refuses a remote model for it. */
  it('does not send a reply to an unapproved remote model', async () => {
    const llm = fakeProvider('interested', { name: 'openai', local: false })
    const { args } = base({ llm, deterministic: 'other' })
    expect(await refineReplyKind(args)).toBe('other')
    expect(llm.seen).toEqual([])
  })

  it('does not call a model for an empty reply', async () => {
    const llm = fakeProvider('interested')
    const { args } = base({ llm, body: '   ', deterministic: 'other' })
    expect(await refineReplyKind(args)).toBe('other')
    expect(llm.seen).toEqual([])
  })

  /** A quoted thread runs long; the category is in what the person wrote. */
  it('bounds what it sends', async () => {
    // The model agrees with what is stored, so nothing is written: this is about the prompt.
    const llm = fakeProvider('interested')
    const { args } = base({ llm, body: 'x'.repeat(50_000), deterministic: 'interested' })
    await refineReplyKind(args)
    expect(llm.seen[0]!.prompt.length).toBeLessThanOrEqual(4000)
  })
})

/**
 * A model's kind is written the way a person's is (review round 3, finding
 * 8). It used to be a plain UPDATE by id, so a header-flagged auto-reply the
 * model read as a person's words was relabelled and nothing else happened:
 * the contact stayed unpaused and the approved follow-up stayed approved —
 * a reply recorded as a person's, with none of a person's reply's effect.
 * And by id alone it wrote over a person's reclassification made while the
 * model was answering. Now it goes through `replyReclassify`'s own path, as
 * actor `agent`, only while the reply still has the kind the model was
 * asked about.
 */
describe('a model’s kind, against a real database', () => {
  const NOON = new Date('2026-09-15T12:00:00.000Z')
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let contactId: string
  let followUpId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
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
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const [followUp] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId: campaign!.id, contactId, companyId: company!.id, channel: 'email', direction: 'out',
        status: 'approved', subject: 'A follow-up', body: 'Hello again.', approvedBy: userId, approvedAt: NOON,
      })
      .returning({ id: schema.touches.id })
    followUpId = followUp!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A reply as the inbound paths record it. */
  const reply = (body: string, autoReply = false) =>
    recordInboundReply(db, {
      orgId, contactId, channel: 'email', from: 'priya@rentman.io', subject: 'Re: A gap on your security page',
      body, autoReply, now: NOON, log: { error: () => {} },
    })

  const stored = async (touchId: string) =>
    (await db.select().from(schema.touches).where(eq(schema.touches.id, touchId)))[0]!.replyKind
  const contact = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!
  const followUp = async () => (await db.select().from(schema.touches).where(eq(schema.touches.id, followUpId)))[0]!
  const reclassified = async () =>
    (await db.select().from(schema.auditLog)).filter((a) => a.action === 'reply.reclassified')

  const refine = (touchId: string, deterministic: Parameters<typeof refineReplyKind>[0]['deterministic'], llm: LlmProvider) =>
    refineReplyKind({ db, log: silent, llm, allowRemoteForLeadData: false, touchId, body: 'words', deterministic })

  it('takes a better kind from the model, stores it, and audits it as the agent', async () => {
    const r = await reply('Thanks for this. Let me think about it.')
    await db.update(schema.touches).set({ replyKind: 'other' }).where(eq(schema.touches.id, r.touchId))
    expect(await refine(r.touchId, 'other', fakeProvider('wrong_person'))).toBe('wrong_person')
    expect(await stored(r.touchId)).toBe('wrong_person')
    const rows = await reclassified()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'agent', subjectId: r.touchId, detail: { from: 'other', to: 'wrong_person' } })
  })

  /** Its pair, above, is the refusal; this one writes, so it needs the database. */
  it('sends it to a remote model once the operator has accepted that', async () => {
    const r = await reply('Thanks for this. Let me think about it.')
    await db.update(schema.touches).set({ replyKind: 'other' }).where(eq(schema.touches.id, r.touchId))
    const llm = fakeProvider('interested', { name: 'openai', local: false })
    const out = await refineReplyKind({
      db, log: silent, llm, allowRemoteForLeadData: true, touchId: r.touchId, body: 'words', deterministic: 'other',
    })
    expect(out).toBe('interested')
    expect(llm.seen).toHaveLength(1)
    expect(await stored(r.touchId)).toBe('interested')
  })

  /** The reviewer's probe T. */
  it('pauses the person and cancels their follow-up when it reads a header-flagged auto-reply as a person’s', async () => {
    const r = await reply('I am travelling until the 30th; Sam Lee looks after security.', true)
    expect(r.replyKind).toBe('auto_reply')
    expect((await contact()).pausedAt).toBeNull()
    expect((await followUp()).status).toBe('approved')

    expect(await refine(r.touchId, 'auto_reply', fakeProvider('wrong_person'))).toBe('wrong_person')
    expect(await stored(r.touchId)).toBe('wrong_person')
    // What the reply would have done had it been read as a person's at once.
    expect((await contact()).pausedReason).toBe(`replied ${NOON.toISOString()}`)
    expect(await followUp()).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
    expect((await reclassified())[0]).toMatchObject({ actor: 'agent', detail: { from: 'auto_reply', to: 'wrong_person', paused: true, cancelledQueued: 1 } })
  })

  it('keeps auto_reply when the reclassify path refuses: the person is on the suppression list', async () => {
    const r = await reply('I am out of the office until Monday.', true)
    await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'asked by phone', source: 'manual' })
    expect(await refine(r.touchId, 'auto_reply', fakeProvider('interested'))).toBe('auto_reply')
    expect(await stored(r.touchId)).toBe('auto_reply')
    expect((await contact()).pausedAt).toBeNull()
    expect(await reclassified()).toEqual([])
  })

  /** A person (or `classify_reply`) relabelled it while the model was answering: theirs stands. */
  it('does not write over a reclassification made while the model was answering', async () => {
    const r = await reply('Thanks for this. Let me think about it.')
    await db.update(schema.touches).set({ replyKind: 'other' }).where(eq(schema.touches.id, r.touchId))
    const slow: LlmProvider = {
      name: 'ollama', model: 'llama3', local: true,
      async complete() {
        await replyReclassify(db, { orgId, touchId: r.touchId, kind: 'not_now', actor: userId, now: NOON })
        return { text: 'interested', provider: 'ollama', model: 'llama3' }
      },
    }
    expect(await refine(r.touchId, 'other', slow)).toBe('not_now')
    expect(await stored(r.touchId)).toBe('not_now')
    const rows = await reclassified()
    expect(rows.map((a) => a.actor)).toEqual([userId])
  })

  /** Reclassifying can start a pause and never ends one. */
  it('leaves a pause in place when it reads a person’s reply as automatic', async () => {
    const r = await reply('Thanks for this. Let me think about it.')
    await db.update(schema.touches).set({ replyKind: 'other' }).where(eq(schema.touches.id, r.touchId))
    expect((await contact()).pausedAt).not.toBeNull()
    expect(await refine(r.touchId, 'other', fakeProvider('auto_reply'))).toBe('auto_reply')
    expect(await stored(r.touchId)).toBe('auto_reply')
    expect((await contact()).pausedReason).toBe(`replied ${NOON.toISOString()}`)
  })
})
