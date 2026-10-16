/**
 * The delete routes (2026-10-15), through their own calls
 * (`lib/delete-answer.ts`) against a real database and against one that
 * fails, and each route pinned by reading its source — the routes import
 * `@/auth` and cannot be imported here (CLAUDE.md, "a module a test imports
 * carries no `server-only` and no `@/` import").
 *
 * What is held:
 *
 *  - a delete that happened is 200 with what went; a refusal is 409 with the
 *    writer's code and sentence, and nothing is written; a record that is
 *    not there — another org's included — is 404, worded the same whoever
 *    asks;
 *  - a company is deleted only with its domain (a no-website business's
 *    name) typed back, and a wrong word is a 400 with nothing written;
 *  - a bulk delete runs each row in its own transaction, so one person kept
 *    keeps only themselves, and a fault on one row is that row's answer;
 *  - a database fault is a 500 with a sentence and ONE log line naming the
 *    fault's class — never drizzle's message, which lists every bound
 *    parameter;
 *  - each route asks the capability the spec gives it before anything is
 *    read: an owner's for a company and a profile, `contacts:write` for a
 *    person, `deals:write` for a deal, meeting, proposal, quote or task,
 *    `campaigns:write` for a campaign or a template.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noSiteDomain } from '@agency/core'
import { companyDelete, contactDelete, dealDelete, schema, type AgencyDb } from '@agency/db/queries'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import {
  DELETE_MAX_REQUEST_BYTES, bulkDeleteAnswer, companyDeleteAnswer, deleteAnswer, deleteFaultSentence, parseBulkDelete,
  readDeleteBody, type DeleteLog,
} from '../src/lib/delete-answer'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
/** The source without comments, so a sentence ABOUT a call does not count as one. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const NOON = new Date('2026-09-15T12:00:00.000Z')
const NOWHERE = '00000000-0000-4000-8000-000000000000'

class DrizzleQueryError extends Error {
  override name = 'DrizzleQueryError'
}

describe('the delete routes’ own calls', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let ownerId: string
  let companyId: string
  let campaignId: string
  let lines: { message: string; fields: Record<string, unknown> }[]
  const log: DeleteLog = { error: (message, fields = {}) => lines.push({ message, fields }) }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    lines = []
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning())[0]!.id
    otherOrgId = (await db.insert(schema.orgs).values({ name: 'Somebody Else' }).returning())[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'owner@accemy.test', role: 'owner' }).returning())[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'carbonmaps.io', name: 'Carbon Maps', source: 'agent' }).returning())[0]!.id
    campaignId = (await db.insert(schema.campaigns).values({ orgId, name: 'Q4', channel: 'email', status: 'active' }).returning())[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const contact = async (values: Partial<typeof schema.contacts.$inferInsert> = {}, org = orgId, company = companyId) =>
    (await db.insert(schema.contacts).values({ orgId: org, companyId: company, firstName: 'Alex', email: 'security@carbonmaps.io', ...values }).returning())[0]!.id
  const sentTo = (contactId: string) =>
    db.insert(schema.touches).values({
      orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent', sentAt: NOON,
    })
  const exists = async (table: typeof schema.contacts | typeof schema.companies, id: string) =>
    (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1
  const audits = (action: string) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))

  /** A database that throws drizzle's error — every bound parameter quoted — on its first read. */
  const failing = (decoy: string): AgencyDb =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' || prop === 'transaction') {
          return () => {
            throw new DrizzleQueryError(`Failed query: select … params: ${orgId},${decoy}`)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

  describe('deleteAnswer — one record', () => {
    it('answers 200 with what went, for a person nothing went to', async () => {
      const alex = await contact()
      const a = await deleteAnswer('contact', () => contactDelete(db, { orgId, contactId: alex, actor: ownerId }), log)
      expect(a).toEqual({
        status: 200,
        body: { deleted: true, companyId, draftsRemoved: 0, consentsRemoved: 0, notesRemoved: 0 },
      })
      expect(await exists(schema.contacts, alex)).toBe(false)
      expect(await audits('contact.deleted')).toHaveLength(1)
      expect(lines).toEqual([])
    })

    it('answers 409 with the writer’s code and sentence, and writes nothing, for a person something went to', async () => {
      const alex = await contact()
      await sentTo(alex)
      const a = await deleteAnswer('contact', () => contactDelete(db, { orgId, contactId: alex, actor: ownerId }), log)
      expect(a.status).toBe(409)
      expect(a.body.error).toBe('must_erase')
      expect(a.body.message).toContain('An owner can erase them on /contacts')
      expect(String(a.body.message)).not.toContain('carbonmaps.io')
      expect(await exists(schema.contacts, alex)).toBe(true)
      expect(await audits('contact.deleted')).toHaveLength(0)
    })

    /**
     * `DELETE /api/contacts/<ID IN CAPITALS>` passed the route's `/i` id check
     * and reached the writer as typed, which looked the person's keep reason
     * up by that spelling and found none: a refusal, an unrecorded opt-out
     * and a call were each deleted, 200 (review, 2026-10-15). The route
     * lower-cases the id now, and so does the writer; this is the route's
     * own call, made as the route made it before.
     */
    it('answers an id in capitals exactly as the stored one: 409 for a refusal, an unrecorded opt-out and a call', async () => {
      const said = await contact({ firstName: 'Said', email: 'said@carbonmaps.io' })
      await db.insert(schema.consents).values({ orgId, contactId: said, channel: 'email', granted: false, source: 'said no on the phone' })
      const held = await contact({
        firstName: 'Held', email: 'held@carbonmaps.io', pausedAt: NOON,
        pausedReason: `opt-out not recorded: reply ${NOON.toISOString()} (suppression_failed)`,
      })
      await db.insert(schema.auditLog).values({
        orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: held,
        detail: { channel: 'email', why: 'suppression_failed' },
      })
      const called = await contact({ firstName: 'Called', email: 'called@carbonmaps.io' })
      await db.insert(schema.calls).values({ orgId, contactId: called, direction: 'in' })
      for (const id of [said, held, called]) {
        const a = await deleteAnswer('contact', () => contactDelete(db, { orgId, contactId: id.toUpperCase(), actor: ownerId }), log)
        expect(a.status, id).toBe(409)
        expect(a.body.error, id).toBe('must_erase')
        expect(await exists(schema.contacts, id)).toBe(true)
      }
      expect((await db.select().from(schema.consents).where(eq(schema.consents.contactId, said))).length).toBe(1)
      expect(await audits('contact.deleted')).toHaveLength(0)
    })

    it('answers 404 for another org’s record, worded as one that is simply not there', async () => {
      const theirs = await contact({}, otherOrgId, (await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.io' }).returning())[0]!.id)
      const a = await deleteAnswer('contact', () => contactDelete(db, { orgId, contactId: theirs, actor: ownerId }), log)
      const gone = await deleteAnswer('contact', () => contactDelete(db, { orgId, contactId: NOWHERE, actor: ownerId }), log)
      expect(a).toEqual({ status: 404, body: { error: 'not_found', message: 'No such contact — it may already have been deleted.' } })
      expect(gone).toEqual(a)
      expect(await exists(schema.contacts, theirs)).toBe(true)
    })

    it('answers a won deal 409, naming the act that applies', async () => {
      const deal = (await db.insert(schema.deals).values({ orgId, companyId, stage: 'won', closedAt: NOON }).returning())[0]!.id
      const a = await deleteAnswer('deal', () => dealDelete(db, { orgId, dealId: deal, actor: ownerId }), log)
      expect(a).toEqual({
        status: 409,
        body: { error: 'deal_won', message: 'This deal is marked won, so it stays. Move it off Won first if that was a mistake.' },
      })
    })

    it('answers a fault 500 with a sentence, and logs the fault’s class — never its message', async () => {
      const a = await deleteAnswer(
        'contact',
        async () => {
          throw new DrizzleQueryError(`Failed query: delete from "contacts" … params: ${orgId},security@carbonmaps.io`)
        },
        log,
      )
      expect(a).toEqual({ status: 500, body: { error: 'database_fault', message: deleteFaultSentence('contact') } })
      expect(deleteFaultSentence('contact')).toContain('Nothing was deleted')
      expect(lines).toEqual([{ message: 'contact could not be deleted', fields: { error: 'DrizzleQueryError' } }])
      expect(JSON.stringify(lines)).not.toContain('carbonmaps')
    })
  })

  describe('companyDeleteAnswer — the domain typed back', () => {
    it('refuses a word that is not the domain with 400, and deletes nothing', async () => {
      for (const confirm of ['carbonmaps', 'Carbon Maps', '', undefined, 42]) {
        const a = await companyDeleteAnswer(db, { orgId, companyId, confirm, actor: ownerId }, log)
        expect(a, String(confirm)).toEqual({
          status: 400,
          body: { error: 'confirm', message: 'Type carbonmaps.io exactly to confirm. Nothing was deleted.' },
        })
      }
      expect(await exists(schema.companies, companyId)).toBe(true)
      expect(await audits('company.deleted')).toHaveLength(0)
    })

    it('deletes it with the domain typed in any case, and answers what went', async () => {
      await contact()
      const a = await companyDeleteAnswer(db, { orgId, companyId, confirm: ' CarbonMaps.IO ', actor: ownerId }, log)
      expect(a).toEqual({
        status: 200,
        body: { deleted: true, contacts: 1, drafts: 0, deals: 0, meetings: 0, quotes: 0, proposals: 0, scans: 0 },
      })
      expect(await exists(schema.companies, companyId)).toBe(false)
      const [row] = await audits('company.deleted')
      expect(row).toMatchObject({ actor: ownerId, subjectType: 'company', subjectId: companyId })
    })

    it('takes a no-website business’s name in place of its placeholder', async () => {
      const cafe = (
        await db.insert(schema.companies).values({ orgId, domain: noSiteDomain('Yummy Bites', 'ChIJyummy'), name: 'Yummy Bites' }).returning()
      )[0]!.id
      const wrong = await companyDeleteAnswer(db, { orgId, companyId: cafe, confirm: 'yummy-bites', actor: ownerId }, log)
      expect(wrong.body.message).toBe('Type Yummy Bites exactly to confirm. Nothing was deleted.')
      const right = await companyDeleteAnswer(db, { orgId, companyId: cafe, confirm: 'yummy bites', actor: ownerId }, log)
      expect(right.status).toBe(200)
    })

    it('answers another org’s company 404 whatever was typed — nothing says it exists', async () => {
      const theirs = (await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.io' }).returning())[0]!.id
      for (const confirm of ['theirs.io', 'something else']) {
        const a = await companyDeleteAnswer(db, { orgId, companyId: theirs, confirm, actor: ownerId }, log)
        expect(a).toEqual({ status: 404, body: { error: 'not_found', message: 'No such company — it may already have been deleted.' } })
      }
      expect(await exists(schema.companies, theirs)).toBe(true)
    })

    it('answers a company something went to 409, with the writer’s sentence', async () => {
      await sentTo(await contact())
      const a = await companyDeleteAnswer(db, { orgId, companyId, confirm: 'carbonmaps.io', actor: ownerId }, log)
      expect(a.status).toBe(409)
      expect(a.body.error).toBe('has_history')
      expect(a.body.message).toContain('Close its deal as lost')
      expect(await exists(schema.companies, companyId)).toBe(true)
    })

    it('answers a fault in its own read 500, by class', async () => {
      const a = await companyDeleteAnswer(failing('carbonmaps.io'), { orgId, companyId, confirm: 'carbonmaps.io', actor: ownerId }, log)
      expect(a).toEqual({ status: 500, body: { error: 'database_fault', message: deleteFaultSentence('company') } })
      expect(lines).toEqual([{ message: 'company could not be deleted', fields: { error: 'DrizzleQueryError' } }])
    })
  })

  describe('bulkDeleteAnswer — each row on its own', () => {
    it('deletes the people it may and keeps the rest, each with its own answer', async () => {
      const invented = await contact({ firstName: 'Alex', lastName: 'Chen' })
      const written = await contact({ firstName: 'Bala', email: 'bala@carbonmaps.io' })
      await sentTo(written)
      const theirs = await contact({}, otherOrgId, (await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.io' }).returning())[0]!.id)
      const a = await bulkDeleteAnswer(
        'contact',
        [invented, written, theirs],
        (contactId) => contactDelete(db, { orgId, contactId, actor: ownerId }),
        log,
      )
      expect(a.status).toBe(200)
      const results = a.body.results as Array<Record<string, unknown>>
      expect(results.map((r) => [r.id, r.ok, r.code ?? null])).toEqual([
        [invented, true, null],
        [written, false, 'must_erase'],
        [theirs, false, 'not_found'],
      ])
      expect(results[1]!.message).toContain('An owner can erase them on /contacts')
      expect(await exists(schema.contacts, invented)).toBe(false)
      expect(await exists(schema.contacts, written)).toBe(true)
      expect(await exists(schema.contacts, theirs)).toBe(true)
      expect(await audits('contact.deleted')).toHaveLength(1)
    })

    it('runs the companies through their writer one by one, a kept one keeping only itself', async () => {
      const fine = (await db.insert(schema.companies).values({ orgId, domain: 'yummybites-delhi.business.site', source: 'agent' }).returning())[0]!.id
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'won', closedAt: NOON })
      const a = await bulkDeleteAnswer('company', [companyId, fine], (id) => companyDelete(db, { orgId, companyId: id, actor: ownerId }), log)
      expect((a.body.results as Array<Record<string, unknown>>).map((r) => [r.ok, r.code ?? null])).toEqual([
        [false, 'deal_won'],
        [true, null],
      ])
      expect(await exists(schema.companies, companyId)).toBe(true)
      expect(await exists(schema.companies, fine)).toBe(false)
    })

    it('answers a fault on one row as that row’s, asks the rest, and logs once by class', async () => {
      const first = await contact({ firstName: 'One', email: 'one@carbonmaps.io' })
      const third = await contact({ firstName: 'Three', email: 'three@carbonmaps.io' })
      let n = 0
      const a = await bulkDeleteAnswer(
        'contact',
        [first, NOWHERE, third],
        async (contactId) => {
          n += 1
          if (n === 2) throw new DrizzleQueryError(`Failed query … params: ${orgId},three@carbonmaps.io`)
          return contactDelete(db, { orgId, contactId, actor: ownerId })
        },
        log,
      )
      expect(a.body.results).toEqual([
        { id: first, ok: true },
        { id: NOWHERE, ok: false, code: 'database_fault', message: deleteFaultSentence('contact') },
        { id: third, ok: true },
      ])
      expect(lines).toEqual([{ message: 'contact delete faulted', fields: { error: 'DrizzleQueryError', faults: 1, of: 3 } }])
      expect(JSON.stringify(lines)).not.toContain('carbonmaps')
    })
  })
})

describe('reading a delete request', () => {
  const A = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'
  const B = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0002'

  it('reads an empty body as no fields, and refuses JSON that is not an object', () => {
    expect(readDeleteBody('')).toEqual({ ok: true, body: {} })
    expect(readDeleteBody('{"confirm":"rentman.io"}')).toEqual({ ok: true, body: { confirm: 'rentman.io' } })
    for (const raw of ['[1,2]', 'null', '"x"', '{nope']) {
      const r = readDeleteBody(raw)
      expect(r.ok, raw).toBe(false)
      if (!r.ok) expect(r.answer.status).toBe(400)
    }
  })

  it('refuses a body larger than a delete could need with 413', () => {
    const r = readDeleteBody(`{"ids":["${'a'.repeat(DELETE_MAX_REQUEST_BYTES)}"]}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.answer.status).toBe(413)
  })

  it('takes one to the limit of whole uuids, once each, in the order given', () => {
    const opts = { max: 3, confirmCount: false, noun: 'person' }
    expect(parseBulkDelete({ ids: [A, B.toUpperCase(), A] }, opts)).toEqual({ ok: true, ids: [A, B] })
    const refused = (body: Record<string, unknown>, max = 3) => {
      const r = parseBulkDelete(body, { ...opts, max })
      return r.ok ? null : r.answer
    }
    expect(refused({})).toEqual({ status: 400, body: { error: 'no_ids', message: 'Choose at least one person to delete. Nothing was deleted.' } })
    expect(refused({ ids: [] })?.body.error).toBe('no_ids')
    expect(refused({ ids: [A, '------------------------------------'] })?.body.error).toBe('bad_id')
    expect(refused({ ids: [A, 7] })?.body.error).toBe('bad_id')
    expect(refused({ ids: [A, B] }, 1)).toEqual({
      status: 400,
      body: { error: 'too_many', message: 'At most 1 at a time — 2 were chosen. Nothing was deleted.' },
    })
  })

  it('takes a companies bulk delete only with the number chosen typed back', () => {
    const opts = { max: 50, confirmCount: true, noun: 'company' }
    expect(parseBulkDelete({ ids: [A, B], confirm: '2' }, opts)).toEqual({ ok: true, ids: [A, B] })
    for (const confirm of [undefined, '', '3', 'two', 2]) {
      const r = parseBulkDelete({ ids: [A, B], confirm }, opts)
      expect(r.ok, String(confirm)).toBe(false)
      if (!r.ok) expect(r.answer.body).toEqual({ error: 'confirm', message: 'Type 2, the number chosen, to confirm. Nothing was deleted.' })
    }
  })
})

describe('each delete route asks its capability, checks the id, and goes through its writer', () => {
  /** The DELETE (or the bulk POST) handler of a route, comments out. */
  const handler = (file: string, verb: 'DELETE' | 'POST'): string => {
    const src = code(read(`../src/app/${file}`))
    const start = src.indexOf(`export async function ${verb}(`)
    expect(start, `${file} exports ${verb}`).toBeGreaterThan(-1)
    const end = src.indexOf('\nexport ', start + 1)
    return src.slice(start, end === -1 ? undefined : end)
  }
  const before = (body: string, a: string, b: string): void => {
    expect(body.indexOf(a), a).toBeGreaterThan(-1)
    expect(body.indexOf(b), b).toBeGreaterThan(-1)
    expect(body.indexOf(a), `${a} before ${b}`).toBeLessThan(body.indexOf(b))
  }

  it.each([
    ['api/contacts/[id]/route.ts', "'contacts:write'", 'contactDelete(', "deleteAnswer(\n    'contact'"],
    ['api/deals/[id]/route.ts', "'deals:write'", 'dealDelete(', "deleteAnswer(\n    'deal'"],
    ['api/meetings/[id]/route.ts', "'deals:write'", 'meetingDelete(', "deleteAnswer(\n    'meeting'"],
    ['api/proposals/[id]/route.ts', "'deals:write'", 'proposalDelete(', "deleteAnswer(\n    'proposal'"],
    ['api/tasks/[id]/route.ts', "'deals:write'", 'taskDelete(', "deleteAnswer(\n    'task'"],
    ['api/quotes/[id]/route.ts', "principalFor('deals:write')", 'quoteDelete(', "deleteAnswer(\n    'quote'"],
    ['api/campaigns/[id]/route.ts', "'campaigns:write'", 'campaignDelete(', "deleteAnswer(\n    'campaign'"],
    ['api/templates/[id]/route.ts', 'mayWriteTemplates(', 'templateDelete(', "deleteAnswer(\n    'template'"],
    ['api/settings/icp/[id]/route.ts', "'agents:write'", 'icpProfileDelete(', "deleteAnswer(\n    'icp'"],
  ])('%s', (file, capability, writer, answer) => {
    const body = handler(file, 'DELETE')
    before(body, capability, 'UUID.test(id)')
    before(body, 'UUID.test(id)', writer)
    expect(body).toContain(answer)
    expect(body).toContain('actor: ')
    expect(body).toMatch(/NextResponse\.json\(a\.body, \{ status: a\.status \}\)/)
    // The id as the database prints it, lower-cased, whatever the URL spelt (review, 2026-10-15).
    expect(body).toMatch(/Id: id\.toLowerCase\(\)/)
    expect(body).not.toMatch(/Id: id[,\s}]/)
  })

  it('keeps deleting a company an owner’s, with the domain typed back', () => {
    const body = handler('api/companies/[id]/route.ts', 'DELETE')
    before(body, "'users:write'", 'UUID.test(id)')
    before(body, 'UUID.test(id)', 'companyDeleteAnswer(')
    expect(body).toContain('confirm: read.body.confirm')
    expect(body).toContain('companyId: id.toLowerCase()')
  })

  it('keeps the companies’ bulk delete an owner’s, with the count typed back', () => {
    const body = handler('api/companies/delete/route.ts', 'POST')
    before(body, "'users:write'", 'parseBulkDelete(')
    expect(body).toContain('confirmCount: true')
    expect(body).toContain('companyDelete(db, { orgId: user.orgId, companyId, actor: user.id })')
  })

  it('lets anybody who may change contacts delete several people, each through the contact writer', () => {
    const body = handler('api/contacts/delete/route.ts', 'POST')
    before(body, "'contacts:write'", 'parseBulkDelete(')
    expect(body).toContain('confirmCount: false')
    expect(body).toContain('contactDelete(db, { orgId: user.orgId, contactId, actor: user.id })')
  })
})
