/**
 * Review fixes to pages and routes that cannot be imported here — each
 * imports `@/auth`, and a module a test in this directory imports carries no
 * `server-only` and no `@/` import (CLAUDE.md §4). So the shapes are read off
 * the source, and where a rule has a pure half (`readIcp`, the id pattern)
 * that half is run.
 *
 * Each block is a way one of these pages or routes answered 500 — or could
 * be moved to the wrong runtime — without anything looking broken:
 *
 *   * twenty-eight pages exported `dynamic` and not `runtime` — eleven the
 *     0018 release added, then seventeen older ones a list of the eleven
 *     never saw — so a segment layout that ever set `runtime = 'edge'` would
 *     move pages that use `pg` and `node:` modules onto it silently;
 *   * `/contacts?q=a&q=b` reached `.trim()` with an ARRAY — Next hands a
 *     repeated key over as `string[]`, whatever the page's type says;
 *   * `/contacts/import` parsed the ICP bare, for a sidebar label;
 *   * `/compliance`, the print view and the Markdown export handed the ICP's
 *     `stale_after_days` to `isStale` unchecked, which throws on 0;
 *   * the notes, tasks, meetings and LinkedIn-step routes checked ids with
 *     `/^[0-9a-f-]{36}$/`, which lets 36 dashes through to Postgres as a
 *     22P02 and a 500 instead of the house 404.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isStale } from '@agency/core'
import { readIcp } from '../src/lib/company-list'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** Comments out, so prose about a pattern is not the pattern. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const APP = '../src/app/'

/**
 * Every `page.tsx` under `src/app`, found by walking the tree rather than
 * kept as a list. A list is how this went wrong twice: the 0018 release
 * fixed the eleven pages it had added and left seventeen older ones
 * exporting `dynamic` with no `runtime`, and a page added next year would
 * be on no list at all.
 */
function pagesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...pagesUnder(join(dir, entry.name), `${prefix}${entry.name}/`))
    else if (entry.name === 'page.tsx') out.push(`${prefix}page.tsx`)
  }
  return out.sort()
}

describe('every page that exports dynamic runs on the Node runtime, said out loud', () => {
  const PAGES = pagesUnder(fileURLToPath(new URL(APP, import.meta.url)))
  const DYNAMIC = PAGES.filter((p) => /^export const dynamic = /m.test(read(`${APP}${p}`)))

  it('finds the pages by walking the tree, so the check cannot pass on an empty list', () => {
    // The dashboard, a page with a dynamic segment, a nested settings page,
    // and the seventeen that once exported `dynamic` alone.
    for (const p of [
      'page.tsx', 'companies/[domain]/page.tsx', 'settings/agents/page.tsx', 'signin/check-email/page.tsx',
      'approvals/page.tsx', 'book/[slug]/page.tsx', 'suppressions/page.tsx',
    ]) {
      expect(DYNAMIC).toContain(p)
    }
    expect(DYNAMIC.length).toBeGreaterThanOrEqual(36)
  })

  it.each(DYNAMIC)('%s exports dynamic and runtime', (page) => {
    const src = read(`${APP}${page}`)
    expect(src).toMatch(/^export const dynamic = 'force-dynamic'$/m)
    expect(src).toMatch(/^export const runtime = 'nodejs'$/m)
  })
})

