/**
 * The sidebar search: one box over what the caller may see.
 *
 * Three properties matter and each has a test that would fail without it.
 * The needle is LITERAL — `%` and `_` are wildcards to Postgres, and a box
 * that passes them through finds rows nobody typed. Every branch is
 * ORG-SCOPED, joins included — the foreign keys to `companies` are by id
 * alone, so a row pointing across orgs is storable and the join is where it
 * would leak. And what a section is gated off from never reaches the
 * answer, nor does anything §2.3 keeps out of search altogether.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { ilike } from 'drizzle-orm'
import type { Role } from '@agency/core'
import {
  SEARCH_MAX_CHARS, SEARCH_PER_SECTION, SEARCH_TOTAL, containsPattern, escapeLike, schema, searchOrg,
  searchQueryFrom, searchSectionsFor, type AgencyDb, type SearchSections,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const ALL: SearchSections = {
  companies: true, contacts: true, deals: true, campaigns: true, meetings: true, proposals: true, touches: true, draftBodies: true,
}

describe('escapeLike', () => {
  it.each([
    ['plain', 'plain'],
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['%_\\', '\\%\\_\\\\'],
    ['', ''],
  ])('escapes %j as %j', (input, expected) => {
    expect(escapeLike(input)).toBe(expected)
  })

  it('wraps the escaped needle for a contains match', () => {
    expect(containsPattern('50%_off')).toBe('%50\\%\\_off%')
  })
})

describe('searchQueryFrom', () => {
  it('trims and collapses whitespace', () => {
    expect(searchQueryFrom('  rent \t\n  man ')).toEqual({ ok: true, q: 'rent man' })
  })

  /** One character on `%x%` is nearly every row of every table. */
  it('refuses fewer than two characters, counted after collapsing', () => {
    expect(searchQueryFrom('a').ok).toBe(false)
    expect(searchQueryFrom('   a   ').ok).toBe(false)
    expect(searchQueryFrom('').ok).toBe(false)
    expect(searchQueryFrom(null).ok).toBe(false)
    expect(searchQueryFrom('ab')).toEqual({ ok: true, q: 'ab' })
  })

  it('refuses more than the maximum', () => {
    expect(searchQueryFrom('x'.repeat(SEARCH_MAX_CHARS)).ok).toBe(true)
    const r = searchQueryFrom('x'.repeat(SEARCH_MAX_CHARS + 1))
    expect(r).toEqual({ ok: false, error: `q must be at most ${SEARCH_MAX_CHARS} characters` })
  })
})

describe('searchSectionsFor', () => {
  const ORG = '00000000-0000-4000-8000-00000000000a'
  const ME = '00000000-0000-4000-8000-000000000001'

  it('opens every section to both of today\'s roles', () => {
    for (const role of ['owner', 'member'] as const) {
      expect(searchSectionsFor({ id: ME, orgId: ORG, role })).toEqual(ALL)
    }
  })

  /**
   * No real role lacks a read capability today, so the gate is proved with a
   * role `can()` does not know — it fails closed, and so must search.
   */
  it('answers null for a principal who may read nothing', () => {
    expect(searchSectionsFor({ id: ME, orgId: ORG, role: 'auditor' as Role })).toBeNull()
    expect(searchSectionsFor(null)).toBeNull()
  })
})

