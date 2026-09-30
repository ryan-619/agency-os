/**
 * Contacts from a CSV (PROMPT.md §2.1), against a real engine.
 *
 * The rule under test above all others: an import writes NO consent row. A
 * list somebody exported is not a record of anybody agreeing to anything, so
 * every person it creates starts from NO on every channel — asserted by
 * counting the `consents` table, not by reading the code.
 *
 * The second: a phone number that cannot be normalised is never stored. A
 * suppression row is E.164 by CHECK, so a stored `07700 900123` is a number
 * whose opt-out could never be matched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  CONTACT_IMPORT_COLUMNS, importContacts, parseContactSeeds, schema, type AgencyDb, type ContactSeedRow,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const HEADER = CONTACT_IMPORT_COLUMNS.join(',')

describe('parseContactSeeds', () => {
  it('reads the header by name, in any order', () => {
    const rows = parseContactSeeds(
      'time_zone,email,domain,first_name,last_name,title,phone,linkedin_url\n' +
        'Europe/London,Priya@Rentman.io,rentman.io,Priya,Sharma,CTO,+44 20 7946 0000,\n',
    )
    expect(rows).toEqual([
      {
        line: 2, domain: 'rentman.io', email: 'Priya@Rentman.io', firstName: 'Priya', lastName: 'Sharma',
        title: 'CTO', phone: '+44 20 7946 0000', linkedinUrl: null, timeZone: 'Europe/London',
      },
    ])
  })

  it('strips a BOM, reads CRLF, and skips blank lines and # comments', () => {
    const csv = `﻿# exported from the old CRM\r\n${HEADER}\r\n\r\n# a comment between rows\r\nrentman.io,a@rentman.io,,,,,,\r\n`
    const rows = parseContactSeeds(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ line: 5, domain: 'rentman.io', email: 'a@rentman.io', timeZone: null })
  })

  it('keeps a comma, a doubled quote and a newline inside a quoted value', () => {
    const csv = `${HEADER}\nrentman.io,a@rentman.io,Priya,Sharma,"VP, ""Security""\nand Risk",,,\nrentman.io,b@rentman.io,,,,,,\n`
    const rows = parseContactSeeds(csv)
    expect(rows.map((r) => r.title)).toEqual(['VP, "Security"\nand Risk', null])
    // The second record starts on line 4: the quoted newline is a line of the file.
    expect(rows.map((r) => r.line)).toEqual([2, 4])
  })

  it('reduces a pasted URL to its domain', () => {
    const [row] = parseContactSeeds(`${HEADER}\nhttps://WWW.Rentman.io/about?x=1,a@rentman.io,,,,,,\n`)
    expect(row?.domain).toBe('www.rentman.io')
  })

  it('accepts a spreadsheet-style header and ignores columns it does not use', () => {
    const rows = parseContactSeeds(
      'Domain,Email,First Name,Last Name,Title,Phone,LinkedIn URL,Time Zone,Apollo Score\n' +
        'rentman.io,a@rentman.io,A,B,,,,,97\n',
    )
    expect(rows[0]).toMatchObject({ firstName: 'A', lastName: 'B' })
    expect(rows[0]?.problem).toBeUndefined()
  })

  it('throws, naming the missing column, when the header lacks one', () => {
    expect(() =>
      parseContactSeeds('domain,email,first_name,last_name,title,phone,linkedin_url,timezone\nrentman.io,a@b.co,,,,,,\n'),
    ).toThrow(/no time_zone column/)
    expect(() => parseContactSeeds('rentman.io,a@rentman.io\n')).toThrow(/domain, email, first_name/)
    expect(() => parseContactSeeds('')).toThrow(/no header line/)
  })

  it('refuses a header that names a column twice', () => {
    expect(() => parseContactSeeds(`${HEADER},email\n`)).toThrow(/names email twice/)
  })

  it('throws when a quoted value is never closed, naming the line it opened on', () => {
    expect(() => parseContactSeeds(`${HEADER}\nrentman.io,a@rentman.io,"Priya,,,,,,\n`)).toThrow(/starts on line 2/)
  })

  /**
   * An unquoted comma shifts every value after it one column right: the
   * phone becomes the LinkedIn URL and the zone falls off the end. The row
   * is marked rather than read, so the import refuses it by line.
   */
  it('marks a row whose value count does not match the header', () => {
    const rows = parseContactSeeds(
      `${HEADER}\nrentman.io,a@rentman.io,Priya,Sharma,VP, Security,,,\nrentman.io,b@rentman.io\nrentman.io,c@rentman.io,,,,,,\n`,
    )
    // The shifted row has an EMPTY last cell; dropping it as a stray comma
    // would read "Security" as the phone number.
    expect(rows[0]?.problem).toMatch(/9 values where the header names 8/)
    expect(rows[1]?.problem).toMatch(/2 values where the header names 8/)
    expect(rows[2]?.problem).toBeUndefined()
  })

  it('reads a file whose every line, header included, ends in a comma', () => {
    const rows = parseContactSeeds(`${HEADER},\nrentman.io,a@rentman.io,,,,,,,\n`)
    expect(rows[0]).toMatchObject({ email: 'a@rentman.io' })
    expect(rows[0]?.problem).toBeUndefined()
  })
})

