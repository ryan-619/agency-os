/**
 * A message is checked on ITS OWN channel (§2.1). Review round 3, finding 2.
 *
 * `sendFactsFor` took its channel from the CAMPAIGN — and with it the
 * recipient, the suppression keys, consent and the bounce — while
 * `dispatchTouch` picked the provider by the TOUCH's channel, and a campaign
 * could be switched from LinkedIn to email while it held approved messages.
 * Probe C: an approved LinkedIn message to somebody suppressed on LinkedIn,
 * its campaign switched to email, Start pressed — the facts read the email
 * keys (clear), never `in/<slug>`, and the person was handed the words. The
 * other direction handed an SMTP transport a LinkedIn URL.
 *
 * Now the facts are gathered for the words' own channel; a message whose
 * campaign no longer sends on that channel is refused, terminally and in
 * words, unless a refusal nobody may approve past outranks it; and the
 * campaign edit that made the mismatch is refused while messages wait
 * (campaign-edit-guards.test.ts). The campaign is switched here in SQL, the
 * way a row written around the form — or a race — would leave it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  dispatchTouch, evidenceAsOfFor, linkedinPerformStep, linkedinStepsDue, previewSend, schema,
  type AgencyDb, type MessageProvider,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

/** Midday UTC: 13:00 in London, outside the default quiet hours. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
const PROFILE = 'https://www.linkedin.com/in/priya-shah/'

/** Counts what it was handed, and never delivers anything. */
function recordingProvider(channels: MessageProvider['channels']): MessageProvider & { handed: string[] } {
  const handed: string[] = []
  return {
    name: 'test',
    channels,
    handed,
    async send(m) {
      handed.push(m.to)
      return { providerId: `test-${handed.length}` }
    },
  }
}

