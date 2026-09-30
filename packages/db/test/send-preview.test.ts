/**
 * The dry run reads what the sender reads (§2.1).
 *
 * For every §2.1 fixture `outreach.test.ts` proves against `dispatchTouch`,
 * `previewSend` must give the SAME code — the preview and the send path
 * agree, or the contacts ledger and the check-send tool are a second opinion
 * about the law. And a preview writes nothing: the `touches` count is the
 * same before and after, on every path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  consentLedgerFor, dispatchTouch, evidenceAsOfFor, previewSend, schema, type AgencyDb, type MessageProvider,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOON = new Date('2026-09-15T12:00:00.000Z')
const NIGHT = new Date('2026-09-15T23:30:00.000Z')

describe('previewSend agrees with dispatchTouch', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let userId: string
  let sent: { to: string }[]
  let provider: MessageProvider

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    sent = []
    provider = {
      name: 'test',
      channels: ['email', 'linkedin'],
      async send(m) {
        sent.push({ to: m.to })
        return { providerId: `test-${sent.length}` }
      },
    }
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
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
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const touchCount = async () => (await db.select().from(schema.touches)).length

  /** A real, human-approved row through the real send path. */
  const realSend = async (now: Date) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, companyId, contactId, campaignId, channel: 'email', direction: 'out', status: 'approved',
        approvedBy: userId, approvedAt: now, subject: 'A gap on your security page', body: 'Hello.',
      })
      .returning()
    return dispatchTouch(db, provider, row!, { now })
  }

  /** The preview, asserted to have written nothing. */
  const preview = async (now: Date) => {
    const before = await touchCount()
    const out = await previewSend(db, { orgId, contactId, campaignId, now })
    expect(await touchCount(), 'a preview must write nothing').toBe(before)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(out.message)
    return out
  }

  /**
   * Each fixture is one of outreach.test.ts's, verbatim. The preview is taken
   * FIRST (so the real send cannot have changed the facts — a sent row would
   * count against the cap), then the real row goes through dispatchTouch.
   */
  const agrees = async (expected: string, now: Date = NOON) => {
    const p = await preview(now)
    const real = await realSend(now)
    expect(p.decision.code, 'preview').toBe(expected)
    expect(real.decision.code, 'dispatchTouch').toBe(expected)
    return p
  }

  it('send_now when every rule passes — and the preview still sends nothing', async () => {
    const p = await agrees('send_now')
    expect(sent).toHaveLength(1)
    expect(p.facts.zoneFrom).toBe('contact')
    expect(p.facts.suppressionKeys).toEqual([
      { kind: 'email', value: 'priya@rentman.io' },
      { kind: 'domain', value: 'rentman.io' },
    ])
  })

  it('suppressed by address', async () => {
    await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out' })
    const p = await agrees('suppressed')
    expect(p.facts.suppressed).toBe(true)
    expect(sent).toEqual([])
  })

  it('suppressed by the DOMAIN, not just the address', async () => {
    await db.insert(schema.suppressions).values({ orgId, kind: 'domain', value: 'rentman.io', reason: 'their legal team asked' })
    await agrees('suppressed')
  })

  it('ignores another org’s suppression list', async () => {
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    await db.insert(schema.suppressions).values({ orgId: other!.id, kind: 'email', value: 'priya@rentman.io', reason: 'theirs' })
    await agrees('send_now')
  })

  it('a paused contact reads as consent_revoked', async () => {
    await db.update(schema.contacts).set({ pausedAt: NOON, pausedReason: 'replied' }).where(eq(schema.contacts.id, contactId))
    const p = await agrees('consent_revoked')
    expect(p.facts.paused).toBe(true)
  })

  /**
   * Found by review: the paused branch of `sendFactsFor` skipped the
   * suppression lookup, so a paused AND suppressed person previewed as "not
   * suppressed" — the check-send route and `check_send` invited a resume —
   * and the sender logged the opt-out as a revoked consent.
   */
  it('a paused AND suppressed contact reads as suppressed, and says both', async () => {
    await db.update(schema.contacts).set({ pausedAt: NOON, pausedReason: 'replied 2026-09-15' }).where(eq(schema.contacts.id, contactId))
    await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'opted out' })
    const p = await agrees('suppressed')
    expect(p.facts.suppressed).toBe(true)
    expect(p.facts.paused).toBe(true)
    expect(p.facts.pausedReason).toBe('replied 2026-09-15')
    // Nobody recorded a consent answer; the pause is not one.
    expect(p.facts.consentRecorded).toBeNull()
  })

  /** Found by review: a refused AND bounced person read as `bounced`, which a person may resolve. */
  it('a declined AND bounced contact reads as consent_revoked, which nobody may approve past', async () => {
    await db.insert(schema.consents).values({ orgId, contactId, channel: 'email', granted: false, source: 'reply 2026-08-02' })
    await db.update(schema.contacts).set({ emailBouncedAt: NOON, emailBounceCode: '5.1.1' }).where(eq(schema.contacts.id, contactId))
    const p = await agrees('consent_revoked')
    expect(p.decision).toMatchObject({ humanCanResolve: false })
  })

  it('a declined consent', async () => {
    await db.insert(schema.consents).values({ orgId, contactId, channel: 'email', granted: false, source: 'reply 2026-08-02' })
    const p = await agrees('consent_revoked')
    expect(p.facts.consent).toEqual({ granted: false, source: 'reply 2026-08-02' })
  })

  it('no timezone anywhere is unknown_timezone', async () => {
    await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, contactId))
    await db.update(schema.companies).set({ timeZone: null }).where(eq(schema.companies.id, companyId))
    const p = await agrees('unknown_timezone')
    expect(p.facts.recipientTimeZone).toBeNull()
    expect(p.facts.zoneFrom).toBeNull()
  })

  it('falls back to the company’s zone, and says so', async () => {
    await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, contactId))
    const p = await agrees('quiet_hours', NIGHT)
    expect(p.facts.zoneFrom).toBe('company')
    expect(p.facts.recipientTimeZone).toBe('Europe/London')
  })

  it('quiet hours at night in the recipient’s zone', async () => {
    await agrees('quiet_hours', NIGHT)
  })

  it('the daily cap, counting only what went', async () => {
    await db.update(schema.campaigns).set({ dailyCap: 1 }).where(eq(schema.campaigns.id, campaignId))
    await db.insert(schema.touches).values({
      orgId, companyId, contactId, campaignId, channel: 'email', direction: 'out', status: 'sent', sentAt: NOON,
    })
    const p = await agrees('daily_cap')
    expect(p.facts.sentToday).toBe(1)
    expect(p.facts.dailyCap).toBe(1)
  })

  it('an inactive campaign', async () => {
    await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
    const p = await agrees('campaign_inactive')
    expect(p.facts.campaignStatus).toBe('paused')
  })

  it('stale evidence: a scan past the window, as the sender would read it', async () => {
    await db.insert(schema.scans).values({ orgId, companyId, ranAt: new Date('2026-08-20T09:00:00.000Z'), ok: true })
    const p = await agrees('stale_evidence')
    expect(p.facts.evidenceStale).toBe(true)
    expect(p.decision).toMatchObject({ humanCanResolve: false })
    expect(sent).toEqual([])
  })

  /**
   * A stored draft is previewed as the words it IS: written on its
   * `created_at`, from the scan current then. A re-scan since does not make
   * those words current — the sender refuses them, and so must the preview —
   * while a message written NOW would quote the new scan.
   */
  it('previews a stored draft at the moment it was written, and an answer as quoting no scan', async () => {
    const written = new Date('2026-08-25T09:00:00.000Z')
    await db.insert(schema.scans).values({ orgId, companyId, ranAt: new Date('2026-08-20T09:00:00.000Z'), ok: true })
    await db.insert(schema.scans).values({ orgId, companyId, ranAt: new Date('2026-09-14T09:00:00.000Z'), ok: true })
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, companyId, contactId, campaignId, channel: 'email', direction: 'out', status: 'approved',
        approvedBy: userId, approvedAt: written, subject: 's', body: 'b', createdAt: written,
      })
      .returning()

    const now = await previewSend(db, { orgId, contactId, campaignId, now: NOON })
    const stored = await previewSend(db, { orgId, contactId, campaignId, now: NOON, writtenAt: evidenceAsOfFor(row!) })
    const answer = await previewSend(db, { orgId, contactId, campaignId, now: NOON, writtenAt: null })
    if (!now.ok || !stored.ok || !answer.ok) throw new Error('preview failed')
    expect(now.decision.code).toBe('send_now')
    expect(stored.decision.code).toBe('stale_evidence')
    expect(answer.decision.code).toBe('send_now')

    const real = await dispatchTouch(db, provider, row!, { now: NOON })
    expect(real.decision.code).toBe(stored.decision.code)
    expect(sent).toEqual([])
  })

  it('a LinkedIn contact with a bare handle is unparseable, never clear', async () => {
    await db.update(schema.contacts).set({ linkedinUrl: 'priya' }).where(eq(schema.contacts.id, contactId))
    const [li] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: false, dailyCap: 10, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const out = await previewSend(db, { orgId, contactId, campaignId: li!.id, now: NOON })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.decision.code).toBe('unparseable_recipient')
    expect(out.facts.suppressionKeys).toBeNull()
  })

  it('reports whether a real message would stop at the approval queue, beside the answer', async () => {
    expect((await preview(NOON)).wouldNeedApproval).toBe(true)
    await db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, campaignId))
    expect((await preview(NOON)).wouldNeedApproval).toBe(false)
  })

  it('answers no_such_contact for another org’s contact, no_such_campaign for a stranger, and writes nothing', async () => {
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    const before = await touchCount()
    const a = await previewSend(db, { orgId: other!.id, contactId, campaignId, now: NOON })
    expect(a).toMatchObject({ ok: false, reason: 'no_such_contact' })
    const b = await previewSend(db, { orgId, contactId, campaignId: '00000000-0000-0000-0000-000000000000', now: NOON })
    expect(b).toMatchObject({ ok: false, reason: 'no_such_campaign' })
    expect(await touchCount()).toBe(before)
    expect(await db.select().from(schema.auditLog)).toEqual([])
  })

  describe('consentLedgerFor', () => {
    it('shows never_asked with no row, refused with granted:false, granted with granted:true', async () => {
      await db.insert(schema.consents).values({ orgId, contactId, channel: 'sms', granted: false, source: 'reply' })
      await db.insert(schema.consents).values({ orgId, contactId, channel: 'email', granted: true, source: 'webform' })
      const ledger = await consentLedgerFor(db, orgId, contactId)
      expect(ledger).not.toBeNull()
      const state = (c: string) => ledger!.channels.find((x) => x.channel === c)!.state
      expect(state('email')).toBe('granted')
      expect(state('sms')).toBe('refused')
      expect(state('voice')).toBe('never_asked')
      expect(state('whatsapp')).toBe('never_asked')
      expect(ledger!.channels).toHaveLength(4)
    })

    it('reports the suppression standing per key, with the source of each match', async () => {
      await db.insert(schema.suppressions).values({ orgId, kind: 'domain', value: 'rentman.io', reason: 'asked', source: 'manual' })
      const ledger = await consentLedgerFor(db, orgId, contactId)
      expect(ledger!.suppression.email).toBe('suppressed')
      expect(ledger!.suppression.phone).toBe('none')
      expect(ledger!.suppression.linkedin).toBe('none')
      expect(ledger!.suppression.matches).toEqual([{ kind: 'domain', value: 'rentman.io', source: 'manual', reason: 'asked' }])
    })

    it('reads a bare LinkedIn handle as unparseable — and never as clear', async () => {
      await db.update(schema.contacts).set({ linkedinUrl: 'priya' }).where(eq(schema.contacts.id, contactId))
      const ledger = await consentLedgerFor(db, orgId, contactId)
      expect(ledger!.suppression.linkedin).toBe('unparseable')
      expect(ledger!.suppression.email).toBe('clear')
      await db.update(schema.contacts).set({ linkedinUrl: 'https://linkedin.com/in/priya' }).where(eq(schema.contacts.id, contactId))
      expect((await consentLedgerFor(db, orgId, contactId))!.suppression.linkedin).toBe('clear')
    })

    it('is null for a contact in another org', async () => {
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await consentLedgerFor(db, other!.id, contactId)).toBeNull()
    })
  })
})