describe('importContacts', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Other agency' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'eagronom.com' })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const csv = (...lines: string[]) => parseContactSeeds([HEADER, ...lines].join('\n'))
  const contacts = () => db.select().from(schema.contacts).where(eq(schema.contacts.orgId, orgId))

  it('creates the people and records NO consent for any of them, on any channel', async () => {
    const result = await importContacts(
      db, orgId,
      csv(
        'rentman.io,Priya@Rentman.IO,Priya,Sharma,CTO,+44 20 7946 0000,https://www.linkedin.com/in/priya-sharma,Europe/London',
        'rentman.io,sam@rentman.io,Sam,Lee,,,,',
      ),
    )
    expect(result).toEqual({ inserted: 2, alreadyPresent: 0, unknownCompany: [], refused: [], phoneDropped: [] })

    const consents = await db.select().from(schema.consents)
    expect(consents).toHaveLength(0)

    const rows = await contacts()
    const priya = rows.find((r) => r.firstName === 'Priya')!
    // Through createContact: the address folded the suppression list's way,
    // the phone stored in E.164 — the only form a suppression row can match.
    expect(priya.email).toBe('priya@rentman.io')
    expect(priya.phone).toBe('+442079460000')
    expect(priya.timeZone).toBe('Europe/London')
    expect(priya.source).toBe('import')
    expect(priya.companyId).toBe(companyId)
  })

  it('lists a domain that matches no company, once, and creates nobody for it', async () => {
    const result = await importContacts(
      db, orgId,
      csv('nowhere.example,a@nowhere.example,,,,,,', 'nowhere.example,b@nowhere.example,,,,,,', 'rentman.io,c@rentman.io,,,,,,'),
    )
    expect(result.unknownCompany).toEqual(['nowhere.example'])
    expect(result.inserted).toBe(1)
    expect(await contacts()).toHaveLength(1)
  })

  it("treats another org's company as unknown", async () => {
    const result = await importContacts(db, orgId, csv('eagronom.com,a@eagronom.com,,,,,,'))
    expect(result.unknownCompany).toEqual(['eagronom.com'])
    expect(result.inserted).toBe(0)
    const everywhere = await db.select().from(schema.contacts)
    expect(everywhere).toHaveLength(0)
  })

  it('matches a company written with or without www', async () => {
    const result = await importContacts(db, orgId, csv('www.rentman.io,a@rentman.io,,,,,,'))
    expect(result.inserted).toBe(1)
    expect(result.unknownCompany).toEqual([])
  })

  it('reports a person already on file as present, and a re-run creates nothing twice', async () => {
    const file = csv(
      'rentman.io,priya@rentman.io,Priya,,,,,',
      'rentman.io,,Sam,Lee,,+44 20 7946 0001,,',
      'rentman.io,,,,,,linkedin.com/in/jo-bloggs,',
      'rentman.io,PRIYA@rentman.io,Priya,,,,,',
    )
    const first = await importContacts(db, orgId, file)
    expect(first).toMatchObject({ inserted: 3, alreadyPresent: 1 })

    const again = await importContacts(db, orgId, file)
    expect(again).toMatchObject({ inserted: 0, alreadyPresent: 4, refused: [] })
    expect(await contacts()).toHaveLength(3)
  })

  /**
   * A switchboard number is shared by everybody at a company, so a phone
   * alone does not say two rows are one person — the name has to agree too.
   */
  it('does not merge two different people who share a phone number', async () => {
    const result = await importContacts(
      db, orgId,
      csv('rentman.io,,Sam,Lee,,+44 20 7946 0000,,', 'rentman.io,,Ana,Diaz,,+44 20 7946 0000,,'),
    )
    expect(result).toMatchObject({ inserted: 2, alreadyPresent: 0 })
  })

  it('drops a phone it cannot normalise, reports the line, and still creates the contact by email', async () => {
    const result = await importContacts(
      db, orgId,
      csv('rentman.io,priya@rentman.io,Priya,,,07700 900123,,Europe/London'),
    )
    expect(result.phoneDropped).toEqual([{ line: 2 }])
    expect(result.inserted).toBe(1)
    const [priya] = await contacts()
    expect(priya?.email).toBe('priya@rentman.io')
    expect(priya?.phone).toBeNull()
  })

  it('refuses a row whose only address was a phone it had to drop', async () => {
    const result = await importContacts(db, orgId, csv('rentman.io,,Sam,,,07700 900123,,'))
    expect(result.phoneDropped).toEqual([{ line: 2 }])
    expect(result.refused).toEqual([{ line: 2, message: expect.stringMatching(/needs a \+ and a country code/) }])
    expect(await contacts()).toHaveLength(0)
  })

  it('refuses a row with no way to reach anybody, naming its line', async () => {
    const result = await importContacts(
      db, orgId,
      csv('rentman.io,a@rentman.io,,,,,,', 'rentman.io,,Nobody,Atall,Ghost,,,'),
    )
    expect(result.refused).toEqual([{ line: 3, message: 'A contact needs at least one way to reach them.' }])
    expect(result.inserted).toBe(1)
  })

  it("refuses a zone the runtime does not know with createContact's own sentence", async () => {
    const result = await importContacts(db, orgId, csv('rentman.io,a@rentman.io,,,,,,Pacific Time'))
    expect(result.refused).toEqual([
      {
        line: 2,
        message: '"Pacific Time" is not a timezone this system recognises. Use an IANA name like Europe/London.',
      },
    ])
  })

  it('refuses an address createContact cannot normalise, and a value past the form limits by column name', async () => {
    const long = 'x'.repeat(200)
    const result = await importContacts(
      db, orgId,
      csv('rentman.io,not-an-address,,,,,,', `rentman.io,a@rentman.io,,,${long},,,`),
    )
    expect(result.refused.map((r) => r.line)).toEqual([2, 3])
    expect(result.refused[0]?.message).toMatch(/could not be read as an email address/)
    expect(result.refused[1]?.message).toMatch(/^title: /)
  })

  it('refuses a row the parser marked, and a row with no domain', async () => {
    const rows: ContactSeedRow[] = [
      ...csv('rentman.io,a@rentman.io,A,B,VP, Security,,,'),
      { line: 9, domain: '', email: 'b@rentman.io', firstName: null, lastName: null, title: null, phone: null, linkedinUrl: null, timeZone: null },
    ]
    const result = await importContacts(db, orgId, rows)
    expect(result.refused.map((r) => r.line)).toEqual([2, 9])
    expect(result.refused[1]?.message).toMatch(/no domain/)
    expect(await contacts()).toHaveLength(0)
  })

  it('does nothing with nothing', async () => {
    expect(await importContacts(db, orgId, [])).toEqual({
      inserted: 0, alreadyPresent: 0, unknownCompany: [], refused: [], phoneDropped: [],
    })
  })
})
