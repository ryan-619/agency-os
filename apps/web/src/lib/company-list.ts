import { DEFAULT_STALE_AFTER_DAYS, isStale, parseIcpDefinition, type IcpDefinition } from '@agency/core'
import type { CompanyListRow } from '@agency/db/repository'
import type { DealStage } from '@agency/db/queries'

/**
 * The companies list's filters and sort, as a pure function over the rows
 * `companyList()` already returns. The page and the companies export both go
 * through it, so "export this view" exports exactly the rows on screen.
 *
 * Two §2.2 rules shape it, and both are about a blank not becoming a value:
 *
 *  - A company that was never scanned has NO score. It is not a zero, so it
 *    never sorts among the low scorers: a null sorts LAST in both directions.
 *    Sorting it first on "ascending" would put the companies nobody has
 *    looked at above the ones that were looked at and scored badly.
 *  - `qualified=no` means scanned and not qualified. A never-scanned company
 *    is neither, so it matches neither `yes` nor `no` — blank is not false.
 *
 * Freshness is derived from the latest scan's `ran_at` with `isStale()` and
 * the ICP's threshold, never from `findings.stale` (CLAUDE.md §1). `now` is an
 * argument so the stale filter is testable against a fixed clock.
 *
 * Pure: no `server-only`, no `@/` import, no database — a test imports it.
 * The row type is imported as a type only, so nothing of `@agency/db` loads.
 */

/** Where a company's latest scan leaves it. One answer per company, checked in this order. */
export type ScanState = 'never' | 'failed' | 'stale' | 'fresh'
export const SCAN_STATES: readonly ScanState[] = ['never', 'failed', 'stale', 'fresh']

export type CompanySort = 'domain' | 'name' | 'score' | 'lastScanAt'
export const COMPANY_SORTS: readonly CompanySort[] = ['domain', 'name', 'score', 'lastScanAt']

/**
 * The stages a deal can be in while it is OPEN. `won` and `lost` close a deal,
 * so a company never has an open deal at either; offering them as a filter
 * would offer a view that is always empty. Checked against `DealStage`, so a
 * stage renamed in `packages/db` fails the typecheck here.
 */
export const OPEN_DEAL_STAGES = ['new', 'contacted', 'replied', 'meeting', 'proposal'] as const satisfies readonly DealStage[]
export type OpenDealStage = (typeof OPEN_DEAL_STAGES)[number]
export type OpenDealFilter = 'yes' | 'no' | OpenDealStage

export interface CompanyQuery {
  /** Case-insensitive substring of the domain or the name. '' is no filter. */
  readonly q: string
  /** A tier as the list shows it (`tierLabel`): a tier name, `disqualified` or `below threshold`. */
  readonly tier: string | null
  readonly state: ScanState | null
  readonly qualified: 'yes' | 'no' | null
  readonly openDeal: OpenDealFilter | null
  readonly sort: CompanySort
  readonly dir: 'asc' | 'desc'
}

/** A list row with its open deal's stage, or null when it has none. */
export type CompanyListItem = CompanyListRow & { readonly openDealStage: string | null }

export interface CompanyListClock {
  readonly staleAfterDays: number
  readonly now: Date
}

/**
 * The active ICP and the freshness threshold it sets — without throwing.
 *
 * `parseIcpDefinition` throws on a malformed row, and the companies page
 * called it unguarded, so one bad edit to the profile made the list a 500.
 * It also does not check `freshness.stale_after_days`, which `isStale()`
 * throws on unless it is a positive number. Either way the list and the
 * exports fall back to the documented default and the page says so
 * (`unreadable`), rather than failing or guessing a threshold.
 */
export function readIcp(definition: unknown): {
  readonly icp: IcpDefinition | null
  readonly unreadable: boolean
  readonly staleAfterDays: number
} {
  if (definition === undefined || definition === null) {
    return { icp: null, unreadable: false, staleAfterDays: DEFAULT_STALE_AFTER_DAYS }
  }
  let icp: IcpDefinition
  try {
    icp = parseIcpDefinition(definition)
  } catch {
    return { icp: null, unreadable: true, staleAfterDays: DEFAULT_STALE_AFTER_DAYS }
  }
  const days: unknown = icp.freshness?.stale_after_days
  if (days === undefined) return { icp, unreadable: false, staleAfterDays: DEFAULT_STALE_AFTER_DAYS }
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    return { icp, unreadable: true, staleAfterDays: DEFAULT_STALE_AFTER_DAYS }
  }
  return { icp, unreadable: false, staleAfterDays: days }
}

/** The longest search string kept; anything past it is not a search, it is a paste. */
const MAX_Q = 200
const MAX_TIER = 100

/** Score and last-scan read newest/highest first by default; names read A→Z. */
export function defaultDir(sort: CompanySort): 'asc' | 'desc' {
  return sort === 'score' || sort === 'lastScanAt' ? 'desc' : 'asc'
}

type Params = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>

function read(params: Params, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key)
  const v = params[key]
  if (v === undefined) return null
  return typeof v === 'string' ? v : (v[0] ?? null)
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/**
 * Read the query string of `/companies` or `/api/export/companies`.
 *
 * An unknown value is IGNORED rather than refused: this is a GET form a person
 * edits by hand in the address bar, and the worst outcome of ignoring a typo
 * is an unfiltered list, which the count line makes obvious.
 */