describe('searchOrg', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const orgs = await db.insert(schema.orgs).values([{ name: 'Agency' }, { name: 'Rival' }]).returning({ id: schema.orgs.id })
    orgId = orgs[0]!.id
    otherOrgId = orgs[1]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const company = async (domain: string, name: string | null = null, org = orgId): Promise<string> => {
    const [row] = await db.insert(schema.companies).values({ orgId: org, domain, name }).returning({ id: schema.companies.id })
    return row!.id
  }

  const ids = (hits: readonly { id: string }[]): string[] => hits.map((h) => h.id).sort()

  describe('matching', () => {
    let literal: string
    let percentX: string

    beforeEach(async () => {
      literal = await company('one.example', '50%_off\\')
      await company('two.example', '50x_off')
      percentX = await company('three.example', '50%xoff')
      await company('four.example', 'Rentman')
      await company('five.example', 'rent man')
      await company('six.example', 'José García')
      await company('seven.example', null)
    })

    it('matches % and _ literally, on the real engine', async () => {
      const r = await searchOrg(db, orgId, '50%_off', ALL)
      expect(r.hits.map((h) => h.id)).toEqual([literal])
      // Left as a wildcard, `%x` would also find "50x_off".
      expect((await searchOrg(db, orgId, '%x', ALL)).hits.map((h) => h.id)).toEqual([percentX])
    })

    it('does not let _ stand for any character', async () => {
      // Left as a wildcard, `0_x` would find "50%xoff".
      expect((await searchOrg(db, orgId, '0_x', ALL)).hits).toEqual([])
      expect((await searchOrg(db, orgId, '50_off', ALL)).hits).toEqual([])
    })

    it('matches a backslash literally', async () => {
      expect((await searchOrg(db, orgId, 'f\\', ALL)).hits.map((h) => h.id)).toEqual([literal])
    })

    it('is case-insensitive, including outside ASCII', async () => {
      const r = await searchOrg(db, orgId, 'RENT', ALL)
      expect(r.hits.map((h) => h.label).sort()).toEqual(['Rentman', 'rent man'])
      expect((await searchOrg(db, orgId, 'JOSÉ', ALL)).hits.map((h) => h.label)).toEqual(['José García'])
    })

    /**
     * `''` as the needle matches every non-NULL row, which is why the minimum
     * exists; NULL matches nothing even then, and is never read as the text
     * "null".
     */
    it('never matches a NULL column', async () => {
      const everyNamed = await db
        .select({ domain: schema.companies.domain })
        .from(schema.companies)
        .where(ilike(schema.companies.name, containsPattern('')))
      expect(everyNamed.map((r) => r.domain)).not.toContain('seven.example')
      expect(everyNamed).toHaveLength(6)
      expect((await searchOrg(db, orgId, 'null', ALL)).hits).toEqual([])
    })

    it('labels a company with no name by its domain', async () => {
      const [hit] = (await searchOrg(db, orgId, 'seven', ALL)).hits
      expect(hit).toMatchObject({ kind: 'company', label: 'seven.example', sub: null, href: '/companies/seven.example' })
    })

    it('answers nothing below two characters, whatever the caller skipped', async () => {
      expect(await searchOrg(db, orgId, 'e', ALL)).toEqual({ hits: [], truncated: false })
      expect(await searchOrg(db, orgId, '  e  ', ALL)).toEqual({ hits: [], truncated: false })
      expect(await searchOrg(db, orgId, '%', ALL)).toEqual({ hits: [], truncated: false })
    })
  })

  describe('org isolation', () => {
    it('finds only the caller\'s company when two orgs share a name', async () => {
      const mine = await company('acme.example', 'Acme')
      await company('acme.example', 'Acme', otherOrgId)
      const r = await searchOrg(db, orgId, 'acme', ALL)
      expect(r.hits.map((h) => h.id)).toEqual([mine])
    })

    /**
     * `contacts.company_id` references `companies(id)` alone, so a contact
     * pointing at another org's company is storable. The join must not
     * print that company's domain in this org's results.
     */
    it('drops a row whose company belongs to another org', async () => {
      const theirs = await company('theirs.example', 'Theirs', otherOrgId)
      await db.insert(schema.contacts).values({ orgId, companyId: theirs, firstName: 'Crossed', email: 'crossed@theirs.example' })
      expect((await searchOrg(db, orgId, 'crossed', ALL)).hits).toEqual([])

      await db.insert(schema.touches).values({
        orgId, companyId: theirs, channel: 'email', direction: 'out', status: 'awaiting_approval', subject: 'Crossed wires',
      })
      const [touch] = (await searchOrg(db, orgId, 'crossed wires', ALL)).hits
      expect(touch!.kind).toBe('touch')
      expect(touch!.sub).not.toContain('theirs')
      expect(touch!.href).not.toContain('theirs')
    })

    it('finds nothing in another org\'s contacts, deals or messages', async () => {
      const theirs = await company('rival.example', 'Rival', otherOrgId)
      await db.insert(schema.contacts).values({ orgId: otherOrgId, companyId: theirs, firstName: 'Quill', email: 'quill@rival.example' })
      await db.insert(schema.deals).values({ orgId: otherOrgId, companyId: theirs, nextAction: 'quill follow up' })
      await db.insert(schema.touches).values({
        orgId: otherOrgId, companyId: theirs, channel: 'email', direction: 'in', status: 'replied', body: 'quill here',
      })
      expect((await searchOrg(db, orgId, 'quill', ALL)).hits).toEqual([])
    })
  })

  describe('sections', () => {
    let companyId: string

    beforeEach(async () => {
      companyId = await company('rentman.io', 'Rentman')
    })

    it('returns no contact when the contacts section is off, even when one matches', async () => {
      await db.insert(schema.contacts).values({ orgId, companyId, firstName: 'Priya', lastName: 'Shah', email: 'priya@rentman.io' })
      expect((await searchOrg(db, orgId, 'priya', ALL)).hits.map((h) => h.kind)).toEqual(['contact'])
      expect((await searchOrg(db, orgId, 'priya', { ...ALL, contacts: false })).hits).toEqual([])
    })

    it('returns no deal, meeting or proposal when the deals sections are off', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, nextAction: 'Send the osprey scope' })
      await db.insert(schema.meetings).values({ orgId, companyId, title: 'Osprey call', startsAt: new Date('2026-10-03T14:00:00Z'), timeZone: 'Europe/London' })
      const [scan] = await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning({ id: schema.scans.id })
      await db.insert(schema.proposals).values({ orgId, companyId, scanId: scan!.id, title: 'Osprey posture review', document: {} })

      expect((await searchOrg(db, orgId, 'osprey', ALL)).hits.map((h) => h.kind)).toEqual(['deal', 'meeting', 'proposal'])
      const off = await searchOrg(db, orgId, 'osprey', { ...ALL, deals: false, meetings: false, proposals: false })
      expect(off.hits).toEqual([])
    })

    /** A draft body is what a person approves; it is found only by somebody who may. */
    it('matches an outbound body only with draftBodies', async () => {
      await db.insert(schema.touches).values({
        orgId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval', subject: 'A gap', body: 'Hello — a quick heron note.',
      })
      expect((await searchOrg(db, orgId, 'heron', { ...ALL, draftBodies: false })).hits).toEqual([])
      const r = await searchOrg(db, orgId, 'heron', ALL)
      expect(r.hits).toHaveLength(1)
      expect(r.hits[0]).toMatchObject({ kind: 'touch', label: 'A gap', href: '/companies/rentman.io' })
      // The subject is findable either way; only the body is gated.
      expect((await searchOrg(db, orgId, 'a gap', { ...ALL, draftBodies: false })).hits).toHaveLength(1)
    })

    /** A reply is the contact's own words, and "who said interested" is the point of the box. */
    it('matches an inbound body under the touches section alone', async () => {
      await db.insert(schema.touches).values({
        orgId, companyId, channel: 'email', direction: 'in', status: 'replied', subject: 'Re: A gap', body: 'We are interested, call me.',
      })
      const r = await searchOrg(db, orgId, 'interested', { ...ALL, draftBodies: false })
      expect(r.hits).toHaveLength(1)
      expect(r.hits[0]).toMatchObject({ kind: 'touch', label: 'Re: A gap', sub: 'email reply · Rentman' })
      expect((await searchOrg(db, orgId, 'interested', { ...ALL, touches: false, draftBodies: false })).hits).toEqual([])
    })

    it('never shows a body in a hit', async () => {
      await db.insert(schema.touches).values({
        orgId, companyId, channel: 'email', direction: 'in', status: 'replied', subject: null, body: 'Please call me on the pelican line.',
      })
      const [hit] = (await searchOrg(db, orgId, 'pelican', ALL)).hits
      expect(JSON.stringify(hit)).not.toContain('pelican')
      expect(hit!.label).toBe('Reply with no subject')
    })
  })

  /**
   * §2.3: the needle is planted in every excluded place, and nowhere a
   * search is allowed to look. None of it may come back.
   */
  it('does not search connectors, prompts, chat, audit detail, raw scans, users or provider ids', async () => {
    const companyId = await company('plain.example', 'Plain')
    // The one place it may be found, so an empty answer cannot mean the
    // search did not run.
    const allowed = await company('kestrel.example', 'Kestrel Ltd')
    const [user] = await db.insert(schema.users).values({ orgId, email: 'kestrel@agency.test', name: 'Kestrel', role: 'owner' }).returning({ id: schema.users.id })
    await db.insert(schema.chatSessions).values({ orgId, userId: user!.id, title: 'kestrel plan' })
    await db.insert(schema.auditLog).values({ orgId, actor: user!.id, action: 'kestrel.done', detail: { note: 'kestrel' } })
    await db.insert(schema.agentDefs).values({ orgId, slug: 'kestrel', name: 'Kestrel', description: 'kestrel', systemPrompt: 'kestrel' })
    await db.insert(schema.connectors).values({ orgId, name: 'kestrel', kind: 'http', config: { url: 'https://kestrel.example/mcp' } })
    await db.insert(schema.scans).values({ orgId, companyId, ok: true, raw: { server: 'kestrel' } })
    await db.insert(schema.touches).values({
      orgId, companyId, channel: 'email', direction: 'out', status: 'sent', subject: 'Hello', providerId: '<kestrel@mail.example>',
    })
    expect((await searchOrg(db, orgId, 'kestrel', ALL)).hits.map((h) => h.id)).toEqual([allowed])
  })

  describe('caps', () => {
    it('stops a section at its cap and says so', async () => {
      for (let i = 1; i <= SEARCH_PER_SECTION + 2; i++) await company(`zeta${i}.example`, `Zeta ${i}`)
      const r = await searchOrg(db, orgId, 'zeta', ALL)
      expect(r.hits).toHaveLength(SEARCH_PER_SECTION)
      expect(r.truncated).toBe(true)
    })

    it('does not claim more when a section holds exactly the cap', async () => {
      for (let i = 1; i <= SEARCH_PER_SECTION; i++) await company(`zeta${i}.example`, `Zeta ${i}`)
      const r = await searchOrg(db, orgId, 'zeta', ALL)
      expect(r.hits).toHaveLength(SEARCH_PER_SECTION)
      expect(r.truncated).toBe(false)
    })

    it('stops the whole answer at the total, in section order', async () => {
      const [scanFor, companies]: [Map<string, string>, string[]] = [new Map(), []]
      for (let i = 1; i <= SEARCH_PER_SECTION + 1; i++) {
        const id = await company(`zeta${i}.example`, `Zeta ${i}`)
        companies.push(id)
        const [scan] = await db.insert(schema.scans).values({ orgId, companyId: id, ok: true }).returning({ id: schema.scans.id })
        scanFor.set(id, scan!.id)
      }
      for (const [i, companyId] of companies.entries()) {
        await db.insert(schema.contacts).values({ orgId, companyId, firstName: 'Zeta', lastName: `${i}` })
        await db.insert(schema.deals).values({ orgId, companyId, nextAction: 'zeta' })
        await db.insert(schema.meetings).values({ orgId, companyId, title: 'Zeta', startsAt: new Date(Date.UTC(2026, 9, 1 + i)), timeZone: 'UTC' })
        await db.insert(schema.proposals).values({ orgId, companyId, scanId: scanFor.get(companyId)!, title: 'Zeta', document: {} })
        await db.insert(schema.campaigns).values({ orgId, name: `Zeta ${i}`, channel: 'email' })
        await db.insert(schema.touches).values({ orgId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval', subject: 'Zeta' })
      }
      const r = await searchOrg(db, orgId, 'zeta', ALL)
      expect(SEARCH_TOTAL).toBeLessThan(7 * SEARCH_PER_SECTION)
      expect(r.hits).toHaveLength(SEARCH_TOTAL)
      expect(r.truncated).toBe(true)
      const order = [...new Set(r.hits.map((h) => h.kind))]
      expect(order).toEqual(['company', 'contact', 'deal', 'meeting', 'proposal'])
    })
  })

  describe('links', () => {
    it('sends every kind to the page that shows it', async () => {
      const companyId = await company('rentman.io', 'Rentman')
      const [contact] = await db.insert(schema.contacts).values({ orgId, companyId, firstName: 'Wren', lastName: 'Hale', email: 'wren@rentman.io' }).returning({ id: schema.contacts.id })
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting', nextAction: 'wren to confirm' })
      const [meeting] = await db.insert(schema.meetings).values({ orgId, companyId, title: 'Wren intro', startsAt: new Date('2026-10-03T14:00:00Z'), timeZone: 'Europe/London' }).returning({ id: schema.meetings.id })
      const [scan] = await db.insert(schema.scans).values({ orgId, companyId, ok: true }).returning({ id: schema.scans.id })
      const [proposal] = await db.insert(schema.proposals).values({ orgId, companyId, scanId: scan!.id, title: 'Wren scope', document: {} }).returning({ id: schema.proposals.id })
      await db.insert(schema.campaigns).values({ orgId, name: 'Wren outreach', channel: 'email' })
      await db.insert(schema.touches).values({ orgId, companyId, contactId: contact!.id, channel: 'email', direction: 'out', status: 'awaiting_approval', subject: 'Wren, a gap' })

      const r = await searchOrg(db, orgId, 'wren', ALL)
      const by = Object.fromEntries(r.hits.map((h) => [h.kind, h]))
      expect(by.contact).toMatchObject({ id: contact!.id, label: 'Wren Hale', href: '/companies/rentman.io', sub: 'wren@rentman.io · Rentman' })
      expect(by.deal).toMatchObject({ label: 'Rentman', sub: 'meeting · wren to confirm', href: '/companies/rentman.io' })
      // In the meeting's own zone: 14:00Z is 15:00 in London in October.
      expect(by.meeting).toMatchObject({ href: `/meetings/${meeting!.id}`, sub: '3 Oct 2026, 15:00 (Europe/London) · Rentman' })
      expect(by.proposal).toMatchObject({ href: `/proposals/${proposal!.id}`, sub: 'draft · Rentman' })
      expect(by.campaign).toMatchObject({ href: '/campaigns', sub: 'email · draft' })
      expect(by.touch).toMatchObject({ href: '/companies/rentman.io', sub: 'email awaiting approval · Rentman' })
    })

    it('encodes the domain in a company link', async () => {
      await company('bücher.example', 'Bücher')
      const [hit] = (await searchOrg(db, orgId, 'bücher', ALL)).hits
      expect(hit!.href).toBe('/companies/b%C3%BCcher.example')
    })

    it('finds a deal by its stage as a whole word, not as a substring', async () => {
      const a = await company('a.example', 'A')
      const b = await company('b.example', 'B')
      const [atMeeting] = await db.insert(schema.deals).values({ orgId, companyId: a, stage: 'meeting' }).returning({ id: schema.deals.id })
      await db.insert(schema.deals).values({ orgId, companyId: b, stage: 'new' })
      expect(ids((await searchOrg(db, orgId, 'Meeting', ALL)).hits.filter((h) => h.kind === 'deal'))).toEqual([atMeeting!.id])
      expect((await searchOrg(db, orgId, 'meet', ALL)).hits.filter((h) => h.kind === 'deal')).toEqual([])
    })
  })
})