describe('/contacts reads a repeated query key as its first value', () => {
  const src = code(read(`${APP}contacts/page.tsx`))

  it('types searchParams as Next actually delivers them', () => {
    expect(src).toMatch(/type Params = Record<string, string \| string\[\] \| undefined>/)
    expect(src).toMatch(/searchParams: Promise<Params>/)
  })

  it('reads every key through one(), never as a bare property', () => {
    expect(src).not.toMatch(/params\.(q|paused|company|page)\b/)
    for (const key of ['q', 'paused', 'company', 'page']) expect(src).toContain(`one(params['${key}'])`)
    expect(src).toMatch(/const one = \(v: string \| string\[\] \| undefined\): string =>\s*\(Array\.isArray\(v\)/)
  })
})

describe('the ICP is read through the guarded helper where a bad profile made a 500', () => {
  it('/contacts/import no longer parses the profile bare', () => {
    const src = code(read(`${APP}contacts/import/page.tsx`))
    expect(src).not.toContain('parseIcpDefinition(')
    expect(src).toContain('readIcp(')
  })

  it('the company page reads a profile that does not parse as no profile', () => {
    const src = code(read(`${APP}companies/[domain]/page.tsx`))
    expect(src).toMatch(/try\s*\{\s*icp = icpRow \? parseIcpDefinition\(icpRow\.definition\) : null\s*\}\s*catch\s*\{\s*icp = null\s*\}/)
  })

  it.each([
    ['/compliance', 'compliance/page.tsx'],
    ['the print view', 'proposals/[id]/print/page.tsx'],
    ['the Markdown export', 'api/proposals/[id]/markdown/route.ts'],
  ])('%s takes its stale threshold from readIcp, never from the definition', (_label, file) => {
    const src = code(read(`${APP}${file}`))
    expect(src).toContain('readIcp(')
    expect(src).toContain('staleAfterDays')
    expect(src).not.toContain('stale_after_days')
    expect(src).not.toContain('parseIcpDefinition(')
  })

  it('/compliance says when the threshold is the default because the profile could not be read', () => {
    const src = read(`${APP}compliance/page.tsx`)
    expect(src).toMatch(/unreadable \? \(/)
    expect(src).toContain('The active ICP could not be read.')
  })

  /** The failure the three used to have, and the answer they now get. */
  it('a zero threshold throws in isStale and falls back to the default through readIcp', () => {
    const seed: unknown = JSON.parse(read('../../../packages/db/seed/icp-security-gap-saas.json'))
    const bad = { ...(seed as Record<string, unknown>), freshness: { stale_after_days: 0 } }
    const ranAt = new Date('2026-09-01T00:00:00Z')
    expect(() => isStale(ranAt, 0)).toThrow()
    const r = readIcp(bad)
    expect(r.unreadable).toBe(true)
    expect(() => isStale(ranAt, r.staleAfterDays)).not.toThrow()
  })
})

describe('the new routes check an id’s full shape, so a malformed one is a 404 and not a 500', () => {
  const ROUTES = [
    'api/notes/route.ts',
    'api/notes/[id]/route.ts',
    'api/tasks/route.ts',
    'api/tasks/[id]/route.ts',
    'api/tasks/templates/route.ts',
    'api/meetings/route.ts',
    'api/meetings/[id]/route.ts',
    'api/meetings/[id]/ics/route.ts',
    'api/touches/[id]/performed/route.ts',
    // The same pattern, found afterwards in older pages and routes.
    'calls/[id]/page.tsx',
    'meetings/[id]/page.tsx',
    'proposals/[id]/page.tsx',
    'api/deals/route.ts',
    'api/proposals/route.ts',
    'api/campaigns/[id]/enrol/route.ts',
  ]
  const MALFORMED = [
    '------------------------------------',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa-aaa',
    '0b0e5a4e7d1c4c8e9a511f7d1c0c00010000',
  ]
  const REAL = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'

  it.each(ROUTES)('%s', (file) => {
    const src = code(read(`${APP}${file}`))
    expect(src).not.toMatch(/\{36\}/)
    const m = /^const UUID = \/(.+)\/([a-z]*)$/m.exec(src)
    expect(m, 'declares its UUID pattern').not.toBeNull()
    const re = new RegExp(m![1]!, m![2])
    for (const id of MALFORMED) expect(re.test(id), id).toBe(false)
    expect(re.test(REAL)).toBe(true)
    expect(re.test(REAL.toUpperCase())).toBe(true)
  })

  it('the old pattern let every malformed one through — the reason for the change', () => {
    const loose = /^[0-9a-f-]{36}$/i
    for (const id of MALFORMED) expect(loose.test(id), id).toBe(true)
  })
})

describe('the meetings route answers a refused outcome with a status, not a 500', () => {
  it('maps already_rescheduled — which setMeetingOutcome now returns — to 409', () => {
    const src = code(read(`${APP}api/meetings/[id]/route.ts`))
    expect(src).toMatch(/already_rescheduled: 409/)
    expect(src).toMatch(/setMeetingOutcome\([\s\S]*?REFUSAL_STATUS\[r\.reason\]/)
  })
})
