/**
 * The sender tick (PROMPT.md §8.4), against a real engine.
 *
 * `packages/db/test/outreach.test.ts` proves `dispatchTouch` — the rules and
 * the recording. This proves the scheduling around it: that a tick picks up
 * what a person approved, claims it so a second worker cannot, sends it once
 * and only once, and that a refusal for the CLOCK (quiet hours, the cap) is a
 * deferral rather than a death — the person said yes, and the only thing
 * wrong was the hour.
 *
 * The provider counts and never sends. Every test asserts against the count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, inArray } from 'drizzle-orm'
import { createDryRunProvider, schema, type AgencyDb, type MessageProvider } from '@agency/db'
import { verifyUnsubscribeToken } from '@agency/db/queries'
import { migratedDb,type TestDb } from '../../../packages/db/test/helpers.js'
import type { loadEnv } from '../src/env.js'
import type { Logger } from '../src/logger.js'
import { outreachOptions } from '../src/outreach/options.js'
import { runSenderTick } from '../src/outreach/sender.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
/** Midday UTC: midday in London. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
/** 23:30 UTC: quiet hours in London. */
const NIGHT = new Date('2026-09-15T23:30:00.000Z')

const UNSUBSCRIBE_SECRET = 'u'.repeat(32) + '-sender-test'
/** Just the variables `outreachOptions` reads; the rest of the env is not its business. */
const envWith = (vars: { UNSUBSCRIBE_SECRET?: string; WEB_PUBLIC_URL?: string; OUTREACH_BOUNCE_PAUSE_PCT?: number }) =>
  vars as unknown as ReturnType<typeof loadEnv>

/** Records what each send carried — headers included — and never sends. */
function recordingProvider(): MessageProvider & {
  seen: { to: string; subject: string; body: string; headers: Readonly<Record<string, string>> | undefined }[]
} {
  const seen: { to: string; subject: string; body: string; headers: Readonly<Record<string, string>> | undefined }[] = []
  return {
    name: 'recording',
    channels: ['email', 'linkedin'],
    seen,
    async send(m) {
      seen.push({ to: m.to, subject: m.subject, body: m.body, headers: m.headers })
      return { providerId: `recording-${seen.length}` }
    },
  }
}