export function parseCompanyQuery(params: Params): CompanyQuery {
  const q = (read(params, 'q') ?? '').trim().slice(0, MAX_Q)
  const tierRaw = (read(params, 'tier') ?? '').trim()
  const sort = oneOf(read(params, 'sort'), COMPANY_SORTS) ?? 'domain'
  return {
    q,
    tier: tierRaw && tierRaw.length <= MAX_TIER ? tierRaw : null,
    state: oneOf(read(params, 'state'), SCAN_STATES),
    qualified: oneOf(read(params, 'qualified'), ['yes', 'no'] as const),
    openDeal: oneOf<OpenDealFilter>(read(params, 'openDeal'), ['yes', 'no', ...OPEN_DEAL_STAGES]),
    sort,
    dir: oneOf(read(params, 'dir'), ['asc', 'desc'] as const) ?? defaultDir(sort),
  }
}

/**
 * The query as a query string, carrying only what differs from the defaults,
 * so the Export link and the sort links reproduce the view and nothing more.
 */
export function companyQueryString(query: CompanyQuery): string {
  const p = new URLSearchParams()
  if (query.q) p.set('q', query.q)
  if (query.tier) p.set('tier', query.tier)
  if (query.state) p.set('state', query.state)
  if (query.qualified) p.set('qualified', query.qualified)
  if (query.openDeal) p.set('openDeal', query.openDeal)
  if (query.sort !== 'domain') p.set('sort', query.sort)
  if (query.dir !== defaultDir(query.sort)) p.set('dir', query.dir)
  return p.toString()
}

/** The filters in force, for an audit row — the same keys the URL uses. */
export function companyQueryFilters(query: CompanyQuery): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(companyQueryString(query)))
}

/**
 * The tier as the list SHOWS it. Disqualified wins over any stored tier, a
 * never-scanned company has none (null — not "below threshold", which is a
 * judgement a scan made), and a scored company without a tier is below it.
 */
export function tierLabel(row: Pick<CompanyListRow, 'score' | 'tier' | 'disqualifiedReason'>): string | null {
  if (row.disqualifiedReason) return 'disqualified'
  if (row.score === null) return null
  return row.tier || 'below threshold'
}

export function scanState(
  row: Pick<CompanyListRow, 'lastScanAt' | 'lastScanOk'>,
  clock: CompanyListClock,
): ScanState {
  if (row.lastScanAt === null) return 'never'
  // A failed scan observed nothing, whatever its age; "fresh" would claim
  // otherwise, and "stale" would suggest there is something to re-verify.
  if (row.lastScanOk === false) return 'failed'
  return isStale(row.lastScanAt, clock.staleAfterDays, clock.now) ? 'stale' : 'fresh'
}

function matches(row: CompanyListItem, query: CompanyQuery, clock: CompanyListClock): boolean {
  if (query.q) {
    const needle = query.q.toLowerCase()
    const inDomain = row.domain.toLowerCase().includes(needle)
    const inName = row.name !== null && row.name.toLowerCase().includes(needle)
    if (!inDomain && !inName) return false
  }
  if (query.tier !== null && tierLabel(row) !== query.tier) return false
  if (query.state !== null && scanState(row, clock) !== query.state) return false
  if (query.qualified !== null) {
    // Blank is not false: an unscanned company is in neither answer.
    if (row.score === null) return false
    if (row.qualified !== (query.qualified === 'yes')) return false
  }
  if (query.openDeal !== null) {
    if (query.openDeal === 'yes') {
      if (row.openDealStage === null) return false
    } else if (query.openDeal === 'no') {
      if (row.openDealStage !== null) return false
    } else if (row.openDealStage !== query.openDeal) {
      return false
    }
  }
  return true
}

/** Nulls last in BOTH directions; `dir` only orders the values that exist. */
function byNullable<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number, sign: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return sign * cmp(a, b)
}

const byString = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
const byName = (x: string, y: string) => x.localeCompare(y, 'en', { sensitivity: 'base' })
const byNumber = (x: number, y: number) => x - y

/** Filter, then sort. Returns a new array; the input is not reordered. */
export function applyCompanyQuery(
  rows: readonly CompanyListItem[],
  query: CompanyQuery,
  clock: CompanyListClock,
): CompanyListItem[] {
  const sign = query.dir === 'desc' ? -1 : 1
  const primary = (a: CompanyListItem, b: CompanyListItem): number => {
    switch (query.sort) {
      case 'domain':
        return sign * byString(a.domain, b.domain)
      case 'name':
        return byNullable(a.name, b.name, byName, sign)
      case 'score':
        return byNullable(a.score, b.score, byNumber, sign)
      case 'lastScanAt':
        return byNullable(a.lastScanAt?.getTime() ?? null, b.lastScanAt?.getTime() ?? null, byNumber, sign)
    }
  }
  return rows
    .filter((r) => matches(r, query, clock))
    // Domain is unique per org, so the tie-break makes the order total.
    .sort((a, b) => primary(a, b) || byString(a.domain, b.domain))
}
