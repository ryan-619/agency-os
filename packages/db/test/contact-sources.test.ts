/**
 * Where an address came from (0029), against a real engine.
 *
 * The assistant stored addresses nobody had shown it, and an opener went to
 * one. So every email and phone a writer stores carries its source, and the
 * rules here are the writers': each stamps its own (`person`, `import`,
 * `inbound`, `chat`, `connector:<name>`, or the page it was seen on); a source
 * moves with its address, in the same UPDATE, and goes when the address goes;
 * a source for an address that is not there, or in no shape the CHECK knows,
 * is a sentence — never a 500.
 *
 * And the one rule held between two files: the CHECK's pattern is core's
 * ADDRESS_SOURCE_PATTERN, character for character, and the database and the
 * JavaScript regex agree on every value asked of them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { ADDRESS_SOURCE_MAX, ADDRESS_SOURCE_PATTERN, isAddressSource } from '@agency/core'
import {
  addressSourceProblem, bookInbound, contactInput, contactsUpdate, createContact, importContacts, parseContactSeeds,
  schema, websiteCheckRequest, CONTACT_IMPORT_COLUMNS, type AgencyDb, type ContactInput,
} from '../src/index.js'
import { MIGRATIONS_DIR } from '../src/paths.js'
import { migratedDb, type TestDb } from './helpers.js'

const PAGE = 'https://www.127atelier.in/pages/contact'

describe('the CHECK and core hold the same pattern', () => {
  const up = readFileSync(join(MIGRATIONS_DIR, '0029_true_data.up.sql'), 'utf8')

  it('spells core’s ADDRESS_SOURCE_PATTERN exactly, in both CHECKs', () => {
    const patterns = [...up.matchAll(/_source ~ '([^']*)'/g)].map((m) => m[1])
    expect(patterns).toEqual([ADDRESS_SOURCE_PATTERN, ADDRESS_SOURCE_PATTERN])
  })

  it('bounds a source at core’s ADDRESS_SOURCE_MAX, in both CHECKs', () => {
    expect([...up.matchAll(/length\((email|phone)_source\) <= (\d+)/g)].map((m) => [m[1], Number(m[2])])).toEqual([
      ['email', ADDRESS_SOURCE_MAX],
      ['phone', ADDRESS_SOURCE_MAX],
    ])
  })
})

describe('the database and isAddressSource agree on every value', () => {
  let test: TestDb
  beforeEach(async () => { test = await migratedDb() }, 30_000)
  afterEach(async () => { await test?.close() })

  const dbAccepts = async (value: string): Promise<boolean> => {
    const [row] = await test.driver.select<{ ok: boolean }>(
      `SELECT ($1::text ~ '${ADDRESS_SOURCE_PATTERN}' AND length($1::text) <= ${ADDRESS_SOURCE_MAX}) AS ok`, [value],
    )
    return row?.ok === true
  }

  /**
   * Postgres's regex engine is not JavaScript's. A value JavaScript accepted
   * and the CHECK refused would be a 500 at the INSERT; one the CHECK accepted
   * and JavaScript refused would be a row the writers could never produce.
   * So the same values go through both, and the answers must match.
   */
  it('answers the same for shapes, edges and near misses', async () => {
    const values = [
      'person', 'import', 'inbound', 'chat', 'connector:exa', 'connector:a', 'connector:a-', 'connector:0x-1',
      'https://x', 'http://x', PAGE, 'https://例え.jp/連絡', `https://a.in/${'a'.repeat(2030)}`,
      `https://a.in/${'a'.repeat(2048)}`,
      '', 'Person', 'PERSON', 'chat ', ' chat', 'chat\n', 'person\nimport', 'connector:', 'connector:-a', 'connector:A',
      'connector:a_b', 'connector:a.b', 'https://', 'http:/x', 'https://a b', 'https://a\tb', 'https://a\nb',
      'https://a\u000bb', 'https://a\rb', 'https://a\fb',
      'ftp://a.in', 'HTTPS://a.in', 'mailto:p@a.in', 'connector:exa\n', 'typed', 'agent', 'manual',
    ]
    for (const value of values) {
      expect(await dbAccepts(value), JSON.stringify(value.slice(0, 40))).toBe(isAddressSource(value))
    }
  })

  /**
   * What the writers let through, the CHECK must take: a value the writer
   * passed and the CHECK refused is a 23514 at the INSERT, and U+0000, which
   * Postgres refuses in any text, was a 500. So every code point of the Basic
   * Multilingual Plane, and three beyond it, goes inside a page's address
   * through `addressSourceProblem` and through the CHECK, in one statement.
   *
   * Measured: the engines disagree on whitespace. U+0085 is a space to
   * Postgres and not to JavaScript's `\S` — the one case where the CHECK was
   * stricter than `isAddressSource` — so the writer refuses every control
   * character itself. U+00A0, U+1680, U+2007, U+202F and U+FEFF go the other
   * way (a space to JavaScript, not to Postgres): the CHECK is looser there,
   * and no writer stores one.
   */
  it('takes every value the writers pass — never stricter than they are', async () => {
    const values: string[] = []
    for (let cp = 1; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      values.push(`https://a${String.fromCodePoint(cp)}b`)
    }
    for (const cp of [0x1f600, 0xe0001, 0x10ffff]) values.push(`https://a${String.fromCodePoint(cp)}b`)
    const { rows } = await test.pg.query<{ ok: boolean }>(
      `SELECT v ~ '${ADDRESS_SOURCE_PATTERN}' AND length(v) <= ${ADDRESS_SOURCE_MAX} AS ok
         FROM unnest($1::text[]) WITH ORDINALITY AS u(v, i) ORDER BY i`,
      [values],
    )
    expect(rows).toHaveLength(values.length)
    const writerTakes = (v: string) => addressSourceProblem('email', v, 'akash@127atelier.in') === null
    const refusedByTheCheckOnly = values
      .filter((v, i) => writerTakes(v) && rows[i]?.ok !== true)
      .map((v) => `U+${v.codePointAt(9)!.toString(16).toUpperCase().padStart(4, '0')}`)
    expect(refusedByTheCheckOnly).toEqual([])
    // Not vacuous: the writer passes nearly the whole plane, and the one
    // space the two engines read differently in the dangerous direction is
    // refused by the writer, which the CHECK would have refused too.
    expect(values.filter(writerTakes).length).toBeGreaterThan(60_000)
    expect(isAddressSource('https://a\u0085b')).toBe(true)
    expect(await dbAccepts('https://a\u0085b')).toBe(false)
    expect(writerTakes('https://a\u0085b')).toBe(false)
  })
})