/** A logger that keeps its lines, to assert what boot said. */
function keepingLog() {
  const lines: { level: string; msg: string; fields: Record<string, unknown> | undefined }[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => void lines.push({ level, msg, fields })
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

describe('the sender tick', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let provider: ReturnType<typeof createDryRunProvider>

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    provider = createDryRunProvider()

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
      // `status` defaults to 'draft', and a draft campaign does not send —
      // which is the review finding the campaign_inactive rule fixed.
      .values({ orgId, name: 'Q4', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A draft a person has approved, as `approveDraft` leaves it. */
  const approved = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out',
        status: 'approved', approvedBy: userId, approvedAt: NOON,
        subject: 'A gap on your security page', body: 'Hello.',
        ...over,
      })
      .returning()
    return row!
  }
  const reread = async (id: string) =>
    (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const tick = (now = NOON) => runSenderTick({ db, provider, log: silent, batch: 20, now: () => now })

  it('sends what a person approved, once', async () => {
    const t = await approved()
    const first = await tick()
    expect(first).toMatchObject({ picked: 1, sent: 1 })
    expect(provider.sent).toHaveLength(1)
    expect((await reread(t.id)).status).toBe('sent')

    // The next tick finds nothing: the row is no longer approved.
    const second = await tick()
    expect(second.picked).toBe(0)
    expect(provider.sent).toHaveLength(1)
  })

  /**
   * The person approved the WORDS. Their approval is what satisfies §2.4's
   * gate on a campaign without auto-send; it is not what satisfies §2.1.
   */
  it('sends through a campaign with no auto-send, because a person said yes', async () => {
    await approved()
    await tick()
    expect(provider.sent).toHaveLength(1)
  })

  it('leaves an unapproved draft alone', async () => {
    await approved({ status: 'awaiting_approval', approvedBy: null, approvedAt: null })
    const s = await tick()
    expect(s.picked).toBe(0)
    expect(provider.sent).toEqual([])
  })

  /**
   * The clock is the only thing wrong, so the message waits. `scheduled_for`
   * is set past the window and the row goes back to `approved`, keeping the
   * approver's name on it.
   */
  it('defers an approved message that lands in quiet hours, rather than refusing it', async () => {
    const t = await approved()
    const s = await tick(NIGHT)
    expect(s).toMatchObject({ picked: 1, sent: 0, deferred: 1, refused: 0 })
    expect(provider.sent).toEqual([])

    const row = await reread(t.id)
    expect(row.status).toBe('approved')
    expect(row.approvedBy).toBe(userId)
    expect(row.refusalCode).toBeNull()
    expect(row.scheduledFor!.getTime()).toBeGreaterThan(NIGHT.getTime())
  })

  /**
   * Review round 5, findings [1] and [3]: a quiet-hours deferral waits for the minute the window
   * ends where the recipient is — 08:00 in London, 07:00 UTC — and goes at it. It used to come back
   * an hour later each time, which stepped over a promotional band half an hour wide for days.
   */
  it('puts a quiet-hours deferral at the end of the window, and sends it then', async () => {
    const t = await approved()
    await tick(NIGHT)
    const windowEnds = new Date('2026-09-16T07:00:00.000Z')
    expect((await reread(t.id)).scheduledFor).toEqual(windowEnds)
    // A minute before, it is not due; at the minute, it goes.
    expect((await tick(new Date(windowEnds.getTime() - 60_000))).picked).toBe(0)
    const s = await tick(new Date(windowEnds.getTime() + 5_000))
    expect(s).toMatchObject({ picked: 1, sent: 1 })
    expect((await reread(t.id)).status).toBe('sent')
  })

  it('does not pick up a deferred message before its time', async () => {
    const t = await approved()
    await tick(NIGHT)
    const again = await tick(new Date(NIGHT.getTime() + 10 * 60_000)) // ten minutes later
    expect(again.picked).toBe(0)
    expect((await reread(t.id)).status).toBe('approved')
  })

  it('sends a deferred message once its time comes and the window has passed', async () => {
    const t = await approved()
    await tick(NIGHT)
    const morning = new Date('2026-09-16T09:00:00.000Z') // 10:00 London
    const s = await tick(morning)
    expect(s.sent).toBe(1)
    expect((await reread(t.id)).status).toBe('sent')
  })

  it('defers for the daily cap too, and for longer', async () => {
    await db.update(schema.campaigns).set({ dailyCap: 1 }).where(eq(schema.campaigns.id, campaignId))
    // One already went today.
    await approved({ status: 'sent', sentAt: NOON, approvedBy: null, approvedAt: null })
    const t = await approved()
    await tick()
    const row = await reread(t.id)
    expect(row.status).toBe('approved')
    expect(row.scheduledFor!.getTime() - NOON.getTime()).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000)
  })

  /**
   * A suppression is not the clock. Time will not change it, so it is
   * terminal — and the record says why.
   */
  it('refuses, terminally, for a suppression', async () => {
    await db.insert(schema.suppressions).values({
      orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out',
    })
    const t = await approved()
    const s = await tick()
    expect(s).toMatchObject({ refused: 1, sent: 0, deferred: 0 })
    const row = await reread(t.id)
    expect(row.status).toBe('refused')
    expect(row.refusalCode).toBe('suppressed')
    expect(provider.sent).toEqual([])
  })

  it('refuses a draft approved without a campaign or a recipient', async () => {
    const t = await approved({ campaignId: null })
    await tick()
    const row = await reread(t.id)
    expect(row.status).toBe('refused')
    expect(row.error).toMatch(/no campaign/)
    expect(provider.sent).toEqual([])
  })

  it('sends a queued message for an auto-send campaign with nobody approving', async () => {
    await db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, campaignId))
    const t = await approved({ status: 'queued', approvedBy: null, approvedAt: null })
    await tick()
    expect((await reread(t.id)).status).toBe('sent')
    expect(provider.sent).toHaveLength(1)
  })

  /**
   * The campaign turned auto-send off after the message was queued. It is
   * not refused — it goes to a person, which is what the campaign now asks.
   */
  it('routes a queued message to a person when auto-send was turned off', async () => {
    const t = await approved({ status: 'queued', approvedBy: null, approvedAt: null })
    await tick()
    expect((await reread(t.id)).status).toBe('awaiting_approval')
    expect(provider.sent).toEqual([])
  })

  it('leaves a provider failure as failed, with the reason, and keeps ticking', async () => {
    const broken = {
      name: 'broken',
      channels: ['email'] as const,
      async send() {
        throw new Error('SMTP 421 service not available')
      },
    }
    const a = await approved()
    const s = await runSenderTick({ db, provider: broken, log: silent, batch: 20, now: () => NOON })
    expect(s.failed).toBe(1)
    const row = await reread(a.id)
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/421/)
    // A second tick does not retry it on its own: a person looks first.
    const again = await runSenderTick({ db, provider: broken, log: silent, batch: 20, now: () => NOON })
    expect(again.picked).toBe(0)
  })

  it('takes the oldest first, and no more than the batch', async () => {
    for (let i = 0; i < 5; i += 1) await approved({ subject: `m${i}` })
    const s = await runSenderTick({ db, provider, log: silent, batch: 3, now: () => NOON })
    expect(s.picked).toBe(3)
    expect(provider.sent.map((m) => m.subject)).toEqual(['m0', 'm1', 'm2'])
  })

  /**
   * The claim. A row that is already `sending` — another worker got there, or
   * this one is mid-send — is not picked up, so nothing is sent twice.
   */
  it('does not pick up a row another worker has claimed', async () => {
    const t = await approved()
    await db.update(schema.touches).set({ status: 'sending' }).where(eq(schema.touches.id, t.id))
    const s = await tick()
    expect(s.picked).toBe(0)
    expect(provider.sent).toEqual([])
  })

  it('moves the company’s deal to contacted when a message goes', async () => {
    await approved()
    await tick()
    const deals = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
    expect(deals).toHaveLength(1)
    expect(deals[0]!.stage).toBe('contacted')
  })
  it('never picks up a message on a channel its provider cannot carry', async () => {
    const [li] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: true, dailyCap: 10, status: 'active' })
      .returning({ id: schema.campaigns.id })
    await approved({ campaignId: li!.id, channel: 'linkedin', status: 'queued', approvedBy: null, approvedAt: null })
    const emailOnly = { name: 'smtp-like', channels: ['email'] as const, send: provider.send }
    const s = await runSenderTick({ db, provider: emailOnly, log: silent, batch: 20, now: () => NOON })
    expect(s.picked).toBe(0)
    expect(provider.sent).toEqual([])
  })

  it('defers, rather than refuses, a message in a paused campaign', async () => {
    await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
    const t = await approved()
    const s = await tick()
    expect(s).toMatchObject({ picked: 1, sent: 0, deferred: 1 })
    expect((await reread(t.id)).status).toBe('approved')
  })

  /**
   * A campaign whose addresses bounce past the threshold pauses itself at the
   * start of a tick — once, audited, one log line — and the existing
   * `campaign_inactive` deferral is what stops it. Only a person re-activates.
   */
  describe('pausing a campaign that bounces', () => {
    /** `n` people this campaign wrote to yesterday, `bounced` of whose addresses have since bounced. */
    const history = async (n: number, bounced: number, over: { org?: string; company?: string; campaign?: string } = {}) => {
      const ids: string[] = []
      for (let i = 0; i < n; i += 1) {
        const [c] = await db
          .insert(schema.contacts)
          .values({ orgId: over.org ?? orgId, companyId: over.company ?? companyId, email: `p${i}-${Math.random().toString(36).slice(2, 10)}@rentman.io`, timeZone: 'Europe/London' })
          .returning({ id: schema.contacts.id })
        ids.push(c!.id)
      }
      const yesterday = new Date(NOON.getTime() - 24 * 60 * 60 * 1000)
      await db.insert(schema.touches).values(
        ids.map((id) => ({
          orgId: over.org ?? orgId, campaignId: over.campaign ?? campaignId, contactId: id, companyId: over.company ?? companyId,
          channel: 'email', direction: 'out', status: 'sent', sentAt: yesterday, subject: 's', body: 'b',
        })),
      )
      if (bounced > 0) {
        await db
          .update(schema.contacts)
          .set({ emailBouncedAt: new Date(NOON.getTime() - 60 * 60 * 1000), emailBounceCode: '5.1.1' })
          .where(inArray(schema.contacts.id, ids.slice(0, bounced)))
      }
    }
    const tickAt5 = (log: Logger = silent) => runSenderTick({ db, provider, log, batch: 20, now: () => NOON, bouncePausePct: 5 })
    const status = async (id = campaignId) =>
      (await db.select({ s: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]!.s
    const pauses = async () => (await db.select().from(schema.auditLog)).filter((a) => a.action === 'campaign.auto_paused')

    it('does nothing at or below the threshold', async () => {
      await history(20, 1) // 5% — not past 5%
      expect((await tickAt5()).autoPaused).toBe(0)
      expect(await status()).toBe('active')
      expect(await pauses()).toEqual([])
    })

    it('does nothing above the threshold before twenty people were written to', async () => {
      await history(19, 5)
      expect((await tickAt5()).autoPaused).toBe(0)
      expect(await status()).toBe('active')
    })

    it('does nothing when the deployment set no threshold', async () => {
      await history(20, 10)
      expect((await tick()).autoPaused).toBe(0)
      expect(await status()).toBe('active')
    })

    /** A worker with DoveSoft and no mailbox writes to no address, so it judges none. */
    it('is left to a tick that sends email', async () => {
      await history(20, 2)
      const smsOnly: MessageProvider = { name: 'sms-only', channels: ['sms'], send: provider.send }
      const s = await runSenderTick({ db, provider: smsOnly, log: silent, batch: 20, now: () => NOON, bouncePausePct: 5 })
      expect(s.autoPaused).toBe(0)
      expect(await status()).toBe('active')
      expect((await tickAt5()).autoPaused).toBe(1)
      expect(await status()).toBe('paused')
    })

    it('pauses once past the threshold with twenty sent — audited once, one log line — and a second tick does not re-audit', async () => {
      await history(20, 2) // 10%
      const log = keepingLog()
      expect((await tickAt5(log)).autoPaused).toBe(1)
      expect(await status()).toBe('paused')
      const [row] = await pauses()
      expect(row).toMatchObject({ actor: 'system', subjectId: campaignId, detail: { bouncePct: 10, threshold: 5, sentTo: 20, bounced: 2 } })
      const said = log.lines.filter((l) => l.msg.startsWith('campaign paused automatically'))
      expect(said).toHaveLength(1)
      expect(said[0]!.fields).toMatchObject({ campaignId, bouncePct: 10, threshold: 5 })
      // §2.3: counts and ids, never who bounced.
      expect(JSON.stringify(log.lines)).not.toContain('@rentman.io')

      expect((await tickAt5()).autoPaused).toBe(0)
      expect(await pauses()).toHaveLength(1)
    })

    /** No new stop mechanism: the pause IS `campaign_inactive`, which defers. */
    it('defers what a person had already approved in it, rather than refusing it', async () => {
      await history(20, 2)
      await tickAt5()
      const t = await approved()
      const s = await tickAt5()
      expect(s).toMatchObject({ picked: 1, sent: 0, deferred: 1, refused: 0 })
      const row = await reread(t.id)
      expect(row.status).toBe('approved')
      expect(row.approvedBy).toBe(userId)
      expect(provider.sent).toEqual([])
    })

    /**
     * The bounces that cross the threshold arrive between ticks. Paused AFTER
     * the pass, the tick that first saw them still sent up to a batch into
     * the bouncing list; paused BEFORE it, the same tick defers them.
     */
    it('pauses before the pass, so the tick that finds the threshold crossed sends nothing more in it', async () => {
      await history(20, 2)
      const t = await approved()
      const s = await tickAt5()
      expect(s).toMatchObject({ autoPaused: 1, picked: 1, sent: 0, deferred: 1, refused: 0 })
      expect(provider.sent).toEqual([])
      expect((await reread(t.id)).status).toBe('approved')
      expect(await status()).toBe('paused')
    })

    it('leaves another org’s campaign alone', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      const [otherCompany] = await db.insert(schema.companies).values({ orgId: other!.id, domain: 'rival.io' }).returning({ id: schema.companies.id })
      const [theirs] = await db
        .insert(schema.campaigns)
        .values({ orgId: other!.id, name: 'Theirs', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id })
      await history(20, 0, { org: other!.id, company: otherCompany!.id, campaign: theirs!.id })
      await history(20, 3)
      expect((await tickAt5()).autoPaused).toBe(1)
      expect(await status()).toBe('paused')
      expect(await status(theirs!.id)).toBe('active')
    })
  })

  /**
   * RFC 8058 (§2.1). The headers ride inside `dispatchTouch`, after every
   * rule has passed, and only when the deployment can name a link the web
   * app will verify. The message itself is not touched.
   */
  describe('the one-click unsubscribe headers', () => {
    const on = () =>
      outreachOptions(envWith({ UNSUBSCRIBE_SECRET, WEB_PUBLIC_URL: 'https://agency.example/' }), keepingLog())

    it('are absent when no headersFor is given', async () => {
      const recording = recordingProvider()
      await approved()
      await runSenderTick({ db, provider: recording, log: silent, batch: 20, now: () => NOON })
      expect(recording.seen).toHaveLength(1)
      expect(recording.seen[0]!.headers ?? {}).not.toHaveProperty('List-Unsubscribe')
      expect(recording.seen[0]!.headers ?? {}).not.toHaveProperty('List-Unsubscribe-Post')
    })

    it('are on an email touch when headersFor is given, naming THAT touch, with the body unchanged', async () => {
      const recording = recordingProvider()
      const t = await approved({ subject: 'A gap on your security page', body: 'Hello.\n\nThe words a person approved.' })
      await runSenderTick({ db, provider: recording, log: silent, batch: 20, now: () => NOON, ...on() })

      expect(recording.seen).toHaveLength(1)
      const m = recording.seen[0]!
      expect(m.subject).toBe('A gap on your security page')
      expect(m.body).toBe('Hello.\n\nThe words a person approved.')
      expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

      const link = /^<https:\/\/agency\.example\/api\/unsubscribe\/([^>]+)>$/.exec(m.headers?.['List-Unsubscribe'] ?? '')
      expect(link).not.toBeNull()
      const token = link![1]!
      // The web app, holding the same secret, reads back exactly this touch.
      expect(verifyUnsubscribeToken(UNSUBSCRIBE_SECRET, token)).toEqual({ ok: true, touchId: t.id })
      // §2.3: the link names a row, never the person.
      expect(m.headers?.['List-Unsubscribe']).not.toContain('priya')
      expect(m.headers?.['List-Unsubscribe']).not.toContain('%40')
      expect((await reread(t.id)).status).toBe('sent')
    })

    it('are absent on a LinkedIn touch, even with headersFor given', async () => {
      await db.update(schema.contacts).set({ linkedinUrl: 'https://linkedin.com/in/priya' }).where(eq(schema.contacts.id, contactId))
      const [li] = await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: true, dailyCap: 10, status: 'active' })
        .returning({ id: schema.campaigns.id })
      await approved({ campaignId: li!.id, channel: 'linkedin', status: 'queued', approvedBy: null, approvedAt: null })

      const recording = recordingProvider()
      await runSenderTick({ db, provider: recording, log: silent, batch: 20, now: () => NOON, ...on() })
      expect(recording.seen).toHaveLength(1)
      expect(recording.seen[0]!.headers ?? {}).not.toHaveProperty('List-Unsubscribe')
      expect(recording.seen[0]!.headers ?? {}).not.toHaveProperty('List-Unsubscribe-Post')
    })

    it('never reach a message the rules refused', async () => {
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out' })
      const recording = recordingProvider()
      await approved()
      await runSenderTick({ db, provider: recording, log: silent, batch: 20, now: () => NOON, ...on() })
      expect(recording.seen).toEqual([])
    })
  })
})