describe('a touch is checked on its own channel, and refused when its campaign no longer sends on it', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let linkedinCampaign: string
  let emailCampaign: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id }))[0]!.id
    userId = (
      await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', name: 'Sam', role: 'owner' }).returning({ id: schema.users.id })
    )[0]!.id
    companyId = (
      await db.insert(schema.companies).values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/London' }).returning({ id: schema.companies.id })
    )[0]!.id
    contactId = (
      await db
        .insert(schema.contacts)
        .values({ orgId, companyId, firstName: 'Priya', lastName: 'Shah', email: 'priya@rentman.io', linkedinUrl: PROFILE, timeZone: 'Europe/London' })
        .returning({ id: schema.contacts.id })
    )[0]!.id
    linkedinCampaign = (
      await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Q4 LinkedIn', channel: 'linkedin', autoSend: false, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id })
    )[0]!.id
    emailCampaign = (
      await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Q4 email', channel: 'email', autoSend: true, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id })
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const reread = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const switchCampaign = (id: string, channel: 'email' | 'linkedin') =>
    db.update(schema.campaigns).set({ channel }).where(eq(schema.campaigns.id, id))

  /** A LinkedIn message a person approved under the LinkedIn campaign. */
  const approvedLinkedin = async () =>
    (await db
      .insert(schema.touches)
      .values({
        orgId, campaignId: linkedinCampaign, contactId, companyId, channel: 'linkedin', direction: 'out',
        status: 'approved', approvedBy: userId, approvedAt: NOON, subject: '', body: 'Hello Priya.',
      })
      .returning())[0]!

  /** An auto-send email under the email campaign. */
  const queuedEmail = async () =>
    (await db
      .insert(schema.touches)
      .values({
        orgId, campaignId: emailCampaign, contactId, companyId, channel: 'email', direction: 'out',
        status: 'queued', subject: 'Your CSP', body: 'Hello Priya.',
      })
      .returning())[0]!

  describe('probe C: a LinkedIn message whose campaign was switched to email', () => {
    it('is refused as the suppression it is — the LinkedIn key is read, not the email keys — and nobody is handed the words', async () => {
      const t = await approvedLinkedin()
      await db.insert(schema.suppressions).values({ orgId, kind: 'linkedin', value: 'in/priya-shah', reason: 'asked on LinkedIn' })
      await switchCampaign(linkedinCampaign, 'email')

      const r = await linkedinPerformStep(db, { orgId, touchId: t.id, userId, now: NOON })
      expect(r).toMatchObject({ ok: true, status: 'refused', code: 'suppressed' })
      expect('words' in r).toBe(false)
      const after = await reread(t.id)
      expect(after.status).toBe('refused')
      expect(after.refusalCode).toBe('suppressed')
      // Never the email address, which is what the campaign's channel would have addressed.
      expect(after.recipient).not.toBe('priya@rentman.io')
    })

    it('with no suppression, is refused terminally because its campaign no longer sends LinkedIn — and says so', async () => {
      const t = await approvedLinkedin()
      await switchCampaign(linkedinCampaign, 'email')

      const r = await linkedinPerformStep(db, { orgId, touchId: t.id, userId, now: NOON })
      expect(r).toMatchObject({ ok: true, status: 'refused', code: 'unparseable_recipient' })
      if (r.ok && r.status === 'refused') {
        expect(r.reason).toContain('written for LinkedIn')
        expect(r.reason).toContain('now sends email')
      }
      const after = await reread(t.id)
      expect(after.status).toBe('refused')
      expect(after.refusalCode).toBe('unparseable_recipient')
      expect(after.error).toContain('written for LinkedIn')
      expect(after.recipient).toBeNull()
      expect(after.sentAt).toBeNull()
    })

    it('the /tasks dry run reads the same: suppressed on LinkedIn, then refused for the mismatch — never send_now', async () => {
      await approvedLinkedin()
      await switchCampaign(linkedinCampaign, 'email')
      const [plain] = await linkedinStepsDue(db, orgId, NOON)
      expect(plain!.preview).toMatchObject({ ok: false, reason: 'missing' })
      if (plain!.preview && !plain!.preview.ok) expect(plain!.preview.message).toContain('written for LinkedIn')

      await db.insert(schema.suppressions).values({ orgId, kind: 'linkedin', value: 'in/priya-shah', reason: 'asked on LinkedIn' })
      const [suppressed] = await linkedinStepsDue(db, orgId, NOON)
      expect(suppressed!.preview).toMatchObject({ ok: true, decision: { code: 'suppressed' } })
      if (suppressed!.preview?.ok) {
        expect(suppressed!.preview.facts.channel).toBe('linkedin')
        expect(suppressed!.preview.facts.suppressionKeys).toEqual([{ kind: 'linkedin', value: 'in/priya-shah' }])
      }
    })
  })

  describe('the other direction: an email whose campaign was switched to LinkedIn', () => {
    it('reads the email keys — an email suppression refuses it — and the SMTP transport is never handed a LinkedIn URL', async () => {
      const t = await queuedEmail()
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'replied stop' })
      await switchCampaign(emailCampaign, 'linkedin')

      const smtp = recordingProvider(['email'])
      const r = await dispatchTouch(db, smtp, t, { now: NOON })
      expect(r.sent).toBe(false)
      expect(r.decision).toMatchObject({ allowed: false, code: 'suppressed' })
      expect(smtp.handed).toEqual([])
      expect((await reread(t.id)).refusalCode).toBe('suppressed')
    })

    it('with nothing else against it, is refused for the mismatch and the transport is called by nobody', async () => {
      const t = await queuedEmail()
      await switchCampaign(emailCampaign, 'linkedin')

      const smtp = recordingProvider(['email'])
      const r = await dispatchTouch(db, smtp, t, { now: NOON })
      expect(r.sent).toBe(false)
      expect(r.decision).toMatchObject({ allowed: false, code: 'unparseable_recipient' })
      if (!r.decision.allowed) expect(r.decision.reason).toContain('written for email')
      expect(smtp.handed).toEqual([])
      const after = await reread(t.id)
      expect(after.status).toBe('refused')
      expect(after.error).toContain('now sends LinkedIn')
    })
  })

  describe('previewSend', () => {
    it('asks about a STORED message on its own channel, and reports the mismatch', async () => {
      const t = await approvedLinkedin()
      const matched = await previewSend(db, { orgId, contactId, campaignId: linkedinCampaign, now: NOON, writtenAt: evidenceAsOfFor(t) })
      expect(matched).toMatchObject({ ok: true, decision: { code: 'send_now' } })
      if (matched.ok) {
        expect(matched.facts.channel).toBe('linkedin')
        expect(matched.facts.recipient).toBe(PROFILE)
      }

      await switchCampaign(linkedinCampaign, 'email')
      const mismatched = await previewSend(db, { orgId, contactId, campaignId: linkedinCampaign, now: NOON, writtenAt: evidenceAsOfFor(t) })
      expect(mismatched).toMatchObject({ ok: false, reason: 'missing' })
      if (!mismatched.ok) expect(mismatched.message).toContain('written for LinkedIn')
    })

    it('keeps the campaign’s channel for words nobody has stored', async () => {
      await switchCampaign(linkedinCampaign, 'email')
      const hypothetical = await previewSend(db, { orgId, contactId, campaignId: linkedinCampaign, now: NOON })
      expect(hypothetical.ok).toBe(true)
      if (hypothetical.ok) {
        expect(hypothetical.facts.channel).toBe('email')
        expect(hypothetical.facts.recipient).toBe('priya@rentman.io')
      }
    })
  })

  it('a message on its campaign’s own channel is untouched by any of this', async () => {
    const t = await approvedLinkedin()
    const r = await linkedinPerformStep(db, { orgId, touchId: t.id, userId, now: NOON })
    expect(r).toMatchObject({ ok: true, status: 'sent' })
    if (r.ok && r.status === 'sent') expect(r.words.profileUrl).toBe('https://www.linkedin.com/in/priya-shah')
  })
})
