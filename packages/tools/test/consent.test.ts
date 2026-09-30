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
import { addSuppression, contactsRecordConsent, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
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

    it('says consent_revoked for a paused contact', async () => {
      await db.update(schema.contacts).set({ pausedAt: NOON_UTC, pausedReason: 'replied' }).where(eq(schema.contacts.id, priyaId))
      const out = await check()
      if (!out.ok) throw new Error(out.message)
      expect(out.data).toMatchObject({ code: 'consent_revoked', facts: { paused: true } })
      expect(out.summary).toMatch(/^consent_revoked: /)
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
