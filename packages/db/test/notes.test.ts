/**
 * Notes on a company, against a real engine (0018).
 *
 * A note is a teammate's words. These tests hold the three things that make
 * it safe to keep beside evidence: the body is bounded and never blank (by
 * the module and, underneath, by CHECK), it is only ever visible inside its
 * own org, and the audit trail names who wrote and who removed it without
 * ever carrying what it said (§2.3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, like } from 'drizzle-orm'
import {
  NOTE_MAX_CHARS, notesAdd, notesAuthorLabel, notesDelete, notesFor, notesPin, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, expectRejection, type TestDb } from './helpers.js'

const SECRET_WORDS = 'the CFO said budget is 40k and the CTO is leaving in March'

describe('notes', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string
  let otherCompanyId: string
  let siblingCompanyId: string
  let contactId: string
  let author: string
  let owner: string
  let bystander: string
  let outsider: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org, other] = await db.insert(schema.orgs).values([{ name: 'Agency' }, { name: 'Elsewhere' }]).returning()
    orgId = org!.id
    otherOrgId = other!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'priya@agency.test', name: 'Priya', role: 'member' },
        { orgId, email: 'olu@agency.test', name: 'Olu', role: 'owner' },
        { orgId, email: 'sam@agency.test', name: null, role: 'member' },
        { orgId: otherOrgId, email: 'eve@elsewhere.test', name: 'Eve', role: 'owner' },
      ])
      .returning({ id: schema.users.id })
    ;[author, owner, bystander, outsider] = users.map((u) => u.id) as [string, string, string, string]
    const companies = await db
      .insert(schema.companies)
      .values([
        { orgId, domain: 'rentman.io', name: 'Rentman' },
        { orgId, domain: 'sibling.io', name: 'Sibling' },
        { orgId: otherOrgId, domain: 'rentman.io', name: 'Rentman (theirs)' },
      ])
      .returning({ id: schema.companies.id })
    ;[companyId, siblingCompanyId, otherCompanyId] = companies.map((c) => c.id) as [string, string, string]
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Ana', lastName: 'Lopes', email: 'ana@rentman.io' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const add = (body: string, over: Partial<Parameters<typeof notesAdd>[1]> = {}) =>
    notesAdd(db, { orgId, companyId, authorUserId: author, body, ...over })

  const noteCount = async (): Promise<number> => (await db.select().from(schema.notes)).length

  it('stores a note with its author and names them on the way back', async () => {
    const r = await add('  Spoke to Ana; she owns the security questionnaire.  ', { contactId })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.note.body).toBe('Spoke to Ana; she owns the security questionnaire.')
    const [n] = await notesFor(db, orgId, companyId)
    expect(n!.authorName).toBe('Priya')
    expect(n!.contactName).toBe('Ana Lopes')
    expect(notesAuthorLabel(n!)).toBe('Priya')
    expect(notesAuthorLabel({ authorName: null, authorEmail: 'sam@agency.test' })).toBe('sam@agency.test')
  })

  describe('a blank body', () => {
    it.each([[''], ['   '], ['\n\t  \n']])('is refused before the insert (%j)', async (body) => {
      const r = await add(body)
      expect(r).toEqual({ ok: false, reason: 'blank', message: expect.any(String) })
      expect(await noteCount()).toBe(0)
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'note.added'))
      expect(audits).toHaveLength(0)
    })

    it('is refused by the CHECK when something writes past the module', async () => {
      const message = await expectRejection(() =>
        test.pg.query('INSERT INTO notes (org_id, company_id, author_user_id, body) VALUES ($1, $2, $3, $4)', [
          orgId, companyId, author, '   ',
        ]),
      )
      expect(message).toMatch(/notes_body_is_not_blank/)
    })
  })

  describe('the length bound', () => {
    it(`refuses ${NOTE_MAX_CHARS + 1} characters and accepts ${NOTE_MAX_CHARS}`, async () => {
      const long = await add('x'.repeat(NOTE_MAX_CHARS + 1))
      expect(long).toEqual({ ok: false, reason: 'too_long', message: expect.stringMatching(/8,000/) })
      expect(await noteCount()).toBe(0)
      expect((await add('x'.repeat(NOTE_MAX_CHARS))).ok).toBe(true)
    })

    it('counts characters as Postgres does, not UTF-16 units', async () => {
      // 8000 emoji is 16000 by `.length` and 8000 by `length()` in SQL.
      const r = await add('🔒'.repeat(NOTE_MAX_CHARS))
      expect(r.ok).toBe(true)
      expect((await add('🔒'.repeat(NOTE_MAX_CHARS + 1))).ok).toBe(false)
    })

    it('is enforced by the CHECK underneath', async () => {
      const message = await expectRejection(() =>
        test.pg.query('INSERT INTO notes (org_id, company_id, author_user_id, body) VALUES ($1, $2, $3, $4)', [
          orgId, companyId, author, 'x'.repeat(NOTE_MAX_CHARS + 1),
        ]),
      )
      expect(message).toMatch(/notes_body_is_bounded/)
    })
  })

  it('lists pinned notes first, then newest first', async () => {
    const ids: string[] = []
    for (const [i, body] of ['first', 'second', 'third'].entries()) {
      const r = await add(body)
      if (!r.ok) throw new Error(r.message)
      ids.push(r.note.id)
      await db
        .update(schema.notes)
        .set({ createdAt: new Date(Date.UTC(2026, 8, 1 + i)) })
        .where(eq(schema.notes.id, r.note.id))
    }
    expect((await notesFor(db, orgId, companyId)).map((n) => n.body)).toEqual(['third', 'second', 'first'])

    expect((await notesPin(db, orgId, ids[0]!, true)).ok).toBe(true)
    expect((await notesFor(db, orgId, companyId)).map((n) => [n.body, n.pinned])).toEqual([
      ['first', true], ['third', false], ['second', false],
    ])

    await notesPin(db, orgId, ids[0]!, false)
    expect((await notesFor(db, orgId, companyId)).map((n) => n.body)).toEqual(['third', 'second', 'first'])
    expect((await notesFor(db, orgId, companyId, 2)).map((n) => n.body)).toEqual(['third', 'second'])
  })

  describe('org isolation', () => {
    it("refuses a note on another org's company, and writes nothing", async () => {
      const r = await add('hello', { companyId: otherCompanyId })
      expect(r).toEqual({ ok: false, reason: 'not_found', message: 'That company is not in the CRM.' })
      expect(await noteCount()).toBe(0)
    })

    it("does not show one org's notes to another, even given the company id", async () => {
      const theirs = await notesAdd(db, { orgId: otherOrgId, companyId: otherCompanyId, authorUserId: outsider, body: 'theirs' })
      expect(theirs.ok).toBe(true)
      expect(await notesFor(db, orgId, otherCompanyId)).toEqual([])
      expect(await notesFor(db, orgId, companyId)).toEqual([])
      if (!theirs.ok) return
      expect(await notesPin(db, orgId, theirs.note.id, true)).toEqual({ ok: false, reason: 'not_found', message: 'No such note.' })
      expect(await notesDelete(db, { orgId, id: theirs.note.id, byUserId: owner, isOwner: true })).toEqual({
        ok: false, reason: 'not_found', message: 'No such note.',
      })
      expect(await noteCount()).toBe(1)
    })

    it('refuses an author from another org by the same-org key', async () => {
      const r = await add('who wrote this?', { authorUserId: outsider })
      expect(r).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await noteCount()).toBe(0)
    })

    it('refuses a contact who is at a different company', async () => {
      const [elsewhere] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId: siblingCompanyId, email: 'someone@sibling.io' })
        .returning({ id: schema.contacts.id })
      const r = await add('about the wrong person', { contactId: elsewhere!.id })
      expect(r).toEqual({ ok: false, reason: 'not_found', message: 'That person is not a contact at this company.' })
      expect(await noteCount()).toBe(0)
    })
  })

  describe('deleting', () => {
    const written = async (): Promise<string> => {
      const r = await add(SECRET_WORDS)
      if (!r.ok) throw new Error(r.message)
      return r.note.id
    }

    it('lets the author delete their own note', async () => {
      const id = await written()
      expect(await notesDelete(db, { orgId, id, byUserId: author, isOwner: false })).toEqual({ ok: true })
      expect(await noteCount()).toBe(0)
    })

    it('lets an owner delete anybody’s note', async () => {
      const id = await written()
      expect(await notesDelete(db, { orgId, id, byUserId: owner, isOwner: true })).toEqual({ ok: true })
      expect(await noteCount()).toBe(0)
      const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'note.deleted'))
      expect(row!.actor).toBe(owner)
      expect(row!.detail).toEqual({ companyId, noteId: id, authorUserId: author })
    })

    it('refuses a member who neither wrote it nor owns the org, and keeps the note', async () => {
      const id = await written()
      const r = await notesDelete(db, { orgId, id, byUserId: bystander, isOwner: false })
      expect(r).toEqual({ ok: false, reason: 'not_permitted', message: expect.stringMatching(/wrote a note, or an owner/) })
      expect(await noteCount()).toBe(1)
      expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'note.deleted'))).toHaveLength(0)
    })
  })

  it('never puts the body in the audit log', async () => {
    const r = await add(SECRET_WORDS, { contactId })
    if (!r.ok) throw new Error(r.message)
    await notesPin(db, orgId, r.note.id, true)
    await notesDelete(db, { orgId, id: r.note.id, byUserId: author, isOwner: false })

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), like(schema.auditLog.action, 'note.%')))
    expect(rows.map((a) => a.action).sort()).toEqual(['note.added', 'note.deleted'])
    const added = rows.find((a) => a.action === 'note.added')!
    expect(added.detail).toEqual({ companyId, noteId: r.note.id, contactId })
    for (const row of rows) {
      const text = JSON.stringify(row)
      expect(text).not.toContain('CFO')
      expect(text).not.toContain('40k')
      for (const value of Object.values(row.detail as Record<string, unknown>)) {
        expect(typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value), String(value)).toBe(true)
      }
    }
  })
})
