/**
 * The sender tick with DoveSoft, against a real engine and the real send
 * path (0019).
 *
 * `packages/db/test/sms.test.ts` proves `dispatchTouch` on an SMS — the
 * template steps, the registration the provider is told. This proves the
 * worker's half: the tick hands an approved SMS to the DoveSoft provider
 * (whose fetch records and never sends), records DoveSoft's message id, and
 * — when DoveSoft is not configured — never claims an SMS row at all,
 * because `dispatchTouch` would refuse it without touching it and leave a
 * claim nothing could settle. Those rows are reported by id, and only by id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { approveDraft, schema, smsDraft, type AgencyDb, type MessageProvider, type TouchRow } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { createDoveSoftProvider } from '../src/outreach/dovesoft.js'
import { runSenderTick, startSender, type SenderMemo } from '../src/outreach/sender.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
/** Noon in India: inside the campaign's hours and TRAI's band. */
const NOON_IST = new Date('2026-09-15T06:30:00.000Z')

const KEY = 'dsk-NEVER-LOG-7f3a9c-SECRET-KEY'
const ENTITY = '1101234567890123456'
const PHONE = '+919876543210'
const TEMPLATE_BODY = 'Hi {#var#}, your call with Acme is at {#var#}. Reply STOP to opt out.'
const WORDS = 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.'

/** A logger that keeps its lines. */
function keepingLog() {
  const lines: { level: string; msg: string; fields: Record<string, unknown> | undefined }[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => void lines.push({ level, msg, fields })
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

/** DoveSoft, with a fetch that records and answers `answer`. */
function dovesoft(answer: () => Response = () => Response.json({ messageid: 'DS-77' })) {
  const calls: { url: URL; init: RequestInit }[] = []
  const provider = createDoveSoftProvider({
    apiKey: KEY,
    entityId: ENTITY,
    baseUrl: 'https://api.dovesoft.io',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} })
      return answer()
    }) as typeof fetch,
  })
  return { provider, calls }
}

/** An email-only provider that records, like the mailbox. */
function mailbox(): MessageProvider & { sent: string[] } {
  const sent: string[] = []
  return {
    name: 'smtp-like',
    channels: ['email'],
    sent,
    async send(m) {
      sent.push(m.to)
      return { providerId: `<mail-${sent.length}@agency.test>` }
    },
  }
}

