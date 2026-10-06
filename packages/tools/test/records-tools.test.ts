/**
 * The records tools, against a real Postgres engine: the companies and
 * people in the CRM, the pause, and the suppression list.
 *
 * What is asserted is what a careless handler gets wrong: a write that is
 * not the row the route would write, a refusal in words the route does not
 * use, another org's row reached by an id or an address, a person's address
 * or a pause's reason in the summary or the audit log, a company added by a
 * host the scanner refuses, an address changed under a message that is
 * already approved, and a pause lifted when it is no longer the one the
 * model read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { pauseReasonClass, type Principal } from '@agency/core'
import {
  contactResumeByHand, contactsUpdate, sharedNumberOptOutReason, type AgencyDb,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  addCompany, addContact, addSuppression, importCompanies, listContacts, pauseContact, resumeContact,
  updateCompany, updateContact, type AgencyToolSpec, type ToolContext, type ToolOutcome,
} from '../src/index.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOW = new Date('2026-09-15T12:00:00.000Z')
const REPLIED = 'replied 2026-09-14T10:00:00.000Z'
const OWN_OPT_OUT = 'opt-out not recorded: reply 2026-09-14T10:00:00.000Z (suppression_failed)'
const TEAMMATE = 'asked us to wait until Q1 (by sam@agency.test)'

/** The fixed words an `agent.*` detail may carry beside ids, counts and flags. */
const FIXED_WORDS = new Set([
  'email', 'domain', 'phone', 'linkedin',
  'replied', 'manual', 'unsubscribed', 'opt_out_not_recorded', 'erasure', 'other',
  'name', 'country', 'timeZone', 'firstName', 'lastName', 'title', 'linkedinUrl',
])

