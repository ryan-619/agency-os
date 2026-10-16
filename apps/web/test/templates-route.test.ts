/**
 * `POST /api/templates` and `POST /api/templates/import`, through their own
 * calls (`templateCreateAnswer`, `templateImportAnswer`), against a real
 * database and against one that fails (review round 9, finding [14]).
 *
 * A template carrying U+0000 — a pasted body, a corrupted export — reached
 * the INSERT, which Postgres refuses, and the fault escaped both routes
 * whole: a 500, drizzle's message with every bound parameter in the
 * platform log, and an import's per-line report lost for every line before
 * the bad one. `checkTemplate` now refuses the NUL with a sentence, and the
 * routes catch whatever the database still throws.
 *
 * The routes themselves import `@/auth` and are pinned by reading their
 * source.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schema, templatesList, type AgencyDb } from '@agency/db/queries'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import {
  TEMPLATE_CREATE_FAULT, TEMPLATE_IMPORT_FAULT, templateCreateAnswer, templateImportAnswer, type TemplatesLog,
} from '../src/app/api/templates/outcome'
import type { TemplateCreateInput } from '../src/app/api/templates/rules'

const GREETING: TemplateCreateInput = {
  channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit',
  body: 'Hi {#var#}, your review is ready. Reply STOP to opt out.',
}

const NUL_SENTENCE =
  'has a NUL character (U+0000) in it. No registered template carries one, the database cannot store one, and ' +
  'replacing it would record words that were never registered — copy it again from the portal it was registered ' +
  'on. Nothing was recorded.'

class DrizzleQueryError extends Error {
  override name = 'DrizzleQueryError'
}

describe('the templates routes’ own calls', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let lines: { message: string; fields: Record<string, unknown> }[]
  const log: TemplatesLog = { error: (message, fields = {}) => lines.push({ message, fields }) }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    lines = []
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A database that throws drizzle's error — every bound parameter quoted — on the `n`th INSERT. */
  const failingOn = (n: number, decoy: string): AgencyDb => {
    let inserts = 0
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (...a: unknown[]) => {
            inserts += 1
            if (inserts === n) {
              throw new DrizzleQueryError(`Failed query: insert into "message_templates" … params: ${orgId},sms,${decoy}`)
            }
            return (Reflect.get(target, prop, receiver) as (...b: unknown[]) => unknown).apply(target, a)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  describe('POST /api/templates', () => {
    it('records a template, 201', async () => {
      const answer = await templateCreateAnswer(db, { orgId, input: GREETING, createdBy: userId }, log)
      expect(answer.status).toBe(201)
      expect(answer.body.template).toMatchObject({ externalId: '1107160000000012345', senderId: 'ACMEIN', active: true })
      expect(lines).toEqual([])
    })

    it.each([
      ['body', { body: 'Hello {#var#}\u0000 from Acme' }, 'bad_body', 'The template text'],
      ['externalId', { externalId: '1107160000000012345\u0000' }, 'bad_external_id', 'The DLT template id'],
      ['name', { name: 'Greeting\u0000' }, 'bad_name', 'The name'],
      ['language', { language: 'en\u0000' }, 'bad_language', 'The language'],
    ] as const)('answers a U+0000 in the %s 400 with a sentence, and records nothing', async (_field, over, reason, label) => {
      const answer = await templateCreateAnswer(db, { orgId, input: { ...GREETING, ...over }, createdBy: userId }, log)
      expect(answer).toEqual({ status: 400, body: { error: `${label} ${NUL_SENTENCE}`, reason } })
      expect(lines).toEqual([])
      expect(await templatesList(db, orgId)).toHaveLength(0)
    })

    it('answers a duplicate id 409', async () => {
      await templateCreateAnswer(db, { orgId, input: GREETING, createdBy: userId }, log)
      const again = await templateCreateAnswer(db, { orgId, input: { ...GREETING, body: 'Other' }, createdBy: userId }, log)
      expect(again).toMatchObject({ status: 409, body: { reason: 'duplicate' } })
    })

    /** drizzle's message quotes every bound parameter; Next would log an escaping error whole. */
    it('answers a database fault 500 with a sentence, and logs its class only', async () => {
      const broken = failingOn(1, 'Hi Priya-DECOY')
      const answer = await templateCreateAnswer(broken, { orgId, input: GREETING, createdBy: userId }, log)
      expect(answer).toEqual({ status: 500, body: { error: TEMPLATE_CREATE_FAULT } })
      expect(lines).toEqual([{ message: 'template could not be recorded', fields: { error: 'DrizzleQueryError' } }])
      const all = JSON.stringify({ answer, lines })
      expect(all).not.toContain('DECOY')
      expect(all).not.toContain('Failed query')
      expect(await templatesList(db, orgId)).toHaveLength(0)
    })
  })

  describe('POST /api/templates/import', () => {
    const EXPORT = [
      'Template ID,Header,Template Type,Template Content,Status',
      '1107160000000012345,ACMEIN,Service Explicit,"Hi {#var#}, your call is at {#var#}.",Approved',
      '1107160000000012346,ACMEIN,Service Implicit,"Hi {#var#}\u0000 there",Approved',
      '1107160000000012347,ACMEIN,Service Implicit,Goodbye {#var#},Approved',
    ].join('\r\n')

    it('reports the line with a U+0000 as refused, and every other line, 200', async () => {
      const answer = await templateImportAnswer(db, { orgId, text: EXPORT, createdBy: userId }, log)
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ imported: 2, alreadyPresent: 0, skipped: 0, refused: 1 })
      expect(answer.body.lines).toEqual([
        { line: 2, externalId: '1107160000000012345', outcome: 'imported' },
        { line: 3, externalId: '1107160000000012346', outcome: 'refused', why: `The template text ${NUL_SENTENCE}` },
        { line: 4, externalId: '1107160000000012347', outcome: 'imported' },
      ])
      expect(lines).toEqual([])
    })

    it('answers a file it cannot read as one 400 with its sentence', async () => {
      const answer = await templateImportAnswer(db, { orgId, text: 'Header,Category,Content\nACMEIN,promotional,Hi\n', createdBy: userId }, log)
      expect(answer.status).toBe(400)
      expect(String(answer.body.error)).toContain('template id')
    })

    it('answers a fault part-way 500, says a re-import is safe, and logs its class only', async () => {
      // The second INSERT is the second template line's: the first is already recorded.
      const broken = failingOn(2, 'Goodbye-DECOY')
      const answer = await templateImportAnswer(broken, { orgId, text: EXPORT, createdBy: userId }, log)
      expect(answer).toEqual({ status: 500, body: { error: TEMPLATE_IMPORT_FAULT } })
      expect(lines).toEqual([{ message: 'template import could not be completed', fields: { error: 'DrizzleQueryError' } }])
      expect(JSON.stringify({ answer, lines })).not.toContain('DECOY')
      expect((await templatesList(db, orgId)).map((t) => t.externalId)).toEqual(['1107160000000012345'])

      // What the sentence promises: the same file again records the rest and repeats nothing.
      const again = await templateImportAnswer(db, { orgId, text: EXPORT, createdBy: userId }, log)
      expect(again.body).toMatchObject({ imported: 1, alreadyPresent: 1, refused: 1 })
      expect(await templatesList(db, orgId)).toHaveLength(2)
    })
  })
})

