/**
 * Every apps/web reader of the ICP's `freshness.stale_after_days` takes it
 * through `staleAfterDaysOf` — directly, or through `readIcp`, which now
 * delegates to it.
 *
 * `isStale` THROWS on a threshold that is not a positive number, and
 * `parseIcpDefinition` does not check `freshness`. `/compliance`, the print
 * view and the Markdown export were routed through `readIcp` in the review
 * round; their siblings were not. With `stale_after_days: 0` the proposal
 * page — the page that links to print and Markdown — and the company page
 * were a 500, and `/settings/icp` said "stale after 0 days" about a profile
 * every guarded reader was treating as 14.
 *
 * Pages cannot be imported here (they import `@/auth`), so they are pinned
 * by their source; the pure halves are run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STALE_AFTER_DAYS, isStale, staleAfterDaysOf } from '@agency/core'
import { readIcp } from '../src/lib/company-list'
import { icpView } from '../src/lib/icp-view'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
/** Comments out, so prose about the field is not a read of it. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SEED = JSON.parse(read('../../../packages/db/seed/icp-security-gap-saas.json')) as Record<string, unknown>
const withDays = (days: unknown): Record<string, unknown> => ({ ...SEED, freshness: { stale_after_days: days } })

describe('readIcp answers exactly what staleAfterDaysOf answers', () => {
  const CASES: readonly unknown[] = [
    undefined, null, { label: '' }, SEED, withDays(7), withDays(0), withDays(-3), withDays(Number.NaN), withDays('14'),
    { ...SEED, freshness: {} },
  ]
  it.each(CASES.map((c, i) => [i, c] as const))('case %i', (_i, definition) => {
    const r = readIcp(definition)
    expect(r.staleAfterDays).toBe(staleAfterDaysOf(definition))
    expect(() => isStale(new Date(), r.staleAfterDays)).not.toThrow()
  })

  it('still calls a set value it cannot use unreadable, so the page can say so — and an unset one not', () => {
    expect(readIcp(withDays(0)).unreadable).toBe(true)
    expect(readIcp(withDays(Number.NaN)).unreadable).toBe(true)
    expect(readIcp(withDays('14')).unreadable).toBe(true)
    expect(readIcp(withDays(21))).toMatchObject({ unreadable: false, staleAfterDays: 21 })
    expect(readIcp({ ...SEED, freshness: {} })).toMatchObject({ unreadable: false, staleAfterDays: DEFAULT_STALE_AFTER_DAYS })
  })
})

describe('/settings/icp says the threshold every reader uses', () => {
  const view = (definition: unknown) => {
    const r = icpView(definition)
    if (!r.ok) throw new Error(r.problem)
    return r.view
  }

  it('shows the default, not 0, for a value no reader can use — and says what the profile wrote', () => {
    const v = view(withDays(0))
    expect(v.staleAfterDays).toBe(DEFAULT_STALE_AFTER_DAYS)
    expect(v.staleAfterDaysIsDefault).toBe(true)
    expect(v.staleAfterDaysRefused).toBe('0')
    expect(view(withDays(-2)).staleAfterDaysRefused).toBe('-2')
  })

  it('says nothing is refused when the profile sets a usable value, or none', () => {
    expect(view(withDays(21))).toMatchObject({ staleAfterDays: 21, staleAfterDaysIsDefault: false, staleAfterDaysRefused: null })
    const { freshness: _unused, ...none } = SEED
    expect(view(none)).toMatchObject({ staleAfterDaysIsDefault: true, staleAfterDaysRefused: null })
  })

  it('the page renders the refusal sentence', () => {
    const src = code(read('../src/app/settings/icp/page.tsx'))
    expect(src).toContain('v.staleAfterDaysRefused')
    expect(src).toContain('which is not a positive number of days')
  })
})

describe('the proposal and company pages take the threshold through the guarded helpers', () => {
  it.each([
    ['the proposal page', '../src/app/proposals/[id]/page.tsx'],
    ['the company page', '../src/app/companies/[domain]/page.tsx'],
  ])('%s', (_label, file) => {
    const src = code(read(file))
    expect(src).not.toContain('stale_after_days')
    expect(src).toMatch(/readIcp\(|staleAfterDaysOf\(/)
  })
})

/**
 * Nothing under apps/web/src reads the field except the two modules whose job
 * is to: `readIcp`, the guarded reader every page and route goes through, and
 * `icpView`, which shows the profile as written. Two routes owned by other
 * work already guard the value themselves and are listed with why.
 */
describe('apps/web/src reads stale_after_days only in readIcp and icpView', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url))
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = join(dir, e)
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(e) ? [full] : []
    })
  const ALLOWED = new Set([
    'lib/company-list.ts',
    'lib/icp-view.ts',
  ])
  it.each(walk(SRC).map((f) => f.slice(SRC.length)))('%s', (file) => {
    if (ALLOWED.has(file)) return
    expect(code(readFileSync(join(SRC, file), 'utf8'))).not.toMatch(/\bstale_after_days\b/)
  })
})