describe('the sender tick with DoveSoft', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let smsCampaignId: string
  let emailCampaignId: string
  let templateId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.in', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', email: 'priya@rentman.in', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    // SMS is opt-in only (§2.1): a granted consent row, or the send path refuses.
    await db.insert(schema.consents).values({ orgId, contactId, channel: 'sms', granted: true, source: 'booking form' })
    const [sms] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Meeting reminders', channel: 'sms', autoSend: false, dailyCap: 50, status: 'active' })
      .returning({ id: schema.campaigns.id })
    smsCampaignId = sms!.id
    const [email] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4', channel: 'email', autoSend: false, dailyCap: 50, status: 'active' })
      .returning({ id: schema.campaigns.id })
    emailCampaignId = email!.id
    const [template] = await db
      .insert(schema.messageTemplates)
      .values({ orgId, channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', body: TEMPLATE_BODY })
      .returning({ id: schema.messageTemplates.id })
    templateId = template!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** An SMS drafted from the registered template and approved by a person — the only way one exists. */
  const approvedSms = async (campaignId = smsCampaignId): Promise<TouchRow> => {
    const d = await smsDraft(db, { orgId, contactId, campaignId, templateId, vars: ['Priya', '3pm'], createdBy: userId, now: NOON_IST })
    if (!d.ok) throw new Error(d.message)
    const a = await approveDraft(db, { orgId, touchId: d.touchId, contactId, campaignId, approvedBy: userId, now: NOON_IST })
    if (!a.ok) throw new Error(a.reason)
    return a.touch
  }
  const approvedEmail = async () => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId: emailCampaignId, contactId, companyId, channel: 'email', direction: 'out',
        status: 'approved', approvedBy: userId, approvedAt: NOON_IST, subject: 'A gap', body: 'Hello.',
      })
      .returning()
    return row!
  }
  const reread = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!

  it('sends an approved SMS through DoveSoft and records its message id', async () => {
    const t = await approvedSms()
    const ds = dovesoft()
    const s = await runSenderTick({ db, provider: [ds.provider], log: silent, batch: 20, now: () => NOON_IST })
    expect(s).toMatchObject({ picked: 1, sent: 1, refused: 0, failed: 0, waiting: 0 })

    expect(ds.calls).toHaveLength(1)
    const { url, init } = ds.calls[0]!
    expect(`${url.origin}${url.pathname}`).toBe('https://api.dovesoft.io/api/json/sendsms/')
    // The registered pair the operator scrubs against, read from the row by the send path.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      senderid: 'ACMEIN', unicode: '0', entityid: ENTITY, tempid: '1107160000000012345',
    })
    expect(init.headers).toEqual({ key: KEY, 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({ listsms: [{ sms: WORDS, mobiles: '919876543210', senderid: 'ACMEIN' }] })

    expect(await reread(t.id)).toMatchObject({ status: 'sent', providerId: 'DS-77', recipient: PHONE, sentAt: NOON_IST })
    // Once: the next tick finds nothing.
    expect((await runSenderTick({ db, provider: [ds.provider], log: silent, batch: 20, now: () => NOON_IST })).picked).toBe(0)
    expect(ds.calls).toHaveLength(1)
  })

  it('sends each row through the provider for its channel, in one tick', async () => {
    const text = await approvedSms()
    const mail = await approvedEmail()
    const ds = dovesoft()
    const box = mailbox()
    const s = await runSenderTick({ db, provider: [box, ds.provider], log: silent, batch: 20, now: () => NOON_IST })
    expect(s).toMatchObject({ picked: 2, sent: 2 })
    expect(box.sent).toEqual(['priya@rentman.in'])
    expect(ds.calls).toHaveLength(1)
    expect((await reread(text.id)).providerId).toBe('DS-77')
    expect((await reread(mail.id)).providerId).toBe('<mail-1@agency.test>')
  })

  /**
   * Review round 5, findings [1], [2] and [3]. A promotional SMS to an Indian number read in New
   * York in December may go only from 10:00 to 10:30 there (15:00–15:30 UTC), where TRAI's band and
   * the recipient's own 10:00–21:00 meet. The tick put every quiet-hours deferral back an hour later,
   * so a first try at 14:35 UTC came back at 15:35, 16:35, … and missed that half hour for days.
   */
  describe('a promotional SMS and its band', () => {
    const PROMO_BODY = 'Hi {#var#}, our autumn review slots are open. Reply STOP to opt out.'

    /** A promotional SMS drafted and approved at `at`, to Priya read in `zone`. */
    const approvedPromo = async (zone: string, at: Date): Promise<TouchRow> => {
      await db.update(schema.contacts).set({ timeZone: zone }).where(eq(schema.contacts.id, contactId))
      const [template] = await db
        .insert(schema.messageTemplates)
        .values({ orgId, channel: 'sms', externalId: '1107160000000099999', senderId: 'ACMEIN', category: 'promotional', body: PROMO_BODY })
        .returning({ id: schema.messageTemplates.id })
      const d = await smsDraft(db, { orgId, contactId, campaignId: smsCampaignId, templateId: template!.id, vars: ['Priya'], createdBy: userId, now: at })
      if (!d.ok) throw new Error(d.message)
      const a = await approveDraft(db, { orgId, touchId: d.touchId, contactId, campaignId: smsCampaignId, approvedBy: userId, now: at })
      if (!a.ok) throw new Error(a.reason)
      return a.touch
    }

    it('waits for the minute the band opens, and goes inside its half hour', async () => {
      const first = new Date('2026-12-01T14:35:00.000Z') // 09:35 in New York, 20:05 in India
      const t = await approvedPromo('America/New_York', first)
      const ds = dovesoft()
      const tick = (at: Date) => runSenderTick({ db, provider: [ds.provider], log: silent, batch: 20, now: () => at })

      expect(await tick(first)).toMatchObject({ picked: 1, deferred: 1, sent: 0 })
      const opens = new Date('2026-12-01T15:00:00.000Z') // 10:00 in New York, 20:30 in India
      expect(await reread(t.id)).toMatchObject({ status: 'approved', refusalCode: null, scheduledFor: opens })
      expect(ds.calls).toHaveLength(0)

      expect(await tick(new Date(opens.getTime() + 7_500))).toMatchObject({ picked: 1, sent: 1 })
      expect(await reread(t.id)).toMatchObject({ status: 'sent', providerId: 'DS-77' })
      expect(ds.calls).toHaveLength(1)
    })

    it('refuses a band that never opens as itself, terminally, and never calls DoveSoft', async () => {
      // Denver all year: 10:00–21:00 there never meets 10:00–21:00 in India.
      const at = new Date('2026-12-01T17:00:00.000Z')
      const t = await approvedPromo('America/Denver', at)
      const ds = dovesoft()
      const s = await runSenderTick({ db, provider: [ds.provider], log: silent, batch: 20, now: () => at })
      expect(s).toMatchObject({ picked: 1, refused: 1, deferred: 0, sent: 0 })
      expect(await reread(t.id)).toMatchObject({ status: 'refused', refusalCode: 'band_never_opens', scheduledFor: null })
      expect(ds.calls).toHaveLength(0)
    })
  })

  describe('when DoveSoft is not configured', () => {
    it('never claims an SMS row, and still sends the email beside it', async () => {
      const text = await approvedSms()
      const mail = await approvedEmail()
      const box = mailbox()
      const s = await runSenderTick({ db, provider: [box], unserved: ['sms'], log: silent, batch: 20, now: () => NOON_IST })
      expect(s).toMatchObject({ picked: 1, sent: 1, waiting: 1 })
      expect((await reread(mail.id)).status).toBe('sent')
      // Exactly as a person left it: not `sending`, not `failed`, not refused.
      expect(await reread(text.id)).toMatchObject({ status: 'approved', refusalCode: null, error: null, providerId: null, sentAt: null })
    })

    it('says which rows are waiting by id, never by number or words, and only when the set changes', async () => {
      const first = await approvedSms()
      const log = keepingLog()
      const memo: SenderMemo = { waitingReported: null }
      const deps = { db, provider: [mailbox()], unserved: ['sms'] as const, log, batch: 20, now: () => NOON_IST }

      await runSenderTick(deps, memo)
      const waiting = () => log.lines.filter((l) => l.msg === 'sms rows waiting: no provider')
      expect(waiting()).toEqual([{ level: 'warn', msg: 'sms rows waiting: no provider', fields: { touchIds: [first.id], more: false } }])
      const everything = JSON.stringify(log.lines)
      expect(everything).not.toContain(PHONE)
      expect(everything).not.toContain('9876543210')
      expect(everything).not.toContain('Priya')

      // The same set: nothing more, however many ticks.
      await runSenderTick(deps, memo)
      await runSenderTick(deps, memo)
      expect(waiting()).toHaveLength(1)

      // A new row changes the set: said again, with both. (A second
      // campaign, because a person has one live SMS draft per campaign.)
      const [other] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Renewals', channel: 'sms', autoSend: false, dailyCap: 50, status: 'active' })
        .returning({ id: schema.campaigns.id })
      const second = await approvedSms(other!.id)
      await runSenderTick(deps, memo)
      expect(waiting()).toHaveLength(2)
      expect(waiting()[1]!.fields).toEqual({ touchIds: [first.id, second.id], more: false })
    })

    it('reports at most once per tick without a memo, and not at all when nothing is due', async () => {
      const t = await approvedSms()
      // Due later: waiting on the clock, not on a provider yet.
      await db.update(schema.touches).set({ scheduledFor: new Date(NOON_IST.getTime() + 3_600_000) }).where(eq(schema.touches.id, t.id))
      const log = keepingLog()
      const s = await runSenderTick({ db, provider: [mailbox()], unserved: ['sms'], log, batch: 20, now: () => NOON_IST })
      expect(s.waiting).toBe(0)
      expect(log.lines.filter((l) => l.msg.includes('waiting'))).toEqual([])

      const later = new Date(NOON_IST.getTime() + 2 * 3_600_000)
      await runSenderTick({ db, provider: [mailbox()], unserved: ['sms'], log, batch: 20, now: () => later })
      await runSenderTick({ db, provider: [mailbox()], unserved: ['sms'], log, batch: 20, now: () => later })
      expect(log.lines.filter((l) => l.msg.includes('waiting'))).toHaveLength(2)
    })

    it('reports nothing for a channel a provider does carry', async () => {
      await approvedSms()
      const log = keepingLog()
      const ds = dovesoft()
      const s = await runSenderTick({ db, provider: [ds.provider], unserved: ['sms'], log, batch: 20, now: () => NOON_IST })
      expect(s).toMatchObject({ sent: 1, waiting: 0 })
      expect(log.lines.filter((l) => l.msg.includes('waiting'))).toEqual([])
    })
  })

  /**
   * A failed send is `failed` with a sentence, audited by error NAME, and
   * logged by name: the key and what DoveSoft said back reach none of them.
   */
  it('records a DoveSoft failure without the key or the reply', async () => {
    const t = await approvedSms()
    const echo = `{"error":"blocked","sms":"${WORDS}","key":"${KEY}"}`
    const ds = dovesoft(() => new Response(echo, { status: 502 }))
    const log = keepingLog()
    const s = await runSenderTick({ db, provider: [ds.provider], log, batch: 20, now: () => NOON_IST })
    expect(s).toMatchObject({ picked: 1, failed: 1 })

    const row = await reread(t.id)
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/HTTP 502/)
    expect(row.error).not.toContain(KEY)
    expect(row.error).not.toContain('blocked')
    expect(row.error).not.toContain(WORDS)

    const audits = await db.select().from(schema.auditLog)
    const failed = audits.filter((a) => a.action === 'send.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.detail).toMatchObject({ provider: 'dovesoft', error: 'DoveSoftHttpError' })
    expect(JSON.stringify(audits)).not.toContain(KEY)

    expect(log.lines).toContainEqual({
      level: 'error',
      msg: 'a message failed at the provider',
      fields: { touchId: t.id, provider: 'dovesoft', error: 'DoveSoftHttpError' },
    })
    expect(JSON.stringify(log.lines)).not.toContain(KEY)
    expect(JSON.stringify(log.lines)).not.toContain(WORDS)

    // A person looks first: the next tick does not retry it.
    expect((await runSenderTick({ db, provider: [ds.provider], log: silent, batch: 20, now: () => NOON_IST })).picked).toBe(0)
    expect(ds.calls).toHaveLength(1)
  })

  it('refuses, at start, two providers for one channel', () => {
    expect(() =>
      startSender({ db, provider: [dovesoft().provider, dovesoft().provider], log: silent, batch: 20, intervalMs: 60_000 }),
    ).toThrow(/Two providers carry sms/)
  })
})