describe('each route is the session, the body, and one call', () => {
  const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  /** The source without comments, so a sentence ABOUT a call does not count as one. */
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('POST /api/templates hands the parsed body to templateCreateAnswer, with the logger', () => {
    const src = code(read('../src/app/api/templates/route.ts'))
    const post = src.slice(src.indexOf('export async function POST('))
    expect(post).toMatch(/templateCreateAnswer\(\s*getDb\(\) as unknown as AgencyDb,\s*\{ orgId: user\.orgId, input: parsed\.data, createdBy: user\.id \},\s*log,?\s*\)/)
    expect(post).toContain('NextResponse.json(answer.body, { status: answer.status })')
    // No second, uncaught call to escape the route.
    expect(src).not.toMatch(/templatesCreate\(/)
  })

  it('POST /api/templates/import hands the decoded text to templateImportAnswer, with the logger', () => {
    const src = code(read('../src/app/api/templates/import/route.ts'))
    expect(src).toMatch(/templateImportAnswer\(getDb\(\) as unknown as AgencyDb, \{ orgId: user\.orgId, text, createdBy: user\.id \}, log\)/)
    expect(src).toContain('NextResponse.json(answer.body, { status: answer.status })')
    expect(src).not.toMatch(/templatesImportDltCsv\(/)
    // Still decoded strictly and bounded before the call.
    expect(src.indexOf('decodeUtf8(bytes)')).toBeLessThan(src.indexOf('templateImportAnswer('))
  })
})
