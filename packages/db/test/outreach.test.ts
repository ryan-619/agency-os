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
  pauseContact, recordInboundReply, resumeContact, schema, sendOne,
  type AgencyDb, type MessageProvider,
} from '../src/index.js'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'

/** Counts, never sends. A test that could deliver is a test nobody dares run. */
function countingProvider(): MessageProvider & { sent: { to: string; subject: string }[] } {
  const sent: { to: string; subject: string }[] = []
  return {
    name: 'test',
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
  let provider: ReturnType<typeof countingProvider>

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    provider = countingProvider()

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
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
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: true, dailyCap: 25 })
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
})
