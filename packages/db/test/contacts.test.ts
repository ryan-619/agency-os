/**
 * Contacts (PROMPT.md §2.1, §8.4), against a real engine.
 *
 * The two facts the send path demands — a timezone and per-channel consent —
 * are what this module records, and the tests are about what it refuses:
 * an address that cannot be normalised, a zone the runtime does not know, a
 * consent with no source, and a duplicate address, which review found was a
 * 500 rather than a sentence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  createContact, isKnownTimeZone, linkedinIsReadable, linkedinUnreadable, listContactsForCompany, phoneNotInternational,
  recordConsent, schema, updateContactTimeZone, type AgencyDb,
} from '../src/index.js'
import { migratedDb,type TestDb } from './helpers.js'

describe('isKnownTimeZone', () => {
  it.each(['Europe/London', 'America/New_York', 'Asia/Kolkata', 'UTC', 'Japan', 'GMT', 'EST5EDT'])(
    'knows %s',
    (zone) => {
      expect(isKnownTimeZone(zone)).toBe(true)
    },
  )
  it.each(['United States', 'Pacific Time', 'Mars/Olympus', '', 'GMT+5'])('does not know %j', (zone) => {
    expect(isKnownTimeZone(zone)).toBe(false)
  })
})

describe('contacts', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [company] = await db.insert(schema.companies).values({ orgId, domain: 'rentman.io' }).returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const create = (over: Record<string, unknown> = {}) =>
    createContact(db, orgId, {
      companyId, firstName: 'Priya', lastName: 'Sharma', email: 'Priya@Rentman.IO', timeZone: 'Europe/London',
      source: 'manual', ...over,
    } as never)

  it('normalises the address on the way in, the way the suppression list does', async () => {
    const r = await create()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.contact.email).toBe('priya@rentman.io')
  })

  /**
   * `contacts_org_email_key` is on (org_id, lower(email)). A second Priya
   * used to be a constraint violation surfacing as a 500 from the route;
   * it is a sentence now, and the same sentence when two arrive at once.
   */
  it('refuses a duplicate address with a sentence, not a 500', async () => {
    await create()
    const again = await create({ email: 'PRIYA@rentman.io' })
    expect(again).toEqual({ ok: false, message: 'priya@rentman.io is already a contact in this CRM.' })
    expect(await listContactsForCompany(db, orgId, companyId)).toHaveLength(1)
  })

  it('refuses a duplicate that races in, with the same sentence', async () => {
    const [a, b] = await Promise.all([create(), create()])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = [a, b].find((r) => !r.ok)!
    if (loser.ok) return
    expect(loser.message).toMatch(/already a contact/)
  })

  /**
   * An edit stores a phone as E.164, and so does the import; the form's
   * route stored it as typed, so a contact added there carried a number no
   * suppression key and no text sent back could ever match — a STOP from it
   * found nobody. It is normalised here now, or refused in the edit's words.
   */
  it('stores a phone as E.164, as an edit does', async () => {
    const r = await create({ phone: '+1 (415) 555-0100' })
    if (!r.ok) throw new Error(r.message)
    expect(r.contact.phone).toBe('+14155550100')
  })

  it('refuses a phone with no country code, in the words an edit uses', async () => {
    const r = await create({ phone: '(415) 555-0100' })
    expect(r).toEqual({ ok: false, message: phoneNotInternational('(415) 555-0100') })
    expect(await listContactsForCompany(db, orgId, companyId)).toEqual([])
  })

  it('reads a LinkedIn URL the way an edit does, for the route to ask first', () => {
    expect(linkedinIsReadable('https://www.linkedin.com/in/jane-doe')).toBe(true)
    expect(linkedinIsReadable('jane-doe')).toBe(false)
    expect(linkedinUnreadable('jane-doe')).toMatch(/could not be read as a LinkedIn profile/)
  })

  it('accepts a slash-less zone the runtime knows, which 0010 refused', async () => {
    const r = await create({ timeZone: 'Japan' })
    expect(r.ok).toBe(true)
  })

  it.each([
    ['an address it cannot read', { email: 'not an email' }, /email address/],
    ['a zone it does not know', { timeZone: 'Pacific Time' }, /timezone/],
    ['no way to reach them', { email: null, phone: null, linkedinUrl: null }, /at least one way/],
    ['a company that is not there', { companyId: '00000000-0000-4000-8000-00000000dead' }, /not in the CRM/],
  ])('refuses %s', async (_label, over, matches) => {
    const r = await create(over)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(matches)
  })

  it('updates a timezone, and refuses one it does not know', async () => {
    const r = await create()
    if (!r.ok) throw new Error(r.message)
    expect(await updateContactTimeZone(db, orgId, r.contact.id, 'America/New_York')).toEqual({ ok: true })
    expect((await updateContactTimeZone(db, orgId, r.contact.id, 'Nowhere/Here')).ok).toBe(false)
  })

  describe('consent (§2.1)', () => {
    it('records one row per channel, replaced rather than appended', async () => {
      const r = await create()
      if (!r.ok) throw new Error(r.message)
      await recordConsent(db, { orgId, contactId: r.contact.id, channel: 'sms', granted: true, source: 'signup form' })
      await recordConsent(db, { orgId, contactId: r.contact.id, channel: 'sms', granted: false, source: 'replied stop' })
      const [c] = await listContactsForCompany(db, orgId, companyId)
      expect(c!.consents).toHaveLength(1)
      expect(c!.consents[0]).toMatchObject({ channel: 'sms', granted: false, source: 'replied stop' })
    })

    it('refuses a consent with no source', async () => {
      const r = await create()
      if (!r.ok) throw new Error(r.message)
      const out = await recordConsent(db, { orgId, contactId: r.contact.id, channel: 'sms', granted: true, source: '   ' })
      expect(out.ok).toBe(false)
    })

    it('says nothing about SMS when only email was granted', async () => {
      const r = await create()
      if (!r.ok) throw new Error(r.message)
      await recordConsent(db, { orgId, contactId: r.contact.id, channel: 'email', granted: true, source: 'form' })
      const [c] = await listContactsForCompany(db, orgId, companyId)
      expect(c!.consents.map((k) => k.channel)).toEqual(['email'])
    })
  })
})
