/**
 * The companies list's filters and sort. The rules worth pinning are the ones
 * where a blank could quietly become a value: a never-scanned company sorting
 * as if it scored zero, "not qualified" swallowing companies nobody scanned,
 * and "stale" being read from anything but the scan's own time.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyCompanyQuery, companyQueryFilters, companyQueryString, parseCompanyQuery, readIcp, scanState, tierLabel,
  type CompanyListItem,
} from '../src/lib/company-list'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const CLOCK = { staleAfterDays: 14, now: NOW }
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)

let n = 0
function row(over: Partial<CompanyListItem> & { domain: string }): CompanyListItem {
  n += 1
  return {
    companyId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: null,
    score: null,
    tier: null,
    qualified: false,
    disqualifiedReason: null,
    lastScanAt: null,
    lastScanOk: null,
    openDealStage: null,
    ...over,
  }
}

const ROWS: readonly CompanyListItem[] = [
  row({ domain: 'acme.example', name: 'Acme', score: 82, tier: 'A — call first', qualified: true, lastScanAt: daysAgo(2), lastScanOk: true, openDealStage: 'meeting' }),
  row({ domain: 'beta.example', name: 'Beta Labs', score: 30, tier: null, qualified: false, lastScanAt: daysAgo(20), lastScanOk: true }),
  row({ domain: 'never.example', name: 'Never Scanned' }),
  row({ domain: 'down.example', lastScanAt: daysAgo(1), lastScanOk: false }),
  row({ domain: 'gamma.example', name: 'Gamma', score: 58, tier: 'B — sequence', qualified: true, lastScanAt: daysAgo(14.5), lastScanOk: true, openDealStage: 'replied' }),
  row({ domain: 'delta.example', name: 'Delta', score: 71, tier: 'A — call first', qualified: false, disqualifiedReason: 'headcount over 500', lastScanAt: daysAgo(3), lastScanOk: true }),
]

const q = (params: Record<string, string>) => parseCompanyQuery(params)
const domains = (params: Record<string, string>) => applyCompanyQuery(ROWS, q(params), CLOCK).map((r) => r.domain)

describe('parseCompanyQuery', () => {
  it('defaults to every company by domain, ascending', () => {
    expect(q({})).toEqual({ q: '', tier: null, state: null, qualified: null, openDeal: null, sort: 'domain', dir: 'asc' })
  })

  it('reads URLSearchParams and a Next searchParams record the same way, taking the first of a repeated key', () => {
    const fromUrl = parseCompanyQuery(new URLSearchParams('q=acme&state=stale&state=never&sort=score'))
    const fromRecord = parseCompanyQuery({ q: 'acme', state: ['stale', 'never'], sort: 'score' })
    expect(fromUrl).toEqual(fromRecord)
    expect(fromUrl).toMatchObject({ q: 'acme', state: 'stale', sort: 'score', dir: 'desc' })
  })

  it('ignores a value it does not know rather than guessing at one', () => {
    expect(q({ state: 'old', qualified: 'maybe', openDeal: 'won', sort: 'revenue', dir: 'up' })).toEqual(q({}))
  })

  it('refuses a closed stage as an open-deal filter — no company ever has an open deal at won', () => {
    expect(q({ openDeal: 'won' }).openDeal).toBeNull()
    expect(q({ openDeal: 'lost' }).openDeal).toBeNull()
    expect(q({ openDeal: 'proposal' }).openDeal).toBe('proposal')
  })

  it('round-trips through companyQueryString, carrying only what differs from the defaults', () => {
    const query = q({ q: 'lab', tier: 'A — call first', openDeal: 'no', sort: 'score', dir: 'desc' })
    const qs = companyQueryString(query)
    expect(qs).not.toContain('dir=')   // desc is score's default
    expect(parseCompanyQuery(new URLSearchParams(qs))).toEqual(query)
    expect(companyQueryString(q({}))).toBe('')
    expect(companyQueryFilters(query)).toEqual({ q: 'lab', tier: 'A — call first', openDeal: 'no', sort: 'score' })
  })
})

describe('applyCompanyQuery — sorting', () => {
  it('sorts a null score LAST in both directions', () => {
    const desc = domains({ sort: 'score', dir: 'desc' })
    const asc = domains({ sort: 'score', dir: 'asc' })
    expect(desc).toEqual(['acme.example', 'delta.example', 'gamma.example', 'beta.example', 'down.example', 'never.example'])
    expect(asc).toEqual(['beta.example', 'gamma.example', 'delta.example', 'acme.example', 'down.example', 'never.example'])
  })

  it('sorts a never-scanned company last by last scan, in both directions', () => {
    expect(domains({ sort: 'lastScanAt', dir: 'desc' }).at(-1)).toBe('never.example')
    expect(domains({ sort: 'lastScanAt', dir: 'asc' }).at(-1)).toBe('never.example')
    expect(domains({ sort: 'lastScanAt', dir: 'asc' })[0]).toBe('beta.example')
  })

  it('sorts a missing name last and breaks ties on domain', () => {
    const byName = domains({ sort: 'name' })
    expect(byName.slice(0, 5)).toEqual(['acme.example', 'beta.example', 'delta.example', 'gamma.example', 'never.example'])
    expect(byName.at(-1)).toBe('down.example')
  })

  it('does not reorder the array it was given', () => {
    const copy = [...ROWS]
    applyCompanyQuery(ROWS, q({ sort: 'score' }), CLOCK)
    expect(ROWS).toEqual(copy)
  })
})

describe('applyCompanyQuery — filtering', () => {
  it('matches q against the domain and the name, case-insensitively', () => {
    expect(domains({ q: 'LABS' })).toEqual(['beta.example'])
    expect(domains({ q: 'gamma.ex' })).toEqual(['gamma.example'])
    expect(domains({ q: 'example' })).toHaveLength(ROWS.length)
    expect(domains({ q: 'nothing-like-this' })).toEqual([])
  })

  it('reads stale from the scan time against the threshold and a fixed now', () => {
    // 20 days and 14.5 days are past a 14-day threshold; 2 and 3 are not.
    expect(domains({ state: 'stale' })).toEqual(['beta.example', 'gamma.example'])
    expect(domains({ state: 'fresh' })).toEqual(['acme.example', 'delta.example'])
    // The same rows under a 30-day threshold are all fresh.
    const lenient = applyCompanyQuery(ROWS, q({ state: 'stale' }), { staleAfterDays: 30, now: NOW })
    expect(lenient).toEqual([])
    // And under the 14-day threshold a week later, acme and delta age out too.
    const later = applyCompanyQuery(ROWS, q({ state: 'stale' }), { staleAfterDays: 14, now: new Date(NOW.getTime() + 13 * 86_400_000) })
    expect(later.map((r) => r.domain)).toEqual(['acme.example', 'beta.example', 'delta.example', 'gamma.example'])
  })

  it('keeps never, failed, stale and fresh apart — a failed scan is not fresh, however recent', () => {
    expect(domains({ state: 'never' })).toEqual(['never.example'])
    expect(domains({ state: 'failed' })).toEqual(['down.example'])
    expect(scanState({ lastScanAt: daysAgo(0), lastScanOk: false }, CLOCK)).toBe('failed')
  })

  it('filters on the open deal: any, none, or a stage', () => {
    expect(domains({ openDeal: 'meeting' })).toEqual(['acme.example'])
    expect(domains({ openDeal: 'yes' })).toEqual(['acme.example', 'gamma.example'])
    expect(domains({ openDeal: 'no' })).toEqual(['beta.example', 'delta.example', 'down.example', 'never.example'])
    expect(domains({ openDeal: 'proposal' })).toEqual([])
  })

  it('never counts an unscanned company as not qualified — blank is not false', () => {
    expect(domains({ qualified: 'yes' })).toEqual(['acme.example', 'gamma.example'])
    expect(domains({ qualified: 'no' })).toEqual(['beta.example', 'delta.example'])
  })

  it('filters on the tier as the list shows it', () => {
    expect(domains({ tier: 'A — call first' })).toEqual(['acme.example'])   // delta is disqualified, not A
    expect(domains({ tier: 'disqualified' })).toEqual(['delta.example'])
    expect(domains({ tier: 'below threshold' })).toEqual(['beta.example'])
    expect(tierLabel({ score: null, tier: null, disqualifiedReason: null })).toBeNull()
  })

  it('combines filters', () => {
    expect(domains({ q: 'a', qualified: 'yes', state: 'stale' })).toEqual(['gamma.example'])
  })
})

describe('readIcp', () => {
  const seed = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/db/seed/icp-security-gap-saas.json'), 'utf8'),
  ) as Record<string, unknown>

  it('reads the seeded profile and its threshold', () => {
    const r = readIcp(seed)
    expect(r.unreadable).toBe(false)
    expect(r.icp?.scoring.qualify_at).toBe(45)
    expect(r.staleAfterDays).toBe(14)
  })

  it('has no ICP and no complaint when there is no profile row', () => {
    expect(readIcp(undefined)).toEqual({ icp: null, unreadable: false, staleAfterDays: 14 })
  })

  it('falls back instead of throwing on a malformed profile — the list was a 500 for this', () => {
    expect(readIcp({ label: '' })).toEqual({ icp: null, unreadable: true, staleAfterDays: 14 })
    expect(readIcp('not an object')).toMatchObject({ icp: null, unreadable: true })
  })

  it('refuses a threshold isStale() would throw on, and says the profile is unreadable', () => {
    for (const bad of [0, -3, Number.NaN, '14']) {
      const r = readIcp({ ...seed, freshness: { stale_after_days: bad } })
      expect(r).toMatchObject({ unreadable: true, staleAfterDays: 14 })
      expect(r.icp?.label).toBe(seed.label)
    }
    expect(readIcp({ ...seed, freshness: { stale_after_days: 30 } }).staleAfterDays).toBe(30)
  })
})