/** No database: this is the boot-time decision, and what it logs. */
describe('outreachOptions', () => {
  it('turns the headers on only when both the secret and the public origin are set, and says so once', () => {
    const log = keepingLog()
    const opts = outreachOptions(envWith({ UNSUBSCRIBE_SECRET, WEB_PUBLIC_URL: 'https://agency.example' }), log)
    expect(typeof opts.headersFor).toBe('function')
    expect(log.lines).toEqual([{ level: 'info', msg: 'unsubscribe: headers on', fields: undefined }])
  })

  it('is off, naming what is missing and never a value, when either is unset', () => {
    for (const [vars, missing] of [
      [{}, ['UNSUBSCRIBE_SECRET', 'WEB_PUBLIC_URL']],
      [{ UNSUBSCRIBE_SECRET }, ['WEB_PUBLIC_URL']],
      [{ WEB_PUBLIC_URL: 'https://agency.example' }, ['UNSUBSCRIBE_SECRET']],
    ] as const) {
      const log = keepingLog()
      const opts = outreachOptions(envWith(vars), log)
      expect(opts).toEqual({})
      expect(log.lines).toEqual([{ level: 'warn', msg: 'unsubscribe: headers off', fields: { missing: [...missing] } }])
      expect(JSON.stringify(log.lines)).not.toContain(UNSUBSCRIBE_SECRET)
      expect(JSON.stringify(log.lines)).not.toContain('agency.example')
    }
  })

  it('passes the bounce threshold through, and says so once at boot', () => {
    const log = keepingLog()
    const opts = outreachOptions(envWith({ OUTREACH_BOUNCE_PAUSE_PCT: 7 }), log)
    expect(opts.bouncePausePct).toBe(7)
    expect(log.lines).toContainEqual({ level: 'info', msg: 'bounce auto-pause: on', fields: { thresholdPct: 7, minSentTo: 20 } })
  })

  it('leaves the bounce check off when the environment names no threshold', () => {
    expect('bouncePausePct' in outreachOptions(envWith({}), keepingLog())).toBe(false)
  })

  it('answers null for anything that is not an email', () => {
    const { headersFor } = outreachOptions(envWith({ UNSUBSCRIBE_SECRET, WEB_PUBLIC_URL: 'https://agency.example' }), keepingLog())
    const touch = { id: '0b8f5a8e-2f1c-4b7e-9a4b-3c2d1e0f9a8b', channel: 'linkedin' } as Parameters<NonNullable<typeof headersFor>>[0]
    expect(headersFor!(touch)).toBeNull()
    expect(headersFor!({ ...touch, channel: 'email' })).toHaveProperty('List-Unsubscribe')
  })
})
