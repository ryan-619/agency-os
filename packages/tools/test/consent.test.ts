/**
 * The consent tools (§2.1): `check_send` and `get_consent`.
 *
 * What matters is that they are the SENDER's answer, not a second opinion:
 * `check_send` returns the code `decideSend` would return for that person
 * right now, for every refusal the send path knows; and neither tool writes
 * a thing — the `touches` count is the same before and after every call in
 * this file. `get_consent` must never let an unreadable LinkedIn profile
 * read as clear, and must never hand the model the value of somebody's
 * opt-out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { addSuppression, contactPauseByHand, contactsRecordConsent, recordInboundSms, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import { failOnce } from '../../db/test/fault-db.js'
import { AGENCY_TOOLS, checkSend, getConsent, type AgencyToolSpec, type ToolContext } from '../src/index.js'

const NOON_UTC = new Date('2026-09-15T12:00:00.000Z')

describe('the consent tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string
  let priyaId: string
  let campaignId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [priya] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    priyaId = priya!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id

    // The same domain in ANOTHER org, with a person this org must not see.
    const [theirs] = await db
      .insert(schema.companies)
      .values({ orgId: otherOrgId, domain: 'rentman.io' })
      .returning({ id: schema.companies.id })
    await db
      .insert(schema.contacts)
      .values({ orgId: otherOrgId, companyId: theirs!.id, email: 'mallory@rentman.io', timeZone: 'Europe/London' })
    await db
      .insert(schema.campaigns)
      .values({ orgId: otherOrgId, name: 'Their campaign', channel: 'email', dailyCap: 5, status: 'active' })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db,
    orgId,
    principal: { id: 'user-1', orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => NOON_UTC,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
  })
  /** Run a tool the way the adapter will: parse with zod, then hand over. */
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx())

  const touches = async () => (await db.select().from(schema.touches)).length
  const check = (over: Record<string, unknown> = {}) =>
    run(checkSend, { domain: 'rentman.io', contactEmail: 'priya@rentman.io', campaignName: 'Q4 security gaps', ...over })

  it('is registered, and both descriptions say they queue nothing', () => {
    for (const spec of [checkSend, getConsent]) {
      expect(AGENCY_TOOLS).toContain(spec)
      expect(spec.description).toMatch(/queues nothing/)
    }
  })

  it('refuses SMS and voice below the gate: the shape only takes email or LinkedIn', () => {
    expect(z.object(checkSend.shape).safeParse({ domain: 'rentman.io', contactEmail: 'priya@rentman.io', campaignName: 'x', channel: 'sms' }).success).toBe(false)
  })

  describe('check_send', () => {
    it('answers send_now when every rule passes, says approval still applies, and queues nothing', async () => {
      const before = await touches()
      const out = await check()
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.data).toMatchObject({ allowed: true, code: 'send_now', wouldNeedApproval: true, queued: false })
      expect(out.summary).toMatch(/^send_now: /)
      expect(out.summary).toMatch(/wait for a person to approve it/)
      expect(out.summary).toMatch(/Nothing was queued\.$/)
      expect(await touches()).toBe(before)
      expect(audited).toEqual([
        { action: 'agent.check_send', detail: { domain: 'rentman.io', contactId: priyaId, campaignId, code: 'send_now' } },
      ])
    })

    it('says suppressed when the address is on the list, and that nobody may approve past it', async () => {
      await addSuppression(db, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'replied stop', source: 'reply' })
      const before = await touches()
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ allowed: false, code: 'suppressed', humanCanResolve: false })
      expect(out.summary).toMatch(/^suppressed: .+\. Nobody may approve past this\. Nothing was queued\.$/)
      expect(await touches()).toBe(before)
    })

    /**
     * Only the summary reaches the model. Found by review: a contact paused
     * because they REPLIED read "consent_revoked: This contact has declined
     * email … Nobody may approve past this", and the agent told the user an
     * interested prospect had declined. The code stays the sender's; the
     * words say what it is and what lifts it, first.
     */
    it('says a reply pause first and plainly — not a refusal of the channel — and what lifts it', async () => {
      const reason = 'replied 2026-09-15T11:00:00.000Z'
      await db.update(schema.contacts).set({ pausedAt: NOON_UTC, pausedReason: reason }).where(eq(schema.contacts.id, priyaId))
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({
        code: 'paused',
        humanCanResolve: false,
        facts: { paused: true, pausedReason: reason, pausedFor: 'replied', consent: 'never_asked', suppressed: false },
      })
      expect(out.summary).toBe(
        `paused: they replied (${reason}); every campaign stops for them until a person answers from /inbox ` +
          '(which resumes them) or resumes them on /contacts. This is not a refusal of email. ' +
          'get_replies shows what they said. Nothing was queued.',
      )
      expect(out.summary).not.toMatch(/declined/)
    })

    /**
     * Which pause it is decides what lifts it, read the way the inbox reads
     * it (`pauseReasonClass`, an exact `replied <ISO>` match). Found by
     * review: a prefix test promised an /inbox answer for a teammate's
     * "replied on the phone (by …)", which the inbox refuses, and told the
     * model to resume somebody whose opt-out was never recorded.
     */
    const pausedAs = async (reason: string) => {
      await db.update(schema.contacts).set({ pausedAt: NOON_UTC, pausedReason: reason }).where(eq(schema.contacts.id, priyaId))
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ code: 'paused', humanCanResolve: false })
      expect(out.summary).toMatch(/Nothing was queued\.$/)
      return out
    }

    it('calls a teammate’s pause a teammate’s, even one that starts with "replied", and never promises an /inbox answer', async () => {
      const reason = 'replied on the phone, call in October (by sam@agency.test)'
      const out = await pausedAs(reason)
      expect(out.data).toMatchObject({ facts: { pausedFor: 'manual' } })
      expect(out.summary).toBe(
        `paused by a teammate (${reason}): every campaign stops for them until a person resumes them on /contacts. ` +
          'Answering a reply from /inbox does not lift this pause. Approving a draft does not lift a pause. Nothing was queued.',
      )
      expect(out.summary).not.toMatch(/not a refusal/)
      expect(out.summary).not.toMatch(/they replied/)
    })

    it('never suggests resuming an opt-out that was not recorded — it says to record it', async () => {
      const out = await pausedAs('opt-out not recorded: one-click unsubscribe 2026-09-15T11:00:00.000Z (Error)')
      expect(out.data).toMatchObject({ facts: { pausedFor: 'opt_out_not_recorded' } })
      expect(out.summary).toMatch(/record the opt-out by hand on \/suppressions/)
      expect(out.summary).toMatch(/do not suggest resuming them/)
      expect(out.summary).not.toMatch(/resumes? them (on|there)/)
      expect(out.summary).not.toMatch(/not a refusal/)
    })

    /**
     * Review round 8: a text from a number several contacts share asked to
     * stop and could not be recorded. The holder may never have sent it, so
     * the tool never says THEY asked; recording the number is what lets a
     * person lift the pause.
     */
    it('words a shared number’s holder as a holder, never as the one who asked', async () => {
      const out = await pausedAs('opt-out not recorded: a text from a number they share, 2026-09-15T11:00:00.000Z (record_failed)')
      expect(out.data).toMatchObject({ facts: { pausedFor: 'opt_out_not_recorded' } })
      expect(out.summary).toMatch(/a text from a phone number they share with another contact asked to stop/)
      expect(out.summary).toMatch(/records the number on \/suppressions/)
      expect(out.summary).toMatch(/do not suggest resuming them/)
      expect(out.summary).not.toMatch(/they asked to stop/)
    })

    it('never suggests resuming an erasure that did not finish — it says to complete it', async () => {
      const out = await pausedAs('erasure requested 2026-09-15; not completed (unreadable_phone)')
      expect(out.data).toMatchObject({ facts: { pausedFor: 'erasure' } })
      expect(out.summary).toMatch(/complete the erasure from their record on \/contacts/)
      expect(out.summary).toMatch(/do not suggest resuming them/)
      expect(out.summary).not.toMatch(/resumes? them (on|there)/)
    })

    it('calls an unsubscribe an opt-out, never something to resume', async () => {
      const reason = 'unsubscribed 2026-09-15T11:00:00.000Z'
      const out = await pausedAs(reason)
      expect(out.summary).toBe(
        `paused: they unsubscribed (${reason}). That is their opt-out — do not suggest resuming them. ` +
          'Approving a draft does not lift a pause. Nothing was queued.',
      )
      expect(out.summary).not.toMatch(/not a refusal/)
    })

    it('quotes any other pause with its reason, and never calls it "not a refusal"', async () => {
      const reason = 'waiting on legal'
      const out = await pausedAs(reason)
      expect(out.data).toMatchObject({ facts: { pausedFor: 'other' } })
      expect(out.summary).toBe(
        `paused (${reason}): every campaign stops for them until a person reads why on /contacts and resumes them ` +
          'there if that is right. Approving a draft does not lift a pause. Nothing was queued.',
      )
      expect(out.summary).not.toMatch(/not a refusal/)
    })

    /** Found by review: the paused branch skipped the suppression lookup, so this read as a pause. */
    it('says suppressed for a paused AND suppressed contact, with the pause beside it', async () => {
      await db.update(schema.contacts).set({ pausedAt: NOON_UTC, pausedReason: 'replied 2026-09-15' }).where(eq(schema.contacts.id, priyaId))
      await addSuppression(db, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'replied stop', source: 'reply' })
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ code: 'suppressed', humanCanResolve: false, facts: { suppressed: true, paused: true } })
      expect(out.summary).toMatch(/^suppressed: .+\. Nobody may approve past this\. They are also paused \(replied 2026-09-15\)\. Nothing was queued\.$/)
      expect(out.summary).not.toMatch(/not a refusal/)
    })

    it('says a recorded refusal as the refusal, even for a paused contact', async () => {
      await contactsRecordConsent(db, { orgId, contactId: priyaId, channel: 'email', granted: false, source: 'said no on a call' })
      await db.update(schema.contacts).set({ pausedAt: NOON_UTC, pausedReason: 'replied 2026-09-15' }).where(eq(schema.contacts.id, priyaId))
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ code: 'consent_revoked', facts: { consent: 'refused', paused: true } })
      expect(out.summary).toMatch(/^consent_revoked: This contact has declined email \(recorded: said no on a call\)/)
      expect(out.summary).toMatch(/They are also paused \(replied 2026-09-15\)\. Nothing was queued\.$/)
      expect(out.summary).not.toMatch(/not a refusal/)
    })

    it('says stale_evidence when the company’s last scan is past the window, for a message written now', async () => {
      await db.insert(schema.scans).values({ orgId, companyId, ranAt: new Date('2026-08-20T09:00:00.000Z'), ok: true })
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ code: 'stale_evidence', humanCanResolve: false, facts: { evidenceStale: true } })
      expect(out.summary).toMatch(/^stale_evidence: .+Re-scan the company, then draft the message again\. Nobody may approve past this\. Nothing was queued\.$/)
    })

    it('says unknown_timezone when neither the person nor the company has a zone', async () => {
      await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, priyaId))
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ code: 'unknown_timezone', facts: { recipientTimeZone: null, zoneFrom: null } })
    })

    it('falls back to the company’s zone, and says so', async () => {
      await db.update(schema.contacts).set({ timeZone: null }).where(eq(schema.contacts.id, priyaId))
      await db.update(schema.companies).set({ timeZone: 'Europe/London' }).where(eq(schema.companies.id, companyId))
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ code: 'send_now', facts: { recipientTimeZone: 'Europe/London', zoneFrom: 'company' } })
    })

    it('finds the campaign whatever its case, and the company from a pasted URL', async () => {
      const out = await check({ campaignName: 'q4 SECURITY gaps', domain: 'https://www.rentman.io/pricing', contactEmail: 'Priya@Rentman.IO' })
      expect(out.ok).toBe(true)
    })

    it('says not_found for a campaign that does not exist, or belongs to another org', async () => {
      for (const campaignName of ['Q5', 'Their campaign']) {
        const out = await check({ campaignName })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.code).toBe('not_found')
      }
      expect(audited).toEqual([])
    })

    it('cannot see another org’s contact, even at a company with the same domain', async () => {
      const out = await check({ contactEmail: 'mallory@rentman.io' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_found')
    })

    it('refuses a channel the campaign is not on', async () => {
      const out = await check({ channel: 'linkedin' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('invalid_state')
      expect(out.message).toMatch(/email campaign/)
    })
  })

  describe('get_consent', () => {
    it('reads each channel as one of three states, with never-asked worded by channel', async () => {
      await contactsRecordConsent(db, { orgId, contactId: priyaId, channel: 'sms', granted: false, source: 'reply' })
      await contactsRecordConsent(db, { orgId, contactId: priyaId, channel: 'voice', granted: true, source: 'booking page' })
      const before = await touches()
      const out = await run(getConsent, { contactEmail: 'priya@rentman.io' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toContain('email: never asked — cold email allowed')
      expect(out.summary).toContain('sms: refused — will not be asked again')
      expect(out.summary).toMatch(/voice: granted \(booking page, \d{4}-\d{2}-\d{2}\)/)
      expect(out.summary).toContain('whatsapp: never asked — cannot be used')
      expect(out.summary).toMatch(/Nothing was changed and nothing was queued\.$/)
      expect(await touches()).toBe(before)
      expect(audited).toEqual([{ action: 'agent.get_consent', detail: { contactId: priyaId } }])
    })

    it('never calls an unreadable LinkedIn profile clear', async () => {
      await db.update(schema.contacts).set({ linkedinUrl: 'jane-doe' }).where(eq(schema.contacts.id, priyaId))
      const out = await run(getConsent, { contactEmail: 'priya@rentman.io' })
      if (!out.ok) throw new Error(out.message)
      const line = out.summary.split('\n').find((l) => l.trim().startsWith('LinkedIn:'))
      expect(line).toBe('  LinkedIn: could not be parsed — treated as suppressed')
      expect(line).not.toMatch(/clear/)
      expect((out.data as { suppression: { linkedin: string } }).suppression.linkedin).toBe('unparseable')
    })

    it('reports a suppression match by kind and path, never by value', async () => {
      await addSuppression(db, { orgId, kind: 'domain', value: 'rentman.io', reason: 'the company asked us to stop', source: 'manual' })
      const out = await run(getConsent, { contactEmail: 'priya@rentman.io' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toContain('email address: on the suppression list')
      expect(out.summary).toContain('matched by: domain (manual)')
      expect(out.summary).toContain('phone: nothing on file')
      expect(out.summary).not.toContain('the company asked us to stop')
      expect((out.data as { suppression: { matches: unknown[] } }).suppression.matches).toEqual([{ kind: 'domain', source: 'manual' }])
      expect(JSON.stringify(out.data)).not.toContain('the company asked')
    })

    it('says the person is paused when they are', async () => {
      await db.update(schema.contacts).set({ pausedAt: NOON_UTC, pausedReason: 'replied' }).where(eq(schema.contacts.id, priyaId))
      const out = await run(getConsent, { contactEmail: 'priya@rentman.io' })
      if (!out.ok) throw new Error(out.message)
      expect(out.summary.split('\n')[0]).toMatch(/paused/)
    })

    it('cannot read another org’s person', async () => {
      const out = await run(getConsent, { contactEmail: 'mallory@rentman.io' })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_found')
      expect(audited).toEqual([])
    })
  })
})

/**
 * Review round 10, [2]: a holder of a shared number whose STOP could not be
 * recorded, whose own pause — a teammate's — stood instead of the hold. The
 * class is `manual`, and `check_send` told the model a person resumes them
 * on /contacts, while Resume refuses until the number is recorded
 * (RESUME_SHARED_NUMBER_KEPT). Both tools read the gate's answer now,
 * `sharedNumberHold`, and say what Resume waits for — never that they asked.
 */
describe('the consent tools on a shared number’s holder whose own pause stood', () => {
  const PHONE = '+919812345678'
  const AT = new Date('2026-09-15T06:30:00.000Z')
  let test: TestDb
  let db: AgencyDb
  let orgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'acme.example', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    await db.insert(schema.campaigns).values({ orgId, name: 'Mail', channel: 'email', status: 'active', autoSend: false })
    const person = async (email: string) =>
      (await db
        .insert(schema.contacts)
        .values({ orgId, companyId: company!.id, email, phone: PHONE, timeZone: 'Asia/Kolkata' })
        .returning({ id: schema.contacts.id }))[0]!.id
    const jo = await person('jo@acme.example')
    const bina = await person('bina@acme.example')
    await db.insert(schema.touches).values({
      orgId, contactId: jo, companyId: company!.id, channel: 'sms', direction: 'out', status: 'sent',
      body: 'Hi Jo', recipient: PHONE, sentAt: new Date(AT.getTime() - 86_400_000), providerId: 'ds-1',
    })
    expect((await contactPauseByHand(db, { orgId, contactId: bina, reason: 'on leave (by sam@agency.test)', now: new Date(AT.getTime() - 60_000) })).ok).toBe(true)
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.kind = 'phone'` })
    const r = await recordInboundSms(db, { from: PHONE, text: 'Wrong number. STOP', providerMessageId: null, orgId, receivedAt: AT, log: { error: () => {} } })
    expect(r).toMatchObject({ matched: 'contact', optOutNotRecorded: true })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db,
    orgId,
    principal: { id: 'user-1', orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => AT,
    audit: async () => {},
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx())

  it('check_send says Resume waits for the number, after the teammate’s pause, and never that they asked', async () => {
    const out = await run(checkSend, { domain: 'acme.example', contactEmail: 'bina@acme.example', campaignName: 'Mail' })
    if (!out.ok) throw new Error(out.message)
    expect(out.data).toMatchObject({ code: 'paused', facts: { pausedFor: 'manual', sharedNumberHold: true } })
    expect(out.summary).toMatch(/^paused by a teammate \(on leave \(by sam@agency\.test\)\)/)
    expect(out.summary).toContain(
      'They also hold a phone number a text came from that asked to stop, and it could not be recorded — it may not ' +
        'have been them — so Resume is refused until a person records the number on /suppressions; do not suggest ' +
        'resuming them before that.',
    )
    expect(out.summary).not.toMatch(/they asked to stop/)
    expect(out.summary).toMatch(/Nothing was queued\.$/)
  })

  it('get_consent says they cannot be resumed until the number is recorded', async () => {
    const out = await run(getConsent, { contactEmail: 'bina@acme.example' })
    if (!out.ok) throw new Error(out.message)
    expect(out.data).toMatchObject({ paused: true, sharedNumberHold: true })
    expect(out.summary.split('\n')[0]).toBe(
      'bina@acme.example at acme.example — paused: nothing is sent to them, and they cannot be resumed until a person ' +
        'records a phone number they share on /suppressions — a text from it asked to stop and could not be recorded, ' +
        'and it may not have been them',
    )
  })

  it('says nothing of the kind once the number is recorded', async () => {
    await addSuppression(db, { orgId, kind: 'phone', value: PHONE, reason: 'texted STOP', source: 'manual' })
    const sent = await run(checkSend, { domain: 'acme.example', contactEmail: 'bina@acme.example', campaignName: 'Mail' })
    if (!sent.ok) throw new Error(sent.message)
    expect(sent.data).toMatchObject({ code: 'paused', facts: { sharedNumberHold: false } })
    expect(sent.summary).not.toContain('They also hold a phone number')
    const consent = await run(getConsent, { contactEmail: 'bina@acme.example' })
    if (!consent.ok) throw new Error(consent.message)
    expect(consent.summary.split('\n')[0]).toBe('bina@acme.example at acme.example — paused: nothing is sent to them until a person resumes them')
  })
})