describe('the records tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let memberId: string
  let companyId: string
  let joId: string
  let rivalCompanyId: string
  let rivalContactId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'priya@agency.test', name: 'Priya Shah', role: 'owner' },
        { orgId, email: 'sam@agency.test', name: 'Sam Okafor', role: 'member' },
        { orgId: otherOrgId, email: 'outsider@rival.test', name: 'Outsider', role: 'owner' },
      ])
      .returning({ id: schema.users.id, email: schema.users.email })
    userId = users.find((u) => u.email === 'priya@agency.test')!.id
    memberId = users.find((u) => u.email === 'sam@agency.test')!.id

    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', country: 'Netherlands', timeZone: 'Europe/Amsterdam' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [jo] = await db
      .insert(schema.contacts)
      .values({
        orgId, companyId, firstName: 'Jo', lastName: 'Bloggs', title: 'CTO', email: 'jo@rentman.io',
        phone: '+31201234567', linkedinUrl: 'https://www.linkedin.com/in/jo-bloggs',
      })
      .returning({ id: schema.contacts.id })
    joId = jo!.id

    // Another org, holding the same domain and a company only it has.
    const [rival] = await db
      .insert(schema.companies)
      .values({ orgId: otherOrgId, domain: 'rentman.io', name: 'RIVAL RENTMAN' })
      .returning({ id: schema.companies.id })
    await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'rival-only.io', name: 'RIVAL ONLY' })
    rivalCompanyId = rival!.id
    const [rivalContact] = await db
      .insert(schema.contacts)
      .values({ orgId: otherOrgId, companyId: rivalCompanyId, firstName: 'RIVAL', lastName: 'PERSON', email: 'rival@rentman.io' })
      .returning({ id: schema.contacts.id })
    rivalContactId = rivalContact!.id
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
  const stranger = (): Partial<ToolContext> => ({
    principal: { id: userId, orgId, role: 'guest' as unknown as Principal['role'] },
  })
  const member = (): Partial<ToolContext> => ({ principal: { id: memberId, orgId, role: 'member' } })

  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }
  const refusalOf = (out: ToolOutcome<unknown>): { code: string; message: string } => {
    if (out.ok) throw new Error(`expected a refusal, got: ${out.summary}`)
    return { code: out.code, message: out.message }
  }
  const dataOf = <T,>(out: ToolOutcome<unknown>): T => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.data as T
  }

  /** Every `agent.*` value is an id, a count, a flag, a null or a fixed word — never somebody's words. */
  const idsOnly = (detail: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value === 'string') expect(UUID.test(value) || FIXED_WORDS.has(value), `${key}: ${value}`).toBe(true)
      else if (Array.isArray(value)) for (const v of value) expect(FIXED_WORDS.has(String(v)), `${key}: ${v}`).toBe(true)
      else expect(value === null || typeof value === 'number' || typeof value === 'boolean', key).toBe(true)
    }
  }

  const contactRow = async (id: string) =>
    (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!
  const companyRow = async (oid: string, domain: string) =>
    (await db.select().from(schema.companies).where(and(eq(schema.companies.orgId, oid), eq(schema.companies.domain, domain))))[0]
  const logOf = async (action: string) =>
    db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))
  const pause = (id: string, reason: string) =>
    db.update(schema.contacts).set({ pausedAt: new Date('2026-09-14T10:00:00.000Z'), pausedReason: reason }).where(eq(schema.contacts.id, id))
  const outbound = (status: string, extra: Partial<typeof schema.touches.$inferInsert> = {}) =>
    db.insert(schema.touches).values({
      orgId, companyId, contactId: joId, channel: 'email', direction: 'out', status, subject: 's', body: 'b',
      ...(status === 'approved' ? { approvedBy: userId, approvedAt: NOW } : {}),
      ...(status === 'sent' ? { sentAt: NOW, recipient: 'jo@rentman.io' } : {}),
      ...extra,
    })

  // -------------------------------------------------------------------------
  describe('list_contacts', () => {
    it('lists each person with what is on record, every address masked to its domain', async () => {
      await db.insert(schema.consents).values([
        { orgId, contactId: joId, channel: 'sms', granted: true, source: 'web form, 12 Sep' },
        { orgId, contactId: joId, channel: 'whatsapp', granted: false, source: 'said no on the call' },
      ])
      await db.insert(schema.suppressions).values({ orgId, kind: 'linkedin', value: 'in/jo-bloggs', reason: 'asked', source: 'manual' })
      const [sam] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId, firstName: 'Sam', lastName: 'Lee', phone: '+447700900123', timeZone: 'Europe/London' })
        .returning({ id: schema.contacts.id })
      await pause(sam!.id, TEAMMATE)
      await db.insert(schema.contacts).values({
        orgId, companyId, firstName: 'Bo', email: 'bo@rentman.io',
        emailBouncedAt: new Date('2026-09-10T08:30:00.000Z'), emailBounceCode: '5.1.1',
      })

      const out = await run(listContacts, { domain: 'www.rentman.io' })
      const summary = summaryOf(out)
      expect(summary).toMatch(/^3 people recorded at rentman\.io\. A read: nothing was changed and nothing was sent\./)
      expect(summary).toContain(`Jo Bloggs (CTO) · id ${joId} · email …@rentman.io, phone on file, LinkedIn on file`)
      expect(summary).toContain('zone Europe/Amsterdam (the company’s)')
      expect(summary).toContain('consent: email never asked, SMS granted, voice never asked, WhatsApp REFUSED')
      expect(summary).toContain('suppression: email clear, phone clear, LinkedIn ON THE LIST')
      expect(summary).toContain(`Sam Lee · id ${sam!.id} · phone on file · zone Europe/London ·`)
      expect(summary).toContain('PAUSED since 2026-09-14 10:00 UTC (pausedFor: manual) — a teammate’s hold')
      expect(summary).toContain('email BOUNCED 2026-09-10 08:30 UTC (5.1.1)')
      // Never an address, a number, a profile or a pause's reason.
      for (const secret of ['jo@rentman.io', 'bo@rentman.io', '+31201234567', '+447700900123', 'jo-bloggs', 'Q1', 'sam@agency.test']) {
        expect(summary).not.toContain(secret)
        expect(JSON.stringify(dataOf(out))).not.toContain(secret)
      }
      const contacts = dataOf<{ contacts: Array<{ contactId: string; pausedFor: string | null; email: string | null }> }>(out).contacts
      expect(contacts.map((c) => c.contactId)).toContain(joId)
      expect(contacts.find((c) => c.contactId === sam!.id)!.pausedFor).toBe('manual')
      expect(contacts.find((c) => c.contactId === joId)!.email).toBe('…@rentman.io')

      expect(audited).toEqual([{ action: 'agent.list_contacts', detail: { companyId, returned: 3, more: false } }])
      idsOnly(audited[0]!.detail)
    })

    it('says when more are recorded than the limit shows', async () => {
      await db.insert(schema.contacts).values({ orgId, companyId, firstName: 'Second', email: 'second@rentman.io' })
      const out = await run(listContacts, { domain: 'rentman.io', limit: 1 })
      expect(summaryOf(out)).toContain('1 person recorded at rentman.io — more are recorded than shown')
      expect(dataOf<{ contacts: unknown[]; more: boolean }>(out)).toMatchObject({ more: true })
      expect(audited[0]!.detail).toEqual({ companyId, returned: 1, more: true })
    })

    it('shows a shared number’s hold as the number’s — never as their own opt-out', async () => {
      await pause(joId, sharedNumberOptOutReason(new Date('2026-09-14T10:00:00.000Z'), 'suppression_failed'))
      const summary = summaryOf(await run(listContacts, { domain: 'rentman.io' }))
      expect(summary).toContain('(pausedFor: opt_out_not_recorded) — a text from a phone number they share')
      expect(summary).toContain('it may not have been them')
      expect(summary).not.toContain('they asked to stop')
    })

    it('answers another org’s company as nobody’s, and never lists another org’s people', async () => {
      const out = await run(listContacts, { domain: 'rival-only.io' })
      expect(out).toMatchObject({ ok: false, code: 'not_found' })
      expect(JSON.stringify(out)).not.toContain('RIVAL')
      // The same domain in both orgs: only this org's people.
      const mine = await run(listContacts, { domain: 'rentman.io' })
      expect(JSON.stringify(mine)).not.toContain('RIVAL')
      expect(JSON.stringify(mine)).not.toContain(rivalContactId)
      expect(audited.map((a) => a.action)).toEqual(['agent.list_contacts'])
    })

    it('says nobody is recorded at a company with no people', async () => {
      await db.insert(schema.companies).values({ orgId, domain: 'empty-co.io' })
      expect(summaryOf(await run(listContacts, { domain: 'empty-co.io' }))).toContain('Nobody is recorded at empty-co.io.')
    })

    it('refuses a role can() does not know', async () => {
      expect(await run(listContacts, { domain: 'rentman.io' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('add_company', () => {
    it('adds the company as the import does (source agent), sets country and zone through companiesUpdate, and scans nothing', async () => {
      const out = await run(addCompany, {
        domain: 'https://www.Acme-Robotics.io/about', name: ' Acme Robotics ', country: 'Netherlands', timeZone: 'Europe/Amsterdam',
      })
      const summary = summaryOf(out)
      const row = await companyRow(orgId, 'acme-robotics.io')
      expect(row).toMatchObject({ name: 'Acme Robotics', country: 'Netherlands', timeZone: 'Europe/Amsterdam', source: 'agent' })
      expect(await db.select().from(schema.scans)).toEqual([])
      expect(summary).toContain('Added acme-robotics.io to the CRM: named Acme Robotics, country Netherlands, time zone Europe/Amsterdam.')
      expect(summary).toContain('ask to scan it with scan_company')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)

      // The route's own row for the edit, with the agent as actor.
      const log = await logOf('company.updated')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectType: 'company', subjectId: row!.id, detail: { fields: ['country', 'timeZone'] } })
      expect(audited).toEqual([{ action: 'agent.add_company', detail: { companyId: row!.id, created: true } }])
      idsOnly(audited[0]!.detail)
    })

    it('is idempotent: a company already there is left exactly as it is', async () => {
      const out = await run(addCompany, { domain: 'rentman.io', name: 'Renamed', timeZone: 'Asia/Tokyo' })
      expect(dataOf(out)).toMatchObject({ companyId, created: false })
      expect(summaryOf(out)).toContain('rentman.io is already in the CRM')
      expect(summaryOf(out)).toContain('nothing was changed')
      expect(await companyRow(orgId, 'rentman.io')).toMatchObject({ name: 'Rentman', timeZone: 'Europe/Amsterdam' })
      expect(await logOf('company.updated')).toEqual([])
      expect(audited).toEqual([{ action: 'agent.add_company', detail: { companyId, created: false } }])
    })

    it.each([
      ['localhost', 'not_permitted'],
      ['169.254.169.254', 'not_permitted'],
      ['http://10.0.0.1/admin', 'not_permitted'],
      ['intranet.corp', 'not_permitted'],
      ['acme.test', 'not_permitted'],
      ['jane-doe-gmail-com.inbound', 'not_permitted'],
      ['not a domain', 'not_permitted'],
      ['https://', 'invalid_state'],
    ])('refuses %s, a host the scanner would refuse, and writes nothing', async (domain, code) => {
      const before = await db.select().from(schema.companies)
      const out = await run(addCompany, { domain })
      expect(refusalOf(out).code).toBe(code)
      expect(refusalOf(out).message).toContain('Nothing was added.')
      expect(await db.select().from(schema.companies)).toHaveLength(before.length)
      expect(audited).toEqual([])
    })

    it('refuses an unknown zone before adding anything, in companiesUpdate’s words', async () => {
      const out = await run(addCompany, { domain: 'acme-robotics.io', timeZone: 'Mars/Olympus' })
      expect(refusalOf(out)).toEqual({
        code: 'invalid_state',
        message: '"Mars/Olympus" is not a timezone this system recognises. Use an IANA name like Europe/London. Nothing was added.',
      })
      expect(await companyRow(orgId, 'acme-robotics.io')).toBeUndefined()
    })

    it('adds this org’s own row for a domain another org holds, and leaves theirs alone', async () => {
      const out = await run(addCompany, { domain: 'rival-only.io', name: 'Ours' })
      expect(dataOf(out)).toMatchObject({ created: true })
      expect(await companyRow(orgId, 'rival-only.io')).toMatchObject({ name: 'Ours', source: 'agent' })
      expect(await companyRow(otherOrgId, 'rival-only.io')).toMatchObject({ name: 'RIVAL ONLY' })
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      expect(await run(addCompany, { domain: 'acme-robotics.io' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await companyRow(orgId, 'acme-robotics.io')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  describe('update_company', () => {
    it('changes the name and zone through companiesUpdate, and writes the route’s row with the agent as actor', async () => {
      const out = await run(updateCompany, { domain: 'rentman.io', name: 'Rentman BV', timeZone: 'Europe/London' })
      const summary = summaryOf(out)
      expect(await companyRow(orgId, 'rentman.io')).toMatchObject({ name: 'Rentman BV', country: 'Netherlands', timeZone: 'Europe/London' })
      expect(summary).toContain('rentman.io: changed its name, time zone — now named Rentman BV, country Netherlands, time zone Europe/London.')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
      const log = await logOf('company.updated')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectId: companyId, detail: { fields: ['name', 'timeZone'] } })
      expect(audited).toEqual([{ action: 'agent.update_company', detail: { companyId, fields: ['name', 'timeZone'] } }])
      idsOnly(audited[0]!.detail)
    })

    it('refuses an unknown zone in companiesUpdate’s words, and changes nothing — the name included', async () => {
      const out = await run(updateCompany, { domain: 'rentman.io', name: 'Renamed', timeZone: 'Europe/Atlantis' })
      expect(refusalOf(out)).toEqual({
        code: 'invalid_state',
        message: '"Europe/Atlantis" is not a timezone this system recognises. Use an IANA name like Europe/London. Nothing was changed.',
      })
      expect(await companyRow(orgId, 'rentman.io')).toMatchObject({ name: 'Rentman', timeZone: 'Europe/Amsterdam' })
      expect(await logOf('company.updated')).toEqual([])
      expect(audited).toEqual([])
    })

    it('answers another org’s company as missing, and leaves it untouched', async () => {
      expect(await run(updateCompany, { domain: 'rival-only.io', name: 'Mine now' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await companyRow(otherOrgId, 'rival-only.io')).toMatchObject({ name: 'RIVAL ONLY' })
    })

    it('says what clearing the zone means', async () => {
      const summary = summaryOf(await run(updateCompany, { domain: 'rentman.io', timeZone: '' }))
      expect((await companyRow(orgId, 'rentman.io'))!.timeZone).toBeNull()
      expect(summary).toContain('nothing can be sent to people at this company who have none of their own')
    })

    it('writes no route row when nothing changed, and asks what to change when nothing is named', async () => {
      expect(summaryOf(await run(updateCompany, { domain: 'rentman.io', name: 'Rentman' }))).toContain('nothing changed')
      expect(await logOf('company.updated')).toEqual([])
      expect(await run(updateCompany, { domain: 'rentman.io' })).toMatchObject({ ok: false, code: 'invalid_state' })
    })

    it('refuses a role can() does not know, and changes nothing', async () => {
      expect(await run(updateCompany, { domain: 'rentman.io', name: 'X' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await companyRow(orgId, 'rentman.io')).toMatchObject({ name: 'Rentman' })
    })
  })

  // -------------------------------------------------------------------------
  describe('import_companies', () => {
    it('adds the new, leaves the present, and refuses what the scanner would refuse — line by line', async () => {
      const out = await run(importCompanies, {
        companies: [
          { domain: 'acme-robotics.io', name: 'Acme' },
          { domain: 'rentman.io', name: 'Renamed' },
          { domain: 'localhost' },
          { domain: 'www.acme-robotics.io', name: 'Acme again' },
          { domain: 'beta-labs.com' },
          { domain: '192.168.1.1' },
        ],
      })
      const data = dataOf<{ lines: Array<{ line: number; domain: string; outcome: string }> }>(out)
      expect(data.lines.map((l) => [l.line, l.domain, l.outcome])).toEqual([
        [1, 'acme-robotics.io', 'added'],
        [2, 'rentman.io', 'already_present'],
        [3, 'localhost', 'refused'],
        [4, 'acme-robotics.io', 'duplicate'],
        [5, 'beta-labs.com', 'added'],
        [6, '192.168.1.1', 'refused'],
      ])
      expect(await companyRow(orgId, 'acme-robotics.io')).toMatchObject({ name: 'Acme', source: 'agent' })
      expect(await companyRow(orgId, 'beta-labs.com')).toMatchObject({ name: null, source: 'agent' })
      expect(await companyRow(orgId, 'rentman.io')).toMatchObject({ name: 'Rentman' })
      expect(await companyRow(orgId, 'localhost')).toBeUndefined()

      const summary = summaryOf(out)
      expect(summary).toMatch(/^2 companies added, 1 already in the CRM, 2 refused, 1 listed twice \(counted once\)\./)
      expect(summary).toContain('Refused, line 3 ("localhost"): "localhost" is not a public hostname.')
      expect(summary).toContain('Already in the CRM, left as they were: rentman.io')
      expect(summary).toContain('scan_company')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
      expect(await db.select().from(schema.scans)).toEqual([])
      expect(audited).toEqual([{
        action: 'agent.import_companies', detail: { added: 2, alreadyPresent: 1, refused: 2, duplicates: 1 },
      }])
      idsOnly(audited[0]!.detail)
    })

    it('never reaches another org: a domain they hold is added here as this org’s own', async () => {
      const out = await run(importCompanies, { companies: [{ domain: 'rival-only.io', name: 'Ours' }] })
      expect(dataOf<{ added: number }>(out).added).toBe(1)
      expect(await companyRow(otherOrgId, 'rival-only.io')).toMatchObject({ name: 'RIVAL ONLY' })
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      expect(await run(importCompanies, { companies: [{ domain: 'acme-robotics.io' }] }, stranger()))
        .toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await companyRow(orgId, 'acme-robotics.io')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  describe('add_contact', () => {
    it('adds the person through createContact — E.164 phone, source agent — and records no consent of any kind', async () => {
      const out = await run(addContact, {
        domain: 'rentman.io', firstName: 'Ana', lastName: 'Silva', title: 'Head of Security',
        email: ' Ana.Silva@Rentman.io ', phone: '+31 6 1234 5678', linkedinUrl: 'linkedin.com/in/ana-silva',
        timeZone: 'Europe/Lisbon',
      })
      const { contactId } = dataOf<{ contactId: string }>(out)
      expect(await contactRow(contactId)).toMatchObject({
        orgId, companyId, firstName: 'Ana', lastName: 'Silva', title: 'Head of Security', email: 'ana.silva@rentman.io',
        phone: '+31612345678', linkedinUrl: 'linkedin.com/in/ana-silva', timeZone: 'Europe/Lisbon', source: 'agent',
        pausedAt: null,
      })
      // §1: absence is no, and no row is ever created by default.
      expect(await db.select().from(schema.consents).where(eq(schema.consents.contactId, contactId))).toEqual([])

      const summary = summaryOf(out)
      expect(summary).toContain(`Added Ana Silva (Head of Security) at rentman.io — id ${contactId}; on file: email …@rentman.io`)
      expect(summary).toContain('No consent row of any kind was recorded, and absence is a no')
      expect(summary).toContain('Quiet hours are checked in their zone, Europe/Lisbon.')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
      expect(summary).not.toContain('ana.silva@')
      expect(summary).not.toContain('+31612345678')

      const log = await logOf('contact.created')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({
        actor: 'agent', subjectType: 'contact', subjectId: contactId, detail: { companyId, source: 'agent', hasTimeZone: true },
      })
      expect(audited).toEqual([{ action: 'agent.add_contact', detail: { contactId, companyId } }])
      idsOnly(audited[0]!.detail)
    })

    it.each([
      [{ phone: '020 7946 0958' }, 'is not a number in international form'],
      [{ email: 'ana@rentman.io', linkedinUrl: 'ana-silva' }, 'could not be read as a LinkedIn profile'],
      [{ email: 'ana@rentman.io', timeZone: 'Mars/Base' }, '"Mars/Base" is not a timezone this system recognises'],
      [{ email: 'Jo@Rentman.io' }, 'jo@rentman.io is already a contact in this CRM.'],
      [{ email: 'not an address' }, 'could not be read as an email address'],
      [{ firstName: 'Nobody' }, 'A contact needs at least one way to reach them.'],
    ])('refuses %o in the route’s words, and writes nothing', async (fields, words) => {
      const before = await db.select().from(schema.contacts)
      const out = await run(addContact, { domain: 'rentman.io', ...fields })
      expect(refusalOf(out).code).toBe('invalid_state')
      expect(refusalOf(out).message).toContain(words)
      expect(refusalOf(out).message).toContain('Nothing was added.')
      expect(await db.select().from(schema.contacts)).toHaveLength(before.length)
      expect(await logOf('contact.created')).toEqual([])
      expect(audited).toEqual([])
    })

    it('answers another org’s company as missing; an address only another org holds is no duplicate here', async () => {
      expect(await run(addContact, { domain: 'rival-only.io', email: 'x@rival-only.io' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'x@rival-only.io'))).toEqual([])
      // `rival@rentman.io` is a contact in the other org only.
      const out = await run(addContact, { domain: 'rentman.io', email: 'rival@rentman.io' })
      expect(dataOf<{ contactId: string }>(out).contactId).not.toBe(rivalContactId)
      expect(await contactRow(rivalContactId)).toMatchObject({ orgId: otherOrgId, firstName: 'RIVAL' })
    })

    it('says when neither the person nor the company has a time zone', async () => {
      await db.insert(schema.companies).values({ orgId, domain: 'zoneless.io' })
      const summary = summaryOf(await run(addContact, { domain: 'zoneless.io', email: 'a@zoneless.io' }))
      expect(summary).toContain('Neither they nor zoneless.io has a time zone')
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      expect(await run(addContact, { domain: 'rentman.io', email: 'ana@rentman.io' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'ana@rentman.io'))).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('update_contact', () => {
    it('changes the title through contactsUpdate and the zone as the route’s timeZone action does', async () => {
      const out = await run(updateContact, { contactId: joId, title: 'CISO', timeZone: 'Europe/London' })
      expect(await contactRow(joId)).toMatchObject({ title: 'CISO', timeZone: 'Europe/London', email: 'jo@rentman.io' })
      const summary = summaryOf(out)
      expect(summary).toContain(`Updated Jo Bloggs (CISO) at rentman.io — id ${joId}: changed their title, time zone.`)
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
      expect((await logOf('contact.updated'))[0]).toMatchObject({ actor: 'agent', subjectId: joId, detail: { fields: ['title'] } })
      expect((await logOf('contact.timezone_set'))[0]).toMatchObject({ actor: 'agent', subjectId: joId, detail: { timeZone: 'Europe/London' } })
      expect(audited).toEqual([{ action: 'agent.update_contact', detail: { contactId: joId, fields: ['title', 'timeZone'], bounceCleared: false } }])
      idsOnly(audited[0]!.detail)
    })

    it('finds the person by their address on file too', async () => {
      await run(updateContact, { contactEmail: ' JO@rentman.io', firstName: 'Joanna' })
      expect((await contactRow(joId)).firstName).toBe('Joanna')
    })

    it.each(['awaiting_approval', 'approved', 'queued', 'sending'])(
      'will not change an address while a message is %s — a person does that on /contacts',
      async (status) => {
        await outbound(status)
        for (const change of [
          { email: 'jo.bloggs@rentman.io' },
          { phone: '+31 20 999 9999' },
          { linkedinUrl: 'linkedin.com/in/someone-else' },
          { email: '' },
        ]) {
          const out = await run(updateContact, { contactId: joId, ...change })
          expect(refusalOf(out).code).toBe('invalid_state')
          expect(refusalOf(out).message).toContain('a person changes where their messages go, on /contacts')
          expect(refusalOf(out).message).toContain('Nothing was changed.')
        }
        expect(await contactRow(joId)).toMatchObject({
          email: 'jo@rentman.io', phone: '+31201234567', linkedinUrl: 'https://www.linkedin.com/in/jo-bloggs',
        })
        expect(await logOf('contact.updated')).toEqual([])
        // Name, title and zone still may; so may a respelling of the same number or profile.
        await run(updateContact, { contactId: joId, title: 'CISO', timeZone: 'Asia/Tokyo', phone: '+31 20 123 4567' })
        expect(await contactRow(joId)).toMatchObject({ title: 'CISO', timeZone: 'Asia/Tokyo', phone: '+31201234567' })
      },
    )

    it('changes an address once nothing to THEM is waiting — a sent message, or a colleague’s draft, does not hold it', async () => {
      await outbound('sent')
      const [bo] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId, firstName: 'Bo', email: 'bo@rentman.io' })
        .returning({ id: schema.contacts.id })
      await outbound('approved', { contactId: bo!.id })
      const out = await run(updateContact, { contactId: joId, email: 'Jo.Bloggs@Rentman.io' })
      expect(summaryOf(out)).toContain('Their email is now …@rentman.io.')
      expect((await contactRow(joId)).email).toBe('jo.bloggs@rentman.io')
    })

    it('refuses to move them out from under their own opt-out, in contactsUpdate’s words', async () => {
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'jo@rentman.io', reason: 'asked', source: 'manual' })
      const out = await run(updateContact, { contactId: joId, email: 'jo.new@elsewhere.io' })
      const direct = await contactsUpdate(db, orgId, joId, { email: 'jo.new@elsewhere.io' })
      expect(direct).toMatchObject({ ok: false, reason: 'suppressed' })
      if (direct.ok) return
      expect(refusalOf(out)).toEqual({ code: 'invalid_state', message: `${direct.message} Nothing was changed.` })
      expect((await contactRow(joId)).email).toBe('jo@rentman.io')
    })

    it('refuses to move a shared number’s holder off the number, in contactsUpdate’s words', async () => {
      await pause(joId, sharedNumberOptOutReason(new Date('2026-09-14T10:00:00.000Z'), 'suppression_failed'))
      const out = await run(updateContact, { contactId: joId, phone: '+31 20 555 0000' })
      const direct = await contactsUpdate(db, orgId, joId, { phone: '+31 20 555 0000' })
      expect(direct).toMatchObject({ ok: false, reason: 'shared_number_hold' })
      if (direct.ok) return
      expect(refusalOf(out)).toEqual({ code: 'invalid_state', message: direct.message })
      expect((await contactRow(joId)).phone).toBe('+31201234567')
    })

    it('lifts a bounce mark with the address, and says so', async () => {
      await db.update(schema.contacts).set({ emailBouncedAt: NOW, emailBounceCode: '5.1.1' }).where(eq(schema.contacts.id, joId))
      const out = await run(updateContact, { contactId: joId, email: 'jo.b@rentman.io' })
      expect(summaryOf(out)).toContain('The bounce mark on their old address was lifted with it.')
      expect(await contactRow(joId)).toMatchObject({ emailBouncedAt: null, emailBounceCode: null })
      expect((await logOf('contact.bounce_cleared'))[0]).toMatchObject({ actor: 'agent', detail: { code: '5.1.1' } })
      expect(audited[0]!.detail).toMatchObject({ bounceCleared: true })
    })

    it('answers another org’s contact as nobody — by id and by address — and changes nothing', async () => {
      const byId = refusalOf(await run(updateContact, { contactId: rivalContactId, title: 'Mine now' }))
      const byEmail = refusalOf(await run(updateContact, { contactEmail: 'rival@rentman.io', title: 'Mine now' }))
      const unknown = refusalOf(await run(updateContact, { contactId: '99999999-9999-4999-8999-999999999999', title: 'x' }))
      expect(byId).toEqual(unknown)
      expect(byId.code).toBe('not_found')
      expect(byEmail.code).toBe('not_found')
      expect(await contactRow(rivalContactId)).toMatchObject({ title: null })
      expect(audited).toEqual([])
    })

    it('takes exactly one of contactId and contactEmail, and asks what to change', async () => {
      expect(await run(updateContact, { contactId: joId, contactEmail: 'jo@rentman.io', title: 'x' })).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(await run(updateContact, { title: 'x' })).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(await run(updateContact, { contactId: joId })).toMatchObject({ ok: false, code: 'invalid_state' })
      expect((await contactRow(joId)).title).toBe('CTO')
    })

    it('says nothing changed when nothing did, and writes no route row', async () => {
      expect(summaryOf(await run(updateContact, { contactId: joId, title: 'CTO' }))).toContain('Nothing changed for Jo Bloggs')
      expect(await logOf('contact.updated')).toEqual([])
    })

    it('refuses a role can() does not know, and changes nothing', async () => {
      expect(await run(updateContact, { contactId: joId, title: 'x' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await contactRow(joId)).title).toBe('CTO')
    })
  })

  // -------------------------------------------------------------------------
  describe('pause_contact', () => {
    it('pauses them as a teammate’s hold, and writes the route’s row with the agent as actor', async () => {
      const out = await run(pauseContact, { contactId: joId, reason: 'Out of office until March' })
      const row = await contactRow(joId)
      expect(row.pausedAt).toEqual(NOW)
      expect(row.pausedReason).toBe('Out of office until March (by the agent, for priya@agency.test)')
      expect(pauseReasonClass(row.pausedReason)).toBe('manual')
      const summary = summaryOf(out)
      expect(summary).toContain(`Paused Jo Bloggs (CTO) at rentman.io — id ${joId} (pausedFor: manual): they are held from every campaign`)
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
      expect(summary).not.toContain('Out of office')

      const log = await logOf('contact.paused')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({
        actor: 'agent', subjectType: 'contact', subjectId: joId, detail: { reason: 'Out of office until March', alreadyPaused: false },
      })
      expect(audited).toEqual([{ action: 'agent.pause_contact', detail: { contactId: joId, replacedPauseFor: null } }])
      idsOnly(audited[0]!.detail)
    })

    it('takes the place of the pause their reply caused, as the route does', async () => {
      await pause(joId, REPLIED)
      const summary = summaryOf(await run(pauseContact, { contactEmail: 'jo@rentman.io', reason: 'they asked for a call in May' }))
      expect(pauseReasonClass((await contactRow(joId)).pausedReason)).toBe('manual')
      expect(summary).toContain('answering that reply from /inbox no longer lifts it')
      expect((await logOf('contact.paused'))[0]!.detail).toMatchObject({ replacedPauseFor: 'replied' })
      expect(audited[0]!.detail).toEqual({ contactId: joId, replacedPauseFor: 'replied' })
    })

    it.each([TEAMMATE, OWN_OPT_OUT])('leaves the pause “%s” standing, in the route’s sentence', async (reason) => {
      await pause(joId, reason)
      const out = await run(pauseContact, { contactId: joId, reason: 'something else' })
      expect(refusalOf(out).code).toBe('invalid_state')
      expect(refusalOf(out).message).toContain('that pause stands')
      expect((await contactRow(joId)).pausedReason).toBe(reason)
      expect(await logOf('contact.paused')).toEqual([])
    })

    it('refuses a reason that would read as an opt-out nobody could record', async () => {
      const out = await run(pauseContact, { contactId: joId, reason: 'opt-out not recorded: they said so' })
      expect(refusalOf(out).code).toBe('invalid_state')
      expect((await contactRow(joId)).pausedAt).toBeNull()
    })

    it('answers another org’s contact as nobody, and pauses nobody', async () => {
      expect(await run(pauseContact, { contactId: rivalContactId, reason: 'hold' })).toMatchObject({ ok: false, code: 'not_found' })
      expect((await contactRow(rivalContactId)).pausedAt).toBeNull()
    })

    it('refuses a role can() does not know', async () => {
      expect(await run(pauseContact, { contactId: joId, reason: 'hold' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await contactRow(joId)).pausedAt).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('resume_contact', () => {
    /** What the /contacts Resume would answer for the same contact, now — the route's own sentence. */
    const routeSays = async (id: string): Promise<string> => {
      const row = await contactRow(id)
      const r = await contactResumeByHand(db, { orgId, contact: { id }, expectedReason: row.pausedReason, actor: userId })
      if (r.ok) throw new Error('the route would have resumed them')
      return r.message
    }

    it('lifts a teammate’s hold through contactResumeByHand, which writes contact.resumed with the agent as actor', async () => {
      await pause(joId, TEAMMATE)
      const out = await run(resumeContact, { contactId: joId, pausedFor: 'manual' })
      expect(await contactRow(joId)).toMatchObject({ pausedAt: null, pausedReason: null })
      const summary = summaryOf(out)
      expect(summary).toContain(`Resumed Jo Bloggs (CTO) at rentman.io — id ${joId}`)
      expect(summary).toContain('only through the send rules')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
      const log = await logOf('contact.resumed')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectId: joId, detail: { pausedFor: 'manual' } })
      expect(audited).toEqual([{ action: 'agent.resume_contact', detail: { contactId: joId, pausedFor: 'manual' } }])
      idsOnly(audited[0]!.detail)
      // The reason's words reach neither the model nor the log.
      expect(JSON.stringify([out, log, audited])).not.toContain('Q1')
      expect(JSON.stringify([out, log, audited])).not.toContain('sam@agency.test')
    })

    it('lifts nothing when the pause is no longer of the class it read', async () => {
      await pause(joId, REPLIED)
      const out = await run(resumeContact, { contactId: joId, pausedFor: 'manual' })
      expect(refusalOf(out).code).toBe('invalid_state')
      expect(refusalOf(out).message).toContain('The pause changed since you read it: it is now pausedFor replied')
      expect((await contactRow(joId)).pausedReason).toBe(REPLIED)
      expect(await logOf('contact.resumed')).toEqual([])
    })

    it('refuses an opt-out nobody recorded, in the route’s words', async () => {
      await pause(joId, OWN_OPT_OUT)
      const out = await run(resumeContact, { contactId: joId, pausedFor: 'opt_out_not_recorded' })
      expect(refusalOf(out)).toEqual({ code: 'invalid_state', message: await routeSays(joId) })
      expect(refusalOf(out).message).toContain('An opt-out is not something to resume')
      expect((await contactRow(joId)).pausedReason).toBe(OWN_OPT_OUT)
      expect(audited).toEqual([])
    })

    it('refuses a shared number’s holder until the number is recorded — then add_suppression records it and Resume lifts it', async () => {
      const held = sharedNumberOptOutReason(new Date('2026-09-14T10:00:00.000Z'), 'suppression_failed')
      await pause(joId, held)
      const refused = await run(resumeContact, { contactId: joId, pausedFor: 'opt_out_not_recorded' })
      expect(refusalOf(refused)).toEqual({ code: 'invalid_state', message: await routeSays(joId) })
      expect(refusalOf(refused).message).toContain('Record the number on /suppressions')
      expect((await contactRow(joId)).pausedReason).toBe(held)

      summaryOf(await run(addSuppression, { kind: 'phone', value: '+31 20 123 4567', reason: 'the number texted STOP' }))
      summaryOf(await run(resumeContact, { contactId: joId, pausedFor: 'opt_out_not_recorded' }))
      expect((await contactRow(joId)).pausedAt).toBeNull()
      expect((await logOf('contact.resumed'))[0]).toMatchObject({ actor: 'agent', detail: { pausedFor: 'opt_out_not_recorded' } })
    })

    it('refuses a holder whose own pause stood, while the number is unrecorded, in the route’s words', async () => {
      await pause(joId, TEAMMATE)
      await db.insert(schema.auditLog).values({
        orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: null, subjectId: null,
        detail: { channel: 'sms', why: 'record_failed', sharedNumber: true, contacts: 1, paused: 1, kept: 1, holders: [joId] },
      })
      const out = await run(resumeContact, { contactId: joId, pausedFor: 'manual' })
      expect(refusalOf(out)).toEqual({ code: 'invalid_state', message: await routeSays(joId) })
      expect(refusalOf(out).message).toContain('nobody who holds the number can be resumed')
      expect((await contactRow(joId)).pausedReason).toBe(TEAMMATE)
    })

    it('refuses an erasure that did not finish, in the route’s words', async () => {
      const erasure = 'erasure failed 2026-09-14T10:00:00.000Z (unreadable_phone)'
      await pause(joId, erasure)
      const out = await run(resumeContact, { contactId: joId, pausedFor: 'erasure' })
      expect(refusalOf(out)).toEqual({ code: 'invalid_state', message: await routeSays(joId) })
      expect((await contactRow(joId)).pausedReason).toBe(erasure)
    })

    it('refuses while a colleague’s stop on the thread is unrecorded, naming the address to record', async () => {
      await pause(joId, REPLIED)
      await db.insert(schema.touches).values({
        orgId, companyId, contactId: joId, channel: 'email', direction: 'in', status: 'replied',
        recipient: 'colleague@rentman.io', replyKind: 'opted_out', body: 'please remove me', sentAt: NOW,
      })
      const out = await run(resumeContact, { contactId: joId, pausedFor: 'replied' })
      expect(refusalOf(out)).toEqual({ code: 'invalid_state', message: await routeSays(joId) })
      expect(refusalOf(out).message).toContain('Record THAT address')
      expect((await contactRow(joId)).pausedReason).toBe(REPLIED)
    })

    it('says so when they are not paused', async () => {
      const out = await run(resumeContact, { contactId: joId, pausedFor: 'manual' })
      expect(refusalOf(out)).toEqual({
        code: 'invalid_state', message: 'This contact is not paused, so there is nothing to resume. Nothing was changed.',
      })
    })

    it('answers another org’s contact as nobody, and resumes nobody', async () => {
      await pause(rivalContactId, TEAMMATE)
      expect(await run(resumeContact, { contactId: rivalContactId, pausedFor: 'manual' })).toMatchObject({ ok: false, code: 'not_found' })
      expect((await contactRow(rivalContactId)).pausedReason).toBe(TEAMMATE)
    })

    it('refuses a role can() does not know', async () => {
      await pause(joId, TEAMMATE)
      expect(await run(resumeContact, { contactId: joId, pausedFor: 'manual' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await contactRow(joId)).pausedReason).toBe(TEAMMATE)
    })
  })

  // -------------------------------------------------------------------------
  describe('add_suppression', () => {
    it('records the normalised value as the suppressions page does — source manual, its audit row with the agent as actor', async () => {
      const out = await run(addSuppression, { kind: 'email', value: '  Stop@Example-Corp.com ', reason: 'asked by phone to stop' })
      const rows = await db.select().from(schema.suppressions)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ orgId, kind: 'email', value: 'stop@example-corp.com', source: 'manual', reason: 'asked by phone to stop' })
      const summary = summaryOf(out)
      expect(summary).toContain('Email address suppression recorded — nothing will be sent to the address you gave')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
      expect(summary.toLowerCase()).not.toContain('stop@')
      expect(summary.toLowerCase()).not.toContain('example-corp')

      const log = await logOf('suppression.added')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({
        actor: 'agent', subjectType: 'suppression', detail: { kind: 'email', value: 'stop@example-corp.com', reason: 'asked by phone to stop' },
      })
      expect(audited).toEqual([{ action: 'agent.add_suppression', detail: { suppressionId: rows[0]!.id, kind: 'email', alreadyPresent: false } }])
      idsOnly(audited[0]!.detail)
    })

    it('adds a value already on the list as already present, and changes nothing', async () => {
      await run(addSuppression, { kind: 'domain', value: 'Example-Corp.com', reason: 'whole company asked' })
      const out = await run(addSuppression, { kind: 'domain', value: 'https://www.example-corp.com/', reason: 'again' })
      expect(summaryOf(out)).toContain('was already recorded')
      expect(await db.select().from(schema.suppressions)).toHaveLength(1)
      expect((await logOf('suppression.already_present'))[0]).toMatchObject({ actor: 'agent', detail: { kind: 'domain', value: 'example-corp.com' } })
      expect(audited[1]!.detail).toMatchObject({ kind: 'domain', alreadyPresent: true })
    })

    it.each([
      ['phone', '020 7946 0958', 'is not a number in international form'],
      ['linkedin', 'jo-bloggs', 'could not be read as a LinkedIn profile'],
      ['email', 'nobody', 'could not be read as an email address'],
    ] as const)('refuses a %s it cannot read, in addSuppression’s words, and records nothing', async (kind, value, words) => {
      const out = await run(addSuppression, { kind, value, reason: 'asked' })
      expect(refusalOf(out).code).toBe('invalid_state')
      expect(refusalOf(out).message).toContain(words)
      expect(await db.select().from(schema.suppressions)).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses a reason of nothing but spaces, in addSuppression’s words', async () => {
      const out = await run(addSuppression, { kind: 'email', value: 'a@b.io', reason: '   ' })
      expect(refusalOf(out).message).toContain('Say why this is suppressed')
      expect(await db.select().from(schema.suppressions)).toEqual([])
    })

    it('writes in this org only — another org holding the same value is neither “already present” here nor touched', async () => {
      await db.insert(schema.suppressions).values({ orgId: otherOrgId, kind: 'email', value: 'shared@rentman.io', reason: 'THEIRS', source: 'reply' })
      const out = await run(addSuppression, { kind: 'email', value: 'shared@rentman.io', reason: 'asked' })
      expect(dataOf(out)).toMatchObject({ alreadyPresent: false })
      const mine = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
      expect(mine).toHaveLength(1)
      expect(audited[0]!.detail).toMatchObject({ suppressionId: mine[0]!.id })
      const theirs = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, otherOrgId))
      expect(theirs).toEqual([expect.objectContaining({ value: 'shared@rentman.io', reason: 'THEIRS', source: 'reply' })])
      expect(JSON.stringify(out)).not.toContain('THEIRS')
    })

    it('refuses a role can() does not know, and records nothing', async () => {
      expect(await run(addSuppression, { kind: 'email', value: 'a@b.io', reason: 'asked' }, stranger()))
        .toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await db.select().from(schema.suppressions)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  /**
   * The MCP adapter hands the model a tool's `summary` alone — `data` never
   * reaches it. So every id and pause class a later call takes must be IN the
   * summary, and a chain of calls driven by nothing but summaries must work.
   */
  it('prints in the summary every id and pause class a later call needs — the model reads nothing else', async () => {
    const listed = summaryOf(await run(listContacts, { domain: 'rentman.io' }))
    expect(/Jo Bloggs \(CTO\) · id ([0-9a-f-]{36}) ·/.exec(listed)?.[1]).toBe(joId)

    const added = summaryOf(await run(addContact, { domain: 'rentman.io', firstName: 'Ana', email: 'ana@rentman.io' }))
    const anaId = /^Added Ana at rentman\.io — id ([0-9a-f-]{36});/.exec(added)?.[1]
    expect(anaId).toMatch(UUID)
    expect((await contactRow(anaId!)).email).toBe('ana@rentman.io')

    // Each id read off a summary is one the next call takes, and so is the class.
    const paused = summaryOf(await run(pauseContact, { contactId: anaId, reason: 'call in May' }))
    expect(paused).toContain(`id ${anaId} (pausedFor: manual)`)
    const relisted = summaryOf(await run(listContacts, { domain: 'rentman.io' }))
    const pausedFor = new RegExp(`id ${anaId} · .*\\(pausedFor: ([a-z_]+)\\)`).exec(relisted)?.[1]
    expect(pausedFor).toBe('manual')
    expect(summaryOf(await run(resumeContact, { contactId: anaId, pausedFor }))).toContain(`id ${anaId}`)
    expect((await contactRow(anaId!)).pausedAt).toBeNull()
    expect(summaryOf(await run(updateContact, { contactId: joId, title: 'CISO' }))).toContain(`id ${joId}`)
  })

  // -------------------------------------------------------------------------
  it('ends every write summary with "Nothing was sent.", for an owner and for a member alike', async () => {
    for (const who of [{}, member()]) {
      const suffix = Object.keys(who).length ? 'm' : 'o'
      const writes = [
        await run(addCompany, { domain: `new-${suffix}.io` }, who),
        await run(updateCompany, { domain: 'rentman.io', name: `Rentman ${suffix}` }, who),
        await run(importCompanies, { companies: [{ domain: `listed-${suffix}.io` }] }, who),
        await run(addContact, { domain: 'rentman.io', email: `new-${suffix}@rentman.io` }, who),
        await run(updateContact, { contactId: joId, title: `CTO ${suffix}` }, who),
        await run(pauseContact, { contactId: joId, reason: 'hold' }, who),
        await run(resumeContact, { contactId: joId, pausedFor: 'manual' }, who),
        await run(addSuppression, { kind: 'email', value: `gone-${suffix}@rentman.io`, reason: 'asked' }, who),
      ]
      for (const out of writes) expect(summaryOf(out).endsWith('Nothing was sent.')).toBe(true)
    }
  })

  it('names no channel and no org in any input, so the gate’s channel rule and org scoping hold', () => {
    for (const t of [listContacts, addCompany, updateCompany, importCompanies, addContact, updateContact, pauseContact, resumeContact, addSuppression]) {
      const keys = Object.keys(t.shape)
      expect(keys, t.name).not.toContain('channel')
      expect(keys, t.name).not.toContain('orgId')
      expect(keys, t.name).not.toContain('org_id')
      expect(t.description.length, t.name).toBeGreaterThan(80)
    }
    for (const t of [addCompany, updateCompany, importCompanies, addContact, updateContact, pauseContact, resumeContact, addSuppression]) {
      expect(t.description, t.name).toMatch(/nothing is sent/i)
    }
  })
})
