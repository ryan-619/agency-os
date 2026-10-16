/**
 * The delete tools (2026-10-15), against a real engine: each deletes through
 * the web's own writer as the agent, keeps an item whose name, domain or
 * title does not match what is stored — the card named something else —
 * keeps what the writer refuses in the writer's own sentence, and never
 * prints an address. Whether a call waits for a card is the gate's
 * (`risk.test.ts`, `gate.test.ts`); these are the handlers behind it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { noSiteDomain, type Principal } from '@agency/core'
import type { AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import { createMeeting, rescheduleMeeting } from '@agency/db'
import {
  DELETED_NOT_FILED_AGAIN, DELETE_BUDGET_MS, DELETE_COMPANIES_PER_CALL, DELETE_COMPANY_PEOPLE_MAX, DELETE_PER_CALL,
  TOOL_TEXT_BUDGET, TOOL_TIME_BUDGET_MS, addCompany, deleteCompanies,
  deleteContacts, deleteMeeting, deleteTask, makeDeleteCompanies, makeDeleteContacts, type AgencyToolSpec, type ToolContext,
  type ToolOutcome,
} from '../src/index.js'

const NOON = new Date('2026-10-15T12:00:00.000Z')

describe('the delete tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let ownerId: string
  let companyId: string
  let campaignId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning())[0]!.id
    otherOrgId = (await db.insert(schema.orgs).values({ name: 'Somebody Else' }).returning())[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'priya@accemy.test', name: 'Priya', role: 'owner' }).returning())[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'carbonmaps.io', name: 'Carbon Maps' }).returning())[0]!.id
    campaignId = (await db.insert(schema.campaigns).values({ orgId, name: 'Q4', channel: 'email', status: 'active' }).returning())[0]!.id
  }, 30_000)
  afterEach(async () => {
    await test?.close()
  })

  const ctx = (role: Principal['role'] = 'owner'): ToolContext => ({
    db, orgId, principal: { id: ownerId, orgId, role }, turnId: '44444444-4444-4444-8444-444444444444',
    now: () => NOON,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, role: Principal['role'] = 'owner') =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(role))
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }
  const contact = async (values: Partial<typeof schema.contacts.$inferInsert> = {}, company = companyId, org = orgId) =>
    (await db.insert(schema.contacts).values({ orgId: org, companyId: company, firstName: 'Alex', lastName: 'Chen', email: 'security@carbonmaps.io', ...values }).returning())[0]!.id
  const touch = async (values: Partial<typeof schema.touches.$inferInsert>) =>
    (await db.insert(schema.touches).values({ orgId, channel: 'email', direction: 'out', status: 'awaiting_approval', ...values }).returning())[0]!.id
  const exists = async (table: typeof schema.contacts | typeof schema.companies | typeof schema.meetings | typeof schema.tasks, id: string) =>
    (await db.select({ id: table.id }).from(table as typeof schema.contacts).where(eq(table.id, id))).length === 1
  const auditRows = (action: string) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))

  // -------------------------------------------------------------------------

  describe('delete_contacts', () => {
    it('deletes the invented person with their draft, and keeps everybody the card did not name truly', async () => {
      const alex = await contact()
      const draft = await touch({ campaignId, contactId: alex, companyId, subject: 'Hello', body: 'An opener.' })
      const sam = await contact({ firstName: 'Sam', lastName: null, email: 'sam@carbonmaps.io' })
      const jo = await contact({ firstName: 'Jo', lastName: null, email: 'jo@carbonmaps.io' })
      const ravi = await contact({ firstName: 'Ravi', lastName: null, email: 'ravi@carbonmaps.io' })
      await touch({ campaignId, contactId: ravi, companyId, status: 'sent', sentAt: NOON, recipient: 'ravi@carbonmaps.io' })
      const otherCompany = (await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'elsewhere.io', name: 'Elsewhere' }).returning())[0]!.id
      const theirs = await contact({ firstName: 'Kim', email: 'kim@elsewhere.io' }, otherCompany, otherOrgId)

      const out = await run(deleteContacts, {
        contacts: [
          { contactId: alex, name: 'alex  chen', emailDomain: '…@carbonmaps.io' },
          { contactId: alex, name: 'Alex Chen' },
          { contactId: sam, name: 'Samuel' },
          { contactId: jo, emailDomain: '@gmail.com' },
          { contactId: ravi, name: 'Ravi' },
          { contactId: theirs },
        ],
        why: 'invented by the assistant to test the features',
      })
      const s = summaryOf(out)
      expect(s).toContain('Deleted 1 of 5 contacts; 4 kept, each with why:')
      expect(s).toContain(`Deleted Alex Chen at carbonmaps.io — id ${alex}, with 1 waiting draft.`)
      expect(s).toContain(`Kept Sam at carbonmaps.io — id ${sam}: the name on file is not “Samuel”.`)
      expect(s).toContain(`Kept Jo at carbonmaps.io — id ${jo}: their email on file is at another domain, not …@gmail.com.`)
      expect(s).toContain(`Kept Ravi at carbonmaps.io — id ${ravi}: Something went out to this contact or came from them`)
      expect(s).toContain('An owner can erase them on /contacts')
      expect(s).toContain(`Kept id ${theirs}: no such contact in this org`)
      expect(s).toContain('A suppression on anybody’s address stays on the list. Nothing was sent.')
      // Never a whole address.
      expect(s).not.toMatch(/[a-z]+@carbonmaps\.io/)

      expect(await exists(schema.contacts, alex)).toBe(false)
      expect((await db.select().from(schema.touches).where(eq(schema.touches.id, draft))).length).toBe(0)
      for (const id of [sam, jo, ravi, theirs]) expect(await exists(schema.contacts, id), id).toBe(true)
      expect(audited.at(-1)).toEqual({ action: 'agent.delete_contacts', detail: { asked: 5, deleted: 1, kept: 4 } })
      const [row] = await auditRows('contact.deleted')
      expect(row).toMatchObject({ actor: 'agent', subjectType: 'contact', subjectId: alex })
    })

    /**
     * `z.uuid()` takes capitals, and the rows come back lower-cased (review,
     * 2026-10-15): looked up as typed, an existing person was "no such
     * contact — it may already have been deleted" while they stayed on
     * file, and one id in both spellings counted twice.
     */
    it('reads an id in capitals as the one the database prints, once', async () => {
      const alex = await contact()
      const s = summaryOf(await run(deleteContacts, {
        contacts: [{ contactId: alex.toUpperCase(), name: 'Alex Chen' }, { contactId: alex }],
        why: 'invented',
      }))
      expect(s).toContain('Deleted 1 of 1 contact:')
      expect(s).toContain(`Deleted Alex Chen at carbonmaps.io — id ${alex}.`)
      expect(s).not.toContain('no such contact')
      expect(await exists(schema.contacts, alex)).toBe(false)
    })

    it('says a person with no name recorded as list_contacts printed them, and refuses a role that cannot delete', async () => {
      const nameless = await contact({ firstName: null, lastName: null })
      const s = summaryOf(await run(deleteContacts, { contacts: [{ contactId: nameless, name: '(no name recorded)' }], why: 'a duplicate' }))
      expect(s).toContain(`Deleted (no name recorded) at carbonmaps.io — id ${nameless}.`)

      const kept = await contact()
      const refused = await run(deleteContacts, { contacts: [{ contactId: kept }], why: 'x' }, 'viewer' as Principal['role'])
      expect(refused).toMatchObject({ ok: false, code: 'not_permitted' })
      const blank = await run(deleteContacts, { contacts: [{ contactId: kept }], why: '   ' })
      expect(blank).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(await exists(schema.contacts, kept)).toBe(true)
      expect(await auditRows('contact.deleted')).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------

  describe('delete_companies', () => {
    it('deletes a company filed under a dead domain with what hangs off it, and keeps one that was written to', async () => {
      const cafe = (await db.insert(schema.companies).values({ orgId, domain: 'yummybites-delhi.business.site', name: 'Yummy Bites', source: 'agent' }).returning())[0]!.id
      await contact({ firstName: 'Ana', email: 'ana@yummybites.in' }, cafe)
      await db.insert(schema.scans).values({ orgId, companyId: cafe, ok: false, error: 'unreachable' })
      await db.insert(schema.deals).values({ orgId, companyId: cafe, stage: 'contacted' })
      const guessed = (await db.insert(schema.companies).values({ orgId, domain: 'farmley-foods.in', name: 'Farmley', source: 'agent' }).returning())[0]!.id
      // A business filed with no website is named by its name, as the company page's Delete takes it.
      const nosite = (await db.insert(schema.companies).values({ orgId, domain: noSiteDomain('Chai Point', 'x7k2'), name: 'Chai  Point', source: 'agent' }).returning())[0]!.id
      const ravi = await contact({ firstName: 'Ravi', email: 'ravi@carbonmaps.io' })
      await touch({ campaignId, contactId: ravi, companyId, status: 'sent', sentAt: NOON, recipient: 'ravi@carbonmaps.io' })

      const s = summaryOf(
        await run(deleteCompanies, {
          companies: [
            { companyId: cafe, domain: 'https://www.YummyBites-Delhi.business.site/' },
            { companyId: guessed, domain: 'farmley-foods.in' },
            { companyId: nosite, domain: 'chai point' },
            { companyId, domain: 'carbonmaps.io' },
          ],
          why: 'filed under a business.site domain that does not exist',
        }),
      )
      expect(s).toContain('Deleted 3 of 4 companies; 1 kept, each with why:')
      expect(s).toContain(`Deleted Chai Point (no website on record) — id ${nosite}.`)
      expect(s).toContain(`Deleted yummybites-delhi.business.site — id ${cafe}, with 1 person, 1 deal and 1 scan.`)
      expect(s).toContain(`Deleted farmley-foods.in — id ${guessed}.`)
      expect(s).toContain(`Kept carbonmaps.io — id ${companyId}: Messages or calls went to or came from carbonmaps.io`)
      expect(s).toContain('Neither the night shift nor add_company')
      expect(s).not.toMatch(/[a-z]+@/)
      expect(await exists(schema.companies, cafe)).toBe(false)
      expect(await exists(schema.companies, companyId)).toBe(true)
      expect(audited.at(-1)).toEqual({ action: 'agent.delete_companies', detail: { asked: 4, deleted: 3, kept: 1 } })
      expect((await auditRows('company.deleted')).map((r) => r.actor)).toEqual(['agent', 'agent', 'agent'])

      // Not filed again by the agent; a person can, on /companies.
      const again = await run(addCompany, { domain: 'farmley-foods.in' })
      expect(again).toMatchObject({ ok: false, code: 'not_permitted' })
      if (!again.ok) expect(again.message).toMatch(/^farmley-foods\.in was deleted by a teammate on \d{4}-\d{2}-\d{2}; a person can add it again on \/companies\./)
    })

    it('reads a company id in capitals as the one the database prints', async () => {
      const guessed = (await db.insert(schema.companies).values({ orgId, domain: 'farmley-foods.in', name: 'Farmley' }).returning())[0]!.id
      const s = summaryOf(await run(deleteCompanies, {
        companies: [{ companyId: guessed.toUpperCase(), domain: 'farmley-foods.in' }, { companyId: guessed, domain: 'farmley-foods.in' }],
        why: 'a guessed domain',
      }))
      expect(s).toContain('Deleted 1 of 1 company:')
      expect(s).not.toContain('no such company')
      expect(await exists(schema.companies, guessed)).toBe(false)
      // What keeps it out is said as exactly what the keys match.
      expect(s).toContain(DELETED_NOT_FILED_AGAIN)
      expect(DELETED_NOT_FILED_AGAIN).toContain('through add_company, only with the same name, city and address as before')
      expect(DELETED_NOT_FILED_AGAIN).toContain('or a Google listing for one first filed by name is not recognised, so check search_crm')
      expect(s).not.toMatch(/the placeholder its name and city or address make/)
    })

    /**
     * A company's delete costs about one round trip more per person (review,
     * 2026-10-15): fifty people started late in a call ran to about 35 s,
     * past the MCP call's 30, and the model heard that it failed while it
     * went. Past `DELETE_COMPANY_PEOPLE_MAX` it is kept, and sent to the
     * company page.
     */
    it('keeps a company with more people than a call can delete in its time, and deletes one at the bound', async () => {
      const big = (await db.insert(schema.companies).values({ orgId, domain: 'big-import.io', name: 'Big' }).returning())[0]!.id
      const atBound = (await db.insert(schema.companies).values({ orgId, domain: 'at-bound.io', name: 'At' }).returning())[0]!.id
      const people = (company: string, n: number) =>
        db.insert(schema.contacts).values(Array.from({ length: n }, (_, i) => ({ orgId, companyId: company, firstName: `P${i}`, email: `p${i}@${company}.test` })))
      await people(big, DELETE_COMPANY_PEOPLE_MAX + 1)
      await people(atBound, DELETE_COMPANY_PEOPLE_MAX)
      expect(DELETE_COMPANY_PEOPLE_MAX).toBe(15)
      const s = summaryOf(await run(deleteCompanies, {
        companies: [{ companyId: big, domain: 'big-import.io' }, { companyId: atBound, domain: 'at-bound.io' }],
        why: 'a CSV imported by mistake',
      }))
      expect(s).toContain(
        `Kept big-import.io — id ${big}: it has 16 people — more than this call can delete in its time. An owner deletes ` +
          'it on its company page, which has no such time limit.',
      )
      expect(s).toContain(`Deleted at-bound.io — id ${atBound}, with 15 people.`)
      expect(await exists(schema.companies, big)).toBe(true)
      expect((await db.select().from(schema.contacts).where(eq(schema.contacts.companyId, big))).length).toBe(16)
      expect(await exists(schema.companies, atBound)).toBe(false)
    })

    it('keeps a company where a call recorded that they asked to stop, as delete_task keeps the call', async () => {
      const kumar = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental', phone: '+918041234567' }).returning())[0]!.id
      const call = (await db.insert(schema.tasks).values({
        orgId, companyId: kumar, kind: 'call', title: 'Call Kumar Dental', doneAt: NOON, doneBy: ownerId, outcome: 'asked_to_stop',
      }).returning())[0]!.id
      const s = summaryOf(await run(deleteCompanies, { companies: [{ companyId: kumar, domain: 'kumardental.in' }], why: 'x' }))
      expect(s).toContain(
        `Kept kumardental.in — id ${kumar}: A call to kumardental.in is recorded where they asked to stop, and that is ` +
          'where the suppression on their number came from, so the company stays on the record.',
      )
      expect(await exists(schema.companies, kumar)).toBe(true)
      expect(await exists(schema.tasks, call)).toBe(true)
      const viaTask = await run(deleteTask, { taskId: call, title: 'Call Kumar Dental', why: 'x' })
      expect(viaTask).toMatchObject({ ok: false, code: 'invalid_state' })
    })

    it('keeps a company whose domain does not match the card, never prints a booking-page address, and is an owner’s', async () => {
      const lead = (await db.insert(schema.companies).values({ orgId, domain: 'ravi@gmail.com.inbound', name: 'Ravi Kumar' }).returning())[0]!.id
      const s = summaryOf(
        await run(deleteCompanies, {
          companies: [{ companyId, domain: 'carbon-maps.io' }, { companyId: lead, domain: 'someone@gmail.com.inbound' }],
          why: 'a mistake',
        }),
      )
      expect(s).toContain(`Kept carbonmaps.io — id ${companyId}: its domain on file is not “carbon-maps.io”.`)
      expect(s).toContain(`Kept a booking-page lead — id ${lead}: its domain on file is not the domain given.`)
      expect(s).not.toContain('@')
      expect(await exists(schema.companies, companyId)).toBe(true)
      expect(await exists(schema.companies, lead)).toBe(true)

      const member = await run(deleteCompanies, { companies: [{ companyId, domain: 'carbonmaps.io' }], why: 'x' }, 'member')
      expect(member).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await exists(schema.companies, companyId)).toBe(true)
      expect(await auditRows('company.deleted')).toEqual([])
    })
  })

  // -------------------------------------------------------------------------

  /**
   * A call answers inside its time (review, 2026-10-15). Each company costs
   * about thirty round trips and each person fifteen, at about 200 ms each
   * from the operator's Mac to the database; past the MCP call's 30 s the
   * model was told the delete failed while every record went. Now a call
   * stops STARTING items at its budget, as enrol_contacts stops drafting,
   * and names the ones it did not reach.
   */
  describe('the time a delete call has', () => {
    /** A clock that reads 0 at the start and for the first `n` checks, then the whole budget. */
    const clockAfter = (n: number) => {
      let reads = 0
      return () => (reads++ <= n ? 0 : DELETE_BUDGET_MS)
    }

    it('stops starting people at its budget, deletes none of the rest, and names them to be asked for again', async () => {
      const alex = await contact()
      const sam = await contact({ firstName: 'Sam', lastName: null, email: 'sam@carbonmaps.io' })
      const jo = await contact({ firstName: 'Jo', lastName: null, email: 'jo@carbonmaps.io' })
      const tool = makeDeleteContacts({ clock: clockAfter(1) })
      const s = summaryOf(await run(tool, { contacts: [{ contactId: alex }, { contactId: sam }, { contactId: jo }], why: 'invented' }))
      // The ids to ask for again come right after the headline, before anything a cut could take.
      expect(s.split('\n').slice(0, 4)).toEqual([
        'Deleted 1 of 3 contacts; 2 not reached:',
        '  Not deleted — the time for this call ran out; call again for these:',
        `    id ${sam} — Sam`,
        `    id ${jo} — Jo`,
      ])
      expect(s).toContain(`Deleted Alex Chen at carbonmaps.io — id ${alex}.`)
      expect(await exists(schema.contacts, alex)).toBe(false)
      for (const id of [sam, jo]) expect(await exists(schema.contacts, id)).toBe(true)
      expect(audited.at(-1)).toEqual({ action: 'agent.delete_contacts', detail: { asked: 3, deleted: 1, kept: 0, notReached: 2 } })
      expect(await auditRows('contact.deleted')).toHaveLength(1)
    })

    it('stops starting companies at its budget, and names them', async () => {
      const a = (await db.insert(schema.companies).values({ orgId, domain: 'a-invented.io', name: 'A' }).returning())[0]!.id
      const b = (await db.insert(schema.companies).values({ orgId, domain: 'b-invented.io', name: 'B' }).returning())[0]!.id
      const tool = makeDeleteCompanies({ clock: clockAfter(1) })
      const out = await run(tool, { companies: [{ companyId: a, domain: 'a-invented.io' }, { companyId: b, domain: 'b-invented.io' }], why: 'x' })
      const s = summaryOf(out)
      expect(s).toContain('Deleted 1 of 2 companies; 1 not reached:')
      expect(s).toContain(`Not deleted — the time for this call ran out; call again for these:\n    id ${b} — b-invented.io`)
      expect(await exists(schema.companies, a)).toBe(false)
      expect(await exists(schema.companies, b)).toBe(true)
      expect(out).toMatchObject({ ok: true, data: { deleted: [a], kept: 0, notReached: [b] } })
      expect(audited.at(-1)).toEqual({ action: 'agent.delete_companies', detail: { asked: 2, deleted: 1, kept: 0, notReached: 1 } })
    })

    /**
     * `bounded` cut from the tail, and the not-reached list sat last: long
     * names lost the very ids the model must ask for again, and the closing
     * line (review, 2026-10-15). Now they come first, the item lines are cut
     * to the room left, and the closing line always stays.
     */
    it('keeps every not-reached id and the closing line however long the item lines run', async () => {
      const people: string[] = []
      for (let i = 0; i < 25; i++) {
        const id = await contact({
          firstName: `Person${String(i).padStart(2, '0')} ${'x'.repeat(70)}`,
          lastName: null,
          title: `Head of ${'y'.repeat(52)}`,
          email: `p${i}@carbonmaps.io`,
        })
        // Each is kept, with the writer's long sentence.
        await db.insert(schema.consents).values({ orgId, contactId: id, channel: 'email', granted: false, source: 'said no' })
        people.push(id)
      }
      const tool = makeDeleteContacts({ clock: clockAfter(20) })
      const s = summaryOf(await run(tool, { contacts: people.map((contactId) => ({ contactId })), why: 'invented' }))
      expect(s.length).toBeLessThanOrEqual(TOOL_TEXT_BUDGET)
      expect(s).toMatch(/^Deleted 0 of 25 contacts; 20 kept, each with why; 5 not reached:/)
      for (const id of people.slice(20)) expect(s).toContain(`    id ${id} — Person`)
      expect(s).toMatch(/ more lines cut to fit; the headline counts every item\./)
      expect(s.endsWith('A suppression on anybody’s address stays on the list. Nothing was sent.')).toBe(true)
      expect(await auditRows('contact.deleted')).toHaveLength(0)
    })

    it('leaves the adapter’s cut-off room, and takes at most five companies a call', () => {
      expect(DELETE_BUDGET_MS).toBe(TOOL_TIME_BUDGET_MS - 5_000)
      expect(DELETE_COMPANIES_PER_CALL).toBe(5)
      expect(DELETE_PER_CALL).toBe(25)
      const six = Array.from({ length: 6 }, (_, i) => ({ companyId: `00000000-0000-4000-8000-00000000000${i}`, domain: `c${i}.io` }))
      expect(z.object(deleteCompanies.shape).safeParse({ companies: six, why: 'x' }).success).toBe(false)
      expect(z.object(deleteCompanies.shape).safeParse({ companies: six.slice(0, 5), why: 'x' }).success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------

  describe('delete_meeting', () => {
    it('deletes a meeting with no outcome, and keeps one whose company or outcome says otherwise', async () => {
      const booked = (await db.insert(schema.meetings).values({ orgId, companyId, startsAt: NOON, timeZone: 'Asia/Kolkata', title: 'Intro', source: 'agent' }).returning())[0]!.id
      const wrong = await run(deleteMeeting, { meetingId: booked, domain: 'rentman.io', why: 'booked with a person who does not exist' })
      expect(wrong).toMatchObject({ ok: false, code: 'invalid_state' })
      if (!wrong.ok) expect(wrong.message).toContain(`Meeting ${booked} is with carbonmaps.io, not “rentman.io”.`)
      expect(await exists(schema.meetings, booked)).toBe(true)

      const s = summaryOf(await run(deleteMeeting, { meetingId: booked, domain: 'carbonmaps.io', why: 'booked with a person who does not exist' }))
      expect(s).toContain('Deleted the meeting with carbonmaps.io “Intro” at 2026-10-15 17:30 Asia/Kolkata (2026-10-15 12:00 UTC)')
      expect(s).toContain('The deal stays where it is')
      expect(await exists(schema.meetings, booked)).toBe(false)
      expect(audited.at(-1)).toEqual({ action: 'agent.delete_meeting', detail: { meetingId: booked, companyId } })
      expect((await auditRows('meeting.deleted'))[0]).toMatchObject({ actor: 'agent', subjectId: booked })

      const held = (await db.insert(schema.meetings).values({ orgId, companyId, startsAt: NOON, timeZone: 'UTC', outcome: 'held' }).returning())[0]!.id
      const kept = await run(deleteMeeting, { meetingId: held, domain: 'carbonmaps.io', why: 'x' })
      expect(kept).toMatchObject({ ok: false, code: 'invalid_state' })
      if (!kept.ok) expect(kept.message).toMatch(/Its outcome is recorded; it stays\. .*record_meeting_outcome\. Nothing was deleted\./)
      expect(await exists(schema.meetings, held)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------

  describe('delete_meeting, of a reschedule’s replacement', () => {
    it('is refused, and says to cancel it instead', async () => {
      const booked = await createMeeting(db, {
        orgId, companyId, startsAt: new Date(Date.now() - 3_600_000), timeZone: 'UTC', source: 'agent', actor: 'agent',
      })
      if (!booked.ok) throw new Error(booked.message)
      const moved = await rescheduleMeeting(db, { orgId, id: booked.meeting.id, startsAt: new Date(Date.now() + 86_400_000), timeZone: 'UTC', actor: ownerId })
      if (!moved.ok) throw new Error(moved.message)
      const out = await run(deleteMeeting, { meetingId: moved.replacement.id, domain: 'carbonmaps.io', why: 'x' })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      if (!out.ok) expect(out.message).toBe('It replaced a rescheduled meeting; cancel it instead. Nothing was deleted.')
      expect(await exists(schema.meetings, moved.replacement.id)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------

  describe('delete_task', () => {
    it('deletes a task by id and title, and keeps a LinkedIn step and a mismatched title', async () => {
      const call = (await db.insert(schema.tasks).values({ orgId, companyId, kind: 'call', title: 'Call Alex Chen  at Carbon Maps' }).returning())[0]!.id
      const wrong = await run(deleteTask, { taskId: call, title: 'Call Sam', why: 'a call to a person who does not exist' })
      expect(wrong).toMatchObject({ ok: false, code: 'invalid_state' })
      if (!wrong.ok) expect(wrong.message).toContain(`Task ${call} is “Call Alex Chen at Carbon Maps”, not “Call Sam”.`)

      const s = summaryOf(await run(deleteTask, { taskId: call, title: 'call alex chen at carbon maps', why: 'a call to a person who does not exist' }))
      expect(s).toBe(`Deleted the task “Call Alex Chen at Carbon Maps” about carbonmaps.io (task ${call}). Nothing was sent.`)
      expect(await exists(schema.tasks, call)).toBe(false)
      expect(audited.at(-1)).toEqual({ action: 'agent.delete_task', detail: { taskId: call, kind: 'call', companyId } })

      const alex = await contact()
      const linkedin = await touch({ campaignId, contactId: alex, companyId, channel: 'linkedin', status: 'approved', approvedBy: ownerId, approvedAt: NOON })
      const step = (await db.insert(schema.tasks).values({ orgId, companyId, touchId: linkedin, kind: 'linkedin_send', title: 'Send it' }).returning())[0]!.id
      const kept = await run(deleteTask, { taskId: step, title: 'Send it', why: 'x' })
      expect(kept).toMatchObject({ ok: false, code: 'invalid_state' })
      if (!kept.ok) expect(kept.message).toContain('A LinkedIn step is closed on /tasks')
      expect(await exists(schema.tasks, step)).toBe(true)

      const gone = await run(deleteTask, { taskId: call, title: 'Call Alex Chen at Carbon Maps', why: 'x' })
      expect(gone).toMatchObject({ ok: false, code: 'not_found' })
    })
  })
})
