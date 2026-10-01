/**
 * Words quoting a scan a newer successful scan has superseded are refused at
 * sending (§2.2). Review round 3, finding 4.
 *
 * The sender judged a stored message only by the AGE of the scan its words
 * were written from. Scan S1, three days old, records a CSP gap; an auto-send
 * opener is written from it two days ago; scan S2, yesterday, observes the
 * CSP in place. S1 is well inside the fourteen-day window, so the opener read
 * `send_now` and the prospect was mailed a gap our own newest observation
 * contradicts, with nobody reading it — the very harm `quotableFindings`
 * names ("the company fixed their CSP last week and the email still tells
 * them they have none"), and the share link's rule, "only the latest is
 * quoted in anything outbound", which the sender did not keep.
 *
 * Now the evidence fact is aged OR superseded: a SUCCESSFUL scan of the
 * company newer than the one behind the words, compared in SQL against the
 * stored `ran_at` with that scan excluded by id — never against a
 * millisecond `Date`, the round-2 share-link trap that made every proposal
 * superseded by itself. Refused `stale_evidence`, the same code (nobody may
 * approve past it; a new draft from the latest scan resolves it), with a
 * reason that says what happened. An unreachable newer scan observed nothing
 * and supersedes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import {
  denyDraft, dispatchTouch, evidenceAsOfFor, linkedinStepsDue, previewSend, schema,
  type AgencyDb, type MessageProvider,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

/** Midday UTC: 13:00 in London, outside the default quiet hours. */
const NOW = new Date('2026-09-30T12:00:00.000Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
const PROFILE = 'https://www.linkedin.com/in/jane-doe/'

/** Counts, never sends. */
function countingProvider(channels: MessageProvider['channels']): MessageProvider & { sent: string[] } {
  const sent: string[] = []
  return {
    name: 'test',
    channels,
    sent,
    async send(m) {
      sent.push(m.to)
      return { providerId: `test-${sent.length}` }
    },
  }
}

describe('a newer successful scan supersedes the words written from an older one', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let autoCampaign: string
  let supervisedCampaign: string
  let linkedinCampaign: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id }))[0]!.id
    userId = (
      await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    )[0]!.id
    companyId = (
      await db.insert(schema.companies).values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' }).returning({ id: schema.companies.id })
    )[0]!.id
    contactId = (
      await db
        .insert(schema.contacts)
        .values({ orgId, companyId, email: 'jane@rentman.io', linkedinUrl: PROFILE, firstName: 'Jane', timeZone: 'Europe/London' })
        .returning({ id: schema.contacts.id })
    )[0]!.id
    const campaign = async (name: string, channel: string, autoSend: boolean) =>
      (await db
        .insert(schema.campaigns)
        .values({ orgId, name, channel, autoSend, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id }))[0]!.id
    autoCampaign = await campaign('Auto opener', 'email', true)
    supervisedCampaign = await campaign('Supervised opener', 'email', false)
    linkedinCampaign = await campaign('LinkedIn', 'linkedin', false)
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const scan = async (ranAt: Date | string, ok = true) =>
    (await db
      .insert(schema.scans)
      .values({ orgId, companyId, ranAt: typeof ranAt === 'string' ? sql`${ranAt}::timestamptz` : ranAt, ok, ...(ok ? {} : { error: 'timeout' }) })
      .returning())[0]!

  /** The opener an auto-send enrolment queues, written two days ago. */
  const queuedOpener = async (writtenAt: Date | string = ago(2)) =>
    (await db
      .insert(schema.touches)
      .values({
        orgId, companyId, contactId, campaignId: autoCampaign, channel: 'email', direction: 'out', status: 'queued',
        subject: 'Your CSP', body: 'No Content-Security-Policy — header absent on homepage response.',
        createdAt: typeof writtenAt === 'string' ? sql`${writtenAt}::timestamptz` : writtenAt,
      })
      .returning())[0]!

  const reread = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!

  describe('the reviewer’s probe: S1 three days ago, words two days ago, S2 yesterday', () => {
    it('the sender refuses the queued opener stale_evidence, says a newer scan ran, and calls no provider', async () => {
      await scan(ago(3))
      const t = await queuedOpener()
      await scan(ago(1))

      const smtp = countingProvider(['email'])
      const r = await dispatchTouch(db, smtp, t, { now: NOW })
      expect(r.sent).toBe(false)
      expect(r.decision).toMatchObject({ allowed: false, code: 'stale_evidence', humanCanResolve: false })
      if (!r.decision.allowed) {
        expect(r.decision.reason).toContain('newer scan')
        // Not the deadline sentence: the scan behind these words is three days old.
        expect(r.decision.reason).not.toContain('re-verification deadline')
      }
      expect(smtp.sent).toEqual([])
      const after = await reread(t.id)
      expect(after.status).toBe('refused')
      expect(after.refusalCode).toBe('stale_evidence')
      expect(after.sentAt).toBeNull()
    })

    it('the dry run reads the same fact, and reports it beside the age', async () => {
      await scan(ago(3))
      const t = await queuedOpener()
      await scan(ago(1))

      const p = await previewSend(db, { orgId, contactId, campaignId: autoCampaign, now: NOW, writtenAt: evidenceAsOfFor(t) })
      expect(p).toMatchObject({ ok: true, decision: { allowed: false, code: 'stale_evidence', humanCanResolve: false } })
      if (p.ok) {
        expect(p.facts.evidenceStale).toBe(true)
        expect(p.facts.evidenceSuperseded).toBe(true)
        if (!p.decision.allowed) expect(p.decision.reason).toContain('newer scan')
      }
      // Words written NOW quote the latest scan, which nothing has superseded.
      const fresh = await previewSend(db, { orgId, contactId, campaignId: autoCampaign, now: NOW })
      expect(fresh).toMatchObject({ ok: true, decision: { code: 'send_now' }, facts: { evidenceStale: false, evidenceSuperseded: false } })
    })

    it('an unreachable newer scan observed nothing and supersedes nothing — the opener goes', async () => {
      await scan(ago(3))
      const t = await queuedOpener()
      await scan(ago(1), false)

      const smtp = countingProvider(['email'])
      const r = await dispatchTouch(db, smtp, t, { now: NOW })
      expect(r.decision).toEqual({ allowed: true, code: 'send_now' })
      expect(r.sent).toBe(true)
      expect(smtp.sent).toEqual(['jane@rentman.io'])
    })

    it('with no newer scan at all, the opener goes', async () => {
      await scan(ago(3))
      const t = await queuedOpener()
      const r = await dispatchTouch(db, countingProvider(['email']), t, { now: NOW })
      expect(r.decision).toEqual({ allowed: true, code: 'send_now' })
    })

    it('aged AND superseded is worded as the deadline, the plainer of two true reasons', async () => {
      await scan(ago(30))
      const t = await queuedOpener(ago(29))
      await scan(ago(1))
      const r = await dispatchTouch(db, countingProvider(['email']), t, { now: NOW })
      expect(r.decision).toMatchObject({ allowed: false, code: 'stale_evidence' })
      if (!r.decision.allowed) expect(r.decision.reason).toContain('re-verification deadline')
    })
  })

  describe('compared against the STORED ran_at, never a millisecond Date', () => {
    it('the scan behind the words never supersedes itself, though its ran_at carries microseconds', async () => {
      // 123456 µs: read back as a Date this is .123, and `ran_at > <that Date>`
      // would match the scan itself — every draft superseded by its own scan.
      await scan('2026-09-27T12:00:00.123456Z')
      const t = await queuedOpener('2026-09-28T12:00:00.000000Z')
      const p = await previewSend(db, { orgId, contactId, campaignId: autoCampaign, now: NOW, writtenAt: evidenceAsOfFor(t) })
      expect(p).toMatchObject({ ok: true, decision: { code: 'send_now' }, facts: { evidenceSuperseded: false } })
    })

    it('a newer scan inside the same millisecond as the old one still supersedes it', async () => {
      await scan('2026-09-27T12:00:00.123100Z')
      const t = await queuedOpener('2026-09-27T12:00:00.123200Z')
      await scan('2026-09-27T12:00:00.123400Z')
      const p = await previewSend(db, { orgId, contactId, campaignId: autoCampaign, now: NOW, writtenAt: evidenceAsOfFor(t) })
      expect(p).toMatchObject({ ok: true, decision: { code: 'stale_evidence' }, facts: { evidenceSuperseded: true } })
    })
  })

  describe('every other reader of the fact', () => {
    it('denying a superseded draft records stale_evidence — what a new draft resolves — never a person’s no', async () => {
      await scan(ago(3))
      const [draft] = await db
        .insert(schema.touches)
        .values({
          orgId, companyId, contactId, campaignId: supervisedCampaign, channel: 'email', direction: 'out',
          status: 'awaiting_approval', subject: 'Your CSP', body: 'words', createdAt: ago(2),
        })
        .returning()
      await scan(ago(1))

      const denied = await denyDraft(db, { orgId, touchId: draft!.id, decidedBy: userId, now: NOW })
      expect(denied).toMatchObject({ ok: true, touch: { status: 'refused', refusalCode: 'stale_evidence' } })
    })

    it('the LinkedIn step’s dry run refuses a superseded approved message, and no step can hand it over', async () => {
      await scan(ago(3))
      await db.insert(schema.touches).values({
        orgId, companyId, contactId, campaignId: linkedinCampaign, channel: 'linkedin', direction: 'out',
        status: 'approved', approvedBy: userId, approvedAt: ago(2), subject: '', body: 'words', createdAt: ago(2),
      })
      await scan(ago(1))

      const [step] = await linkedinStepsDue(db, orgId, NOW)
      expect(step!.preview).toMatchObject({ ok: true, decision: { code: 'stale_evidence', humanCanResolve: false } })
    })

    it('an answer to a reply quotes no scan, and no newer scan supersedes it', async () => {
      await scan(ago(3))
      const [reply] = await db
        .insert(schema.touches)
        .values({ orgId, companyId, contactId, channel: 'email', direction: 'in', status: 'replied', body: 'Tell me more.', createdAt: ago(2) })
        .returning()
      const [answer] = await db
        .insert(schema.touches)
        .values({
          orgId, companyId, contactId, campaignId: autoCampaign, channel: 'email', direction: 'out', status: 'queued',
          subject: 'Re: Your CSP', body: 'Happy to.', answersTouchId: reply!.id, createdAt: ago(2),
        })
        .returning()
      await scan(ago(1))
      const r = await dispatchTouch(db, countingProvider(['email']), answer!, { now: NOW })
      expect(r.decision).toEqual({ allowed: true, code: 'send_now' })
    })
  })
})
