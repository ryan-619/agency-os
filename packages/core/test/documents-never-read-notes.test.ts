/**
 * §2.2: the app must never state a finding it did not observe — and a note
 * is the shortest path to breaking that. "They have no CSP" typed after a
 * call is a teammate's words; the moment a proposal or a brief quotes it,
 * the document states it as something the agency found.
 *
 * So the two documents the pipeline writes, and the two modules that gather
 * their facts from the database, may not read the notes table at all. This
 * reads their SOURCE, because a behavioural test could only prove that one
 * particular note did not come through.
 *
 * The predicates are deliberately narrower than "the word notes". `meetings`
 * has a `notes` column of its own — what was typed when the meeting was
 * booked — and `meetings.ts` legitimately writes it. What is banned is the
 * notes MODULE and the notes TABLE: importing one, naming the other, calling
 * any `notes…()` function, or declaring the table again under another name.
 *
 * And the test proves it can fail: the same predicates run over the notes
 * module itself, and over a fabricated leak, must both be caught. A source
 * test that could never report a violation is the same defect as a gate
 * that could never report success.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** The two documents, and the two modules that feed them from the database. */
const DOCUMENT_SOURCES = [
  'packages/core/src/proposal.ts',
  'packages/core/src/brief.ts',
  'packages/db/src/proposals.ts',
  'packages/db/src/meetings.ts',
] as const

const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** Every way a module could reach the notes table, and the name of each. */
const PREDICATES: readonly (readonly [string, RegExp])[] = [
  ['imports the notes module', /from\s+['"]\.\.?\/(?:[\w-]+\/)*notes(?:\.js)?['"]/],
  ['names the notes table on the schema', /\bschema\s*\.\s*notes\b/],
  ['calls a notes query', /\bnotes[A-Z]\w*\s*\(/],
  ['declares a notes table', /pgTable\s*\(\s*['"]notes['"]/],
  ['queries the notes table in SQL', /\b(?:FROM|JOIN)\s+"?notes"?\b/i],
]

function violations(src: string): string[] {
  const code = withoutComments(src)
  return PREDICATES.filter(([, re]) => re.test(code)).map(([name]) => name)
}

const read = (rel: string): string => readFileSync(`${REPO}${rel}`, 'utf8')

describe('the proposal and the brief never read notes (§2.2)', () => {
  it.each(DOCUMENT_SOURCES)('%s exists and has something in it to check', (rel) => {
    expect(existsSync(`${REPO}${rel}`), rel).toBe(true)
    expect(read(rel).length, rel).toBeGreaterThan(500)
  })

  it.each(DOCUMENT_SOURCES)('%s does not reach the notes table', (rel) => {
    expect(violations(read(rel)), rel).toEqual([])
  })

  it("still lets meetings.ts write the MEETING's own notes column", () => {
    // The reason the predicates are narrow. If this stops being true the
    // exemption can go — but the test above must not start failing on it.
    expect(read('packages/db/src/meetings.ts')).toMatch(/\bnotes:/)
  })
})

describe('the predicates can fail', () => {
  it('catch the notes module itself', () => {
    const found = violations(read('packages/db/src/notes.ts'))
    expect(found).toContain('names the notes table on the schema')
    expect(found).toContain('calls a notes query')
  })

  it.each([
    ["import { notesFor } from './notes.js'", 'imports the notes module'],
    ['import { notesFor } from "./notes"', 'imports the notes module'],
    ['const rows = await db.select().from(schema.notes)', 'names the notes table on the schema'],
    ['const said = await notesFor(db, orgId, companyId)', 'calls a notes query'],
    ["const shadow = pgTable('notes', {})", 'declares a notes table'],
    ['await db.execute(sql`SELECT body FROM notes WHERE company_id = ${id}`)', 'queries the notes table in SQL'],
  ])('%s', (leak, name) => {
    expect(violations(`export const x = 1\n${leak}\n`)).toContain(name)
  })

  it('ignore a mention in a comment, and the meeting column', () => {
    expect(violations('// never call notesFor( here, and never read schema.notes\nconst m = input.notes?.trim()')).toEqual([])
    expect(violations('/* SELECT body FROM notes */ const notes = row.notes')).toEqual([])
  })
})
