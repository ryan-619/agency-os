/**
 * The public booking page's write path (PROMPT.md §8.6, §2.1).
 *
 * The one place an outsider writes to the database without signing in, and
 * the one place an SMS or voice opt-in actually happens. So the tests are
 * about what it records — the consent rows, with the form's wording as
 * evidence — what it refuses to guess (a phone number with no country code,
 * a timezone it cannot read, a slug that is not live), and above all what it
 * refuses to TOUCH: nothing here authenticates anybody, so a booking may
 * create records and may never modify one it did not create.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  bookInbound, listContactsForCompany, openDealFor, orgByBookingSlug, schema,
  type AgencyDb, type BookingRequest,
} from '../src/index.js'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const SLOT = new Date('2026-09-18T14:00:00.000Z')
const WORDING = 'You may email me about this meeting. Tick below if we may also call or text you.'

describe('the booking page', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: 'Agency', bookingSlug: 'agency-intro' })
      .returning({ id: schema.orgs.id })
    orgId = org!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const request = (over: Partial<BookingRequest> = {}): BookingRequest => ({
    slug: 'agency-intro',
    name: 'Priya Sharma',
    email: 'Priya@Rentman.IO',
    company: 'Rentman',
    startsAt: SLOT,
    timeZone: 'Europe/Amsterdam',
    consent: { sms: false, voice: false, whatsapp: false },
    consentWording: WORDING,
    now: NOW,
    ...over,
  })

  it('finds an org by its slug and nothing else', async () => {
    expect(await orgByBookingSlug(db, 'agency-intro')).toEqual({ id: orgId, name: 'Agency' })
    expect(await orgByBookingSlug(db, 'nope')).toBeNull()
  })

  it('creates the company from the address, the contact, and a meeting at the deal stage', async () => {
    const r = await bookInbound(db, request())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.companyDomain).toBe('rentman.io')

    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.domain, 'rentman.io'))
    expect(company!.name).toBe('Rentman')
    expect(company!.timeZone).toBe('Europe/Amsterdam')

    const contacts = await listContactsForCompany(db, orgId, company!.id)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]!.email).toBe('priya@rentman.io')
    expect(contacts[0]!.firstName).toBe('Priya')
    expect(contacts[0]!.lastName).toBe('Sharma')
    expect(contacts[0]!.timeZone).toBe('Europe/Amsterdam')
    expect(contacts[0]!.source).toBe('inbound')

    const [meeting] = await db.select().from(schema.meetings)
    expect(meeting!.source).toBe('booking_page')
    expect(meeting!.startsAt.toISOString()).toBe(SLOT.toISOString())
    expect((await openDealFor(db, orgId, company!.id))!.stage).toBe('meeting')
  })

  /**
   * §2.1. The form is where an opt-in happens, and the row carries the form's
   * exact wording as evidence. A consent with no evidence of what was agreed
   * is a claim.
   */
  it('records email consent with the form’s wording, and nothing for the channels not ticked', async () => {
    await bookInbound(db, request())
    const consents = await db.select().from(schema.consents)
    expect(consents.map((c) => c.channel)).toEqual(['email'])
    expect(consents[0]!.granted).toBe(true)
    expect(consents[0]!.source).toMatch(/booking page, 2026-09-15/)
    expect(consents[0]!.evidence).toMatchObject({ form: 'booking_page', wording: WORDING })
  })

  it('records an SMS and voice opt-in only when ticked, with a number to go with it', async () => {
    await bookInbound(db, request({ phone: '+31 20 794 0000', consent: { sms: true, voice: true, whatsapp: false } }))
    const consents = await db.select().from(schema.consents)
    expect(consents.map((c) => c.channel).sort()).toEqual(['email', 'sms', 'voice'])
    const [contact] = await db.select().from(schema.contacts)
    expect(contact!.phone).toBe('+31207940000')
  })

  it('refuses an opt-in to be called with no number to call', async () => {
    const r = await bookInbound(db, request({ consent: { sms: false, voice: true, whatsapp: false } }))
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (r.ok) return
    expect(r.message).toMatch(/phone number/)
    expect(await db.select().from(schema.contacts)).toEqual([])
  })

  /**
   * An unmatchable number is one the suppression list can never protect. It
   * is not stored, and the visitor is told what to add.
   */
  it('refuses a phone number with no country code rather than storing it', async () => {
    const r = await bookInbound(db, request({ phone: '020 794 0000' }))
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (r.ok) return
    expect(r.message).toMatch(/country code/)
  })

  it.each([
    ['a slug that is not live', { slug: 'nope' }, 404, /not active/],
    ['an unreadable email', { email: 'not an email' }, 400, /email/],
    ['no name', { name: '  ' }, 400, /name/],
    ['a timezone it cannot read', { timeZone: 'Somewhere/Else' }, 400, /timezone/],
    ['a time in the past', { startsAt: new Date('2026-09-01T10:00:00.000Z') }, 400, /future/],
  ])('refuses %s', async (_label, over, status, matches) => {
    const r = await bookInbound(db, request(over as Partial<BookingRequest>))
    expect(r).toMatchObject({ ok: false, status })
    if (r.ok) return
    expect(r.message).toMatch(matches)
    expect(await db.select().from(schema.meetings)).toEqual([])
  })

  it('refuses a time further ahead than anyone books, and writes nothing on the way out', async () => {
    const r = await bookInbound(db, request({ startsAt: new Date(8.64e15) }))
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (r.ok) return
    expect(r.message).toMatch(/within the next/)
    // The unbounded version passed this straight to Postgres, which rejected
    // it — AFTER the company, the contact and their consent rows were in.
    expect(await db.select().from(schema.companies)).toEqual([])
    expect(await db.select().from(schema.contacts)).toEqual([])
    expect(await db.select().from(schema.consents)).toEqual([])
  })

  /**
   * THE rule (§2.1). Nothing here authenticates anybody: the form asks for an
   * address and believes it. So a booking may CREATE records and may never
   * MODIFY one it did not create — every test below is the same sentence
   * said about a different column.
   */
  describe('a booking may create records and may never modify one it did not create', () => {
    let companyId: string
    let contactId: string

    beforeEach(async () => {
      const [company] = await db
        .insert(schema.companies)
        .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/Amsterdam' })
        .returning({ id: schema.companies.id })
      companyId = company!.id
      const [contact] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId, email: 'priya@rentman.io', phone: '+31207940000', timeZone: 'Europe/Amsterdam' })
        .returning({ id: schema.contacts.id })
      contactId = contact!.id
    })

    /**
     * The one that is law. A recorded refusal is one of the three things
     * §2.1 says nobody can approve past, and `recordConsent` upserts — so
     * an anonymous form submission used to turn "never call me" into a
     * recorded opt-in, with the booking page's wording as the evidence.
     */
    it('never turns a recorded refusal into a grant', async () => {
      await db.insert(schema.consents).values([
        { orgId, contactId, channel: 'voice', granted: false, source: 'she said never call me' },
        { orgId, contactId, channel: 'email', granted: false, source: 'she asked us to stop' },
      ])

      const r = await bookInbound(db, request({ phone: '+1 415 555 0100', consent: { sms: true, voice: true, whatsapp: false } }))
      expect(r.ok).toBe(true)

      const consents = await db.select().from(schema.consents).where(eq(schema.consents.contactId, contactId))
      const byChannel = Object.fromEntries(consents.map((c) => [c.channel, c]))
      expect(byChannel['voice']).toMatchObject({ granted: false, source: 'she said never call me' })
      expect(byChannel['email']).toMatchObject({ granted: false, source: 'she asked us to stop' })
      // And no NEW grant is invented for a channel that had no row either:
      // the person who ticked the box is not certainly the person the row
      // is about.
      expect(byChannel['sms']).toBeUndefined()
    })

    it('never overwrites a known contact’s phone or timezone', async () => {
      await bookInbound(db, request({ phone: '+1 415 555 0100', timeZone: 'Pacific/Kiritimati' }))
      const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      // `time_zone` is the clock quiet hours are evaluated against (§2.1), and
      // `phone` is what an opt-in would point at.
      expect(contact).toMatchObject({ phone: '+31207940000', timeZone: 'Europe/Amsterdam' })
    })

    it('never walks a known company’s deal forward', async () => {
      const before = await openDealFor(db, orgId, companyId)
      expect(before).toBeNull()
      await bookInbound(db, request())
      expect(await openDealFor(db, orgId, companyId)).toBeNull()
    })

    /**
     * Recorded anyway. Refusing a real prospect because the team already has
     * them on file would be the worse failure — so the request lands, marked
     * for a person, with what they typed kept where that person can read it.
     */
    it('records the meeting, flags it for review, and keeps what they claimed', async () => {
      const r = await bookInbound(db, request({ phone: '+1 415 555 0100', consent: { sms: true, voice: false, whatsapp: false } }))
      expect(r).toMatchObject({ ok: true, needsReview: true })
      const [meeting] = await db.select().from(schema.meetings)
      expect(meeting).toMatchObject({ needsReview: true, source: 'booking_page', dealId: null })
      expect(meeting!.notes).toMatch(/unverified booking/)
      expect(meeting!.notes).toMatch(/\+14155550100/)
      expect(meeting!.notes).toMatch(/NOT recorded/)
    })

    it('says in the audit row that it recognised them and changed nothing', async () => {
      await bookInbound(db, request())
      const audit = await db.select().from(schema.auditLog)
      const lead = audit.find((a) => a.action === 'lead.inbound')!
      expect(lead.detail).toMatchObject({ recognised: true, createdContact: false, createdCompany: false, consented: [] })
    })

    /** A different person at a company already on file is still a new lead. */
    it('creates a new person at a known company without touching the company’s deal', async () => {
      const r = await bookInbound(db, request({ name: 'Tom de Vries', email: 'tom@rentman.io' }))
      expect(r).toMatchObject({ ok: true, needsReview: true })
      expect(await db.select().from(schema.contacts)).toHaveLength(2)
      expect(await openDealFor(db, orgId, companyId)).toBeNull()
      // The new person's own consent IS recorded — they typed their own
      // details and there was no row of the team's to overwrite.
      const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'tom@rentman.io'))
      const consents = await db.select().from(schema.consents).where(eq(schema.consents.contactId, contact!.id))
      expect(consents.map((c) => c.channel)).toEqual(['email'])
    })
  })

  /** Nothing pre-existing to corrupt: the full §8.6 flow still runs. */
  it('lands a brand new lead on the board, with consent recorded', async () => {
    const r = await bookInbound(db, request({ consent: { sms: true, voice: false, whatsapp: false }, phone: '+31 20 794 0000' }))
    expect(r).toMatchObject({ ok: true, needsReview: false })
    const [company] = await db.select().from(schema.companies)
    expect(company).toMatchObject({ domain: 'rentman.io', source: 'inbound' })
    const deal = await openDealFor(db, orgId, company!.id)
    expect(deal!.stage).toBe('meeting')
    const [meeting] = await db.select().from(schema.meetings)
    expect(meeting).toMatchObject({ needsReview: false })
    const consents = await db.select().from(schema.consents)
    expect(consents.map((c) => c.channel).sort()).toEqual(['email', 'sms'])
  })

  /**
   * A free-mail address names a person, not a company. The row is named
   * after the person under a synthetic domain, so it neither collides with
   * every other gmail lead nor pretends to be gmail.com.
   */
  it('does not file a gmail lead under gmail.com', async () => {
    const r = await bookInbound(db, request({ email: 'priya.s@gmail.com', company: null }))
    if (!r.ok) throw new Error(r.message)
    expect(r.companyDomain).not.toBe('gmail.com')
    expect(r.companyDomain).toMatch(/\.inbound$/)
    const [company] = await db.select().from(schema.companies)
    expect(company!.name).toBe('Priya Sharma')
  })

  it('audits the lead without recording the address', async () => {
    await bookInbound(db, request())
    const audit = await db.select().from(schema.auditLog)
    const lead = audit.find((a) => a.action === 'lead.inbound')!
    expect(lead).toBeDefined()
    expect(JSON.stringify(lead.detail)).not.toContain('priya@rentman.io')
    expect(lead.detail).toMatchObject({ consented: ['email'] })
  })
})