describe('the writers stamp where an address came from', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy', bookingSlug: 'accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [co] = await db
      .insert(schema.companies)
      .values({ orgId, domain: '127atelier.in', name: '127 Atelier', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    companyId = co!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const input = (over: Record<string, unknown> = {}): ContactInput =>
    contactInput.parse({ companyId, firstName: 'Akash', email: 'akash@127atelier.in', ...over })
  const contactRows = () => db.select().from(schema.contacts).where(eq(schema.contacts.orgId, orgId))
  const readBack = async (id: string) => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!

  describe('createContact', () => {
    it('stores each address’s source as given', async () => {
      const r = await createContact(db, orgId, input({ phone: '+91 98765 43210', emailSource: PAGE, phoneSource: 'connector:exa' }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.contact).toMatchObject({ email: 'akash@127atelier.in', phone: '+919876543210', emailSource: PAGE, phoneSource: 'connector:exa' })
    })

    it('stores NULL — "not recorded" — when no source is given, never a guess at one', async () => {
      const r = await createContact(db, orgId, input({ phone: '+919876543210' }))
      expect(r.ok && r.contact).toMatchObject({ emailSource: null, phoneSource: null })
    })

    it('refuses a source in no shape the CHECK knows, with a sentence and nothing written', async () => {
      for (const emailSource of ['guessed', 'Person', 'connector:', 'https://a b', 'mailto:akash@127atelier.in']) {
        const r = await createContact(db, orgId, input({ emailSource }))
        expect(r, emailSource).toEqual({ ok: false, message: expect.stringMatching(/^That is not a source the email can be recorded with/) })
      }
      const p = await createContact(db, orgId, input({ phone: '+919876543210', phoneSource: 'from a guess' }))
      expect(p).toEqual({ ok: false, message: expect.stringMatching(/^That is not a source the phone number/) })
      expect(await contactRows()).toEqual([])
    })

    /**
     * A control character in a page's address: U+0000, which Postgres
     * refuses in any text, reached the INSERT and answered 500; U+0085 passed
     * `isAddressSource` and met the CHECK. Both are the writer's sentence now.
     */
    it('refuses a control character in a source with a sentence — U+0000 was a 500', async () => {
      for (const emailSource of [`${PAGE}\u0000`, `${PAGE}\u0085x`, `${PAGE}\u001b[0m`]) {
        const r = await createContact(db, orgId, input({ emailSource }))
        expect(r, JSON.stringify(emailSource)).toEqual({ ok: false, message: expect.stringMatching(/^That is not a source the email/) })
      }
      expect(await contactRows()).toEqual([])
    })

    it('refuses a source for an address the contact does not have', async () => {
      const a = await createContact(db, orgId, input({ email: null, phone: '+919876543210', emailSource: 'chat' }))
      expect(a).toEqual({ ok: false, message: expect.stringMatching(/source was given for an email address, but the contact has none/) })
      const b = await createContact(db, orgId, input({ phoneSource: 'chat' }))
      expect(b).toEqual({ ok: false, message: expect.stringMatching(/source was given for a phone number, but the contact has none/) })
      expect(await contactRows()).toEqual([])
    })

    it('answers a row source the CHECK would refuse with a sentence, where it used to be a 500', async () => {
      const r = await createContact(db, orgId, input({ source: 'linkedin-scrape' }))
      expect(r).toEqual({ ok: false, message: expect.stringMatching(/^"linkedin-scrape" is not a source a contact can have/) })
      expect(await contactRows()).toEqual([])
    })
  })

  describe('contactsUpdate', () => {
    const seed = async (over: Record<string, unknown> = {}) => {
      const r = await createContact(db, orgId, input({ phone: '+919876543210', emailSource: 'import', phoneSource: 'import', ...over }))
      if (!r.ok) throw new Error(r.message)
      return r.contact.id
    }

    it('gives a changed email the source it arrived with, in the same UPDATE', async () => {
      const id = await seed()
      const r = await contactsUpdate(db, orgId, id, { email: 'akash.k@127atelier.in', emailSource: PAGE })
      expect(r).toMatchObject({ ok: true, changed: ['email'] })
      // The source is not a field of its own: the audit row names `email` only.
      expect(await readBack(id)).toMatchObject({ email: 'akash.k@127atelier.in', emailSource: PAGE, phoneSource: 'import' })
    })

    it('records NULL for a changed email whose source was not given — the old one was about the old address', async () => {
      const id = await seed()
      expect(await contactsUpdate(db, orgId, id, { email: 'akash.k@127atelier.in' })).toMatchObject({ ok: true })
      expect(await readBack(id)).toMatchObject({ email: 'akash.k@127atelier.in', emailSource: null, phoneSource: 'import' })
    })

    it('clears the source with the address — a source given beside the clear included', async () => {
      const id = await seed()
      expect(await contactsUpdate(db, orgId, id, { email: null, emailSource: 'person' })).toMatchObject({ ok: true, changed: ['email'] })
      expect(await readBack(id)).toMatchObject({ email: null, emailSource: null, phone: '+919876543210', phoneSource: 'import' })
      expect(await contactsUpdate(db, orgId, id, { phone: '', email: 'a@127atelier.in', emailSource: 'chat' })).toMatchObject({ ok: true })
      expect(await readBack(id)).toMatchObject({ phone: null, phoneSource: null, email: 'a@127atelier.in', emailSource: 'chat' })
    })

    it('leaves the source alone when the address is not changing — a source given beside it updates nothing and is no error', async () => {
      const id = await seed()
      // The same address in another case is the same address.
      expect(await contactsUpdate(db, orgId, id, { email: 'AKASH@127atelier.in', emailSource: 'chat' }))
        .toMatchObject({ ok: true, changed: [] })
      // And an edit of the title from a form that always sends `person`.
      expect(await contactsUpdate(db, orgId, id, { title: 'Founder', email: 'akash@127atelier.in', emailSource: 'person', phoneSource: 'person' }))
        .toMatchObject({ ok: true, changed: ['title'] })
      expect(await readBack(id)).toMatchObject({ title: 'Founder', emailSource: 'import', phoneSource: 'import' })
    })

    it('gives a changed phone its source too', async () => {
      const id = await seed()
      expect(await contactsUpdate(db, orgId, id, { phone: '+91 98111 22233', phoneSource: 'connector:apollo' })).toMatchObject({ ok: true, changed: ['phone'] })
      expect(await readBack(id)).toMatchObject({ phone: '+919811122233', phoneSource: 'connector:apollo', emailSource: 'import' })
    })

    it('refuses a source in no known shape for an address that IS changing, and changes nothing', async () => {
      const id = await seed()
      const r = await contactsUpdate(db, orgId, id, { email: 'guess@127atelier.in', emailSource: 'first@domain pattern' })
      expect(r).toEqual({
        ok: false, reason: 'unreadable',
        message: expect.stringMatching(/^That is not a source the email can be recorded with.*Nothing was changed\.$/),
      })
      expect(await readBack(id)).toMatchObject({ email: 'akash@127atelier.in', emailSource: 'import' })
    })

    it('refuses a control character in the source of an address that IS changing, and changes nothing', async () => {
      const id = await seed()
      const r = await contactsUpdate(db, orgId, id, { email: 'akash.k@127atelier.in', emailSource: `${PAGE}\u0000` })
      expect(r).toMatchObject({ ok: false, reason: 'unreadable', message: expect.stringMatching(/Nothing was changed\.$/) })
      expect(await readBack(id)).toMatchObject({ email: 'akash@127atelier.in', emailSource: 'import' })
    })

    it('edits a contact written before 0029 — an address and no source — as it always did', async () => {
      const [old] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId, email: 'old@127atelier.in', phone: '+919800000000' })
        .returning({ id: schema.contacts.id })
      expect(await contactsUpdate(db, orgId, old!.id, { title: 'Owner' })).toMatchObject({ ok: true, changed: ['title'] })
      expect(await readBack(old!.id)).toMatchObject({ emailSource: null, phoneSource: null })
    })
  })

  it('the contacts import stamps `import` beside every address it stores, and none beside a phone it dropped', async () => {
    const csv =
      `${CONTACT_IMPORT_COLUMNS.join(',')}\n` +
      '127atelier.in,akash@127atelier.in,Akash,,,+91 98765 43210,,Asia/Kolkata\n' +
      '127atelier.in,bala@127atelier.in,Bala,,,98765 43211,,Asia/Kolkata\n'
    const r = await importContacts(db, orgId, parseContactSeeds(csv))
    expect(r).toMatchObject({ inserted: 2, phoneDropped: [{ line: 3 }] })
    const rows = await contactRows()
    const akash = rows.find((c) => c.email === 'akash@127atelier.in')!
    const bala = rows.find((c) => c.email === 'bala@127atelier.in')!
    expect(akash).toMatchObject({ emailSource: 'import', phone: '+919876543210', phoneSource: 'import' })
    expect(bala).toMatchObject({ emailSource: 'import', phone: null, phoneSource: null })
  })

  it('the booking page stamps `inbound` beside the address and the number the person typed', async () => {
    const r = await bookInbound(db, {
      slug: 'accemy', name: 'Priya Sharma', email: 'Priya@Rentman.IO', company: 'Rentman',
      startsAt: new Date('2026-10-20T09:00:00.000Z'), timeZone: 'Asia/Kolkata', phone: '+91 98765 00001',
      consent: { sms: true, voice: false, whatsapp: false }, consentWording: 'You may email me.',
      now: new Date('2026-10-13T09:00:00.000Z'),
    })
    expect(r.ok).toBe(true)
    const [priya] = (await contactRows()).filter((c) => c.email === 'priya@rentman.io')
    expect(priya).toMatchObject({ source: 'inbound', emailSource: 'inbound', phone: '+919876500001', phoneSource: 'inbound' })
  })

  it('the booking page records no phone source when no number was given', async () => {
    await bookInbound(db, {
      slug: 'accemy', name: 'Priya Sharma', email: 'priya@rentman.io', company: 'Rentman',
      startsAt: new Date('2026-10-20T09:00:00.000Z'), timeZone: 'Asia/Kolkata',
      consent: { sms: false, voice: false, whatsapp: false }, consentWording: 'You may email me.',
      now: new Date('2026-10-13T09:00:00.000Z'),
    })
    const [priya] = (await contactRows()).filter((c) => c.email === 'priya@rentman.io')
    expect(priya).toMatchObject({ emailSource: 'inbound', phone: null, phoneSource: null })
  })

  it('the free website check files its person as `inbound`, with an `inbound` address — not the column’s default `manual`', async () => {
    const r = await websiteCheckRequest(db, {
      slug: 'accemy', domain: 'kumardental.in', businessName: 'Kumar Dental', name: 'Ravi Kumar', email: 'Ravi@KumarDental.in',
      timeZone: 'Asia/Kolkata', consentWording: 'Email me about the result.', now: new Date('2026-10-13T09:00:00.000Z'),
    })
    expect(r).toMatchObject({ ok: true, recognised: false })
    const [ravi] = (await contactRows()).filter((c) => c.email === 'ravi@kumardental.in')
    expect(ravi).toMatchObject({ source: 'inbound', emailSource: 'inbound', phoneSource: null })
  })
})
