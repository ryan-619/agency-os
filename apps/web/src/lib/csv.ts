import { isNotApplicable, isStale } from '@agency/core'
import { tierLabel, type CompanyListClock } from './company-list'

/**
 * The CSV writer for the three exports, and what each export's rows say.
 *
 * The format is RFC 4180: a field is quoted when it holds a double quote, a
 * comma, CR or LF; a quote inside a quoted field is doubled; every line ends
 * in CRLF, which is the RFC's line ending and what Excel expects. Pure — a
 * string in, a string out — so every rule below is a unit test.
 *
 * Three additions the RFC does not ask for, each for a reason:
 *
 *  - A UTF-8 byte-order mark. Names in this CRM are not ASCII ("José"), and
 *    without the BOM Excel on Windows reads the file in the locale's code page
 *    and mangles them. The importer drops it, so a companies export still
 *    round-trips through /companies/import.
 *  - A first line reading `# internal — never prospect-facing`. An export is
 *    lead data leaving the database (§2.3, §5.5); the file says what it is in
 *    the one place everybody who opens it will see. The importer skips `#`
 *    lines, and `pandas.read_csv(comment='#')` does too.
 *  - The formula guard. A cell beginning `=`, `+`, `-` or `@` (or a tab or
 *    CR, which some spreadsheets strip before looking) is a FORMULA to Excel
 *    and Sheets. Company names arrive from the public booking page and
 *    scanner details quote a stranger's HTTP headers, so a cell here can be
 *    written by anybody: `=HYPERLINK("https://evil.example", "Open")` becomes
 *    a live link in the agency's own spreadsheet. Such a cell is prefixed with
 *    an apostrophe, which spreadsheets read as "this is text". The importer
 *    takes it back off a company name, so the name round-trips.
 *
 * And one rule the exports share with the pages: a blank is not false. An
 * unscanned company has an EMPTY score, not 0; an unobserved finding has an
 * empty `gap`, not "no"; a channel nobody asked about says `never_asked`.
 */

/** Excel opens a UTF-8 file with a BOM as UTF-8; without one it guesses, and guesses wrong. */
export const UTF8_BOM = '﻿'
export const CRLF = '\r\n'

/** The first line of every export file. */
export const INTERNAL_NOTICE = '# internal — never prospect-facing'

/**
 * Above this many data rows an export is refused with 413 rather than cut
 * short: a truncated file is a wrong statement about the pipeline, and nothing
 * in it would say so.
 */
export const EXPORT_ROW_CAP = 20_000

export type ExportView = 'companies' | 'findings' | 'consents'

/** A leading character that makes a spreadsheet evaluate the cell. */
const FORMULA_LEAD = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/

/** One field: formula-guarded, then quoted if it has to be. */
export function csvField(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** One record, CRLF-terminated. */
export function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(',') + CRLF
}

/**
 * A header and its records. Always the header, even with no rows — an empty
 * export that still names its columns is an answer; an empty file is not.
 * No BOM and no notice here: `exportFile` adds both.
 */
export function csvDocument(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return csvLine(header) + rows.map(csvLine).join('')
}

/** The whole file an export route sends: BOM, notice, header, rows. */
export function exportFile(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return UTF8_BOM + INTERNAL_NOTICE + CRLF + csvDocument(header, rows)
}

/** `companies-2026-09-30.csv`. ASCII only, so it needs no `filename*=`; the date is UTC. */
export function exportFilename(view: ExportView, now: Date): string {
  return `${view}-${now.toISOString().slice(0, 10)}.csv`
}

export function exportHeaders(view: ExportView, now: Date): Record<string, string> {
  return {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${exportFilename(view, now)}"`,
    // Lead data: no shared cache, no browser cache, no content sniffing.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

/** The sentence a 413 carries. Nothing was exported, and it says so. */
export function tooManyRowsMessage(rows: number): string {
  return (
    `This export would be ${rows.toLocaleString('en')} rows; the limit is ${EXPORT_ROW_CAP.toLocaleString('en')}. ` +
    'Nothing was exported — a file cut short would be a wrong statement about the data.'
  )
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** `yes` / `no`, and EMPTY for null — unknown is not no. */
export function yesNo(value: boolean | null | undefined): string {
  return value === null || value === undefined ? '' : value ? 'yes' : 'no'
}

/** Full ISO time, not the page's date: a spreadsheet can shorten it; nobody can lengthen it. */
export function isoOrBlank(at: Date | null | undefined): string {
  return at ? at.toISOString() : ''
}

// ---------------------------------------------------------------------------
// The three views
// ---------------------------------------------------------------------------

/**
 * The file re-imports through /companies/import: `parseCompanySeeds`
 * (packages/db, `csv.ts`) recognises this header — column names, `domain`
 * and `name` among them, and more besides — reads the rows as RFC 4180 and
 * takes those two columns, so a new domain comes back with its name and
 * nothing else. Domains already present are left untouched.
 * `apps/web/test/companies-round-trip.test.ts` runs the round trip.
 */
export const COMPANIES_COLUMNS = [
  'domain', 'name', 'score', 'tier', 'qualified', 'disqualified_reason',
  'last_scan_at', 'last_scan_ok', 'stale', 'open_deal_stage',
] as const

/** What the companies mapper reads — `CompanyListItem` satisfies it. */
export interface CompanyCsvInput {
  readonly domain: string
  readonly name: string | null
  readonly score: number | null
  readonly tier: string | null
  readonly qualified: boolean
  readonly disqualifiedReason: string | null
  readonly lastScanAt: Date | null
  readonly lastScanOk: boolean | null
  readonly openDealStage: string | null
}

/** The same facts the list shows, one row per company. */
export function companiesCsvRows(rows: readonly CompanyCsvInput[], clock: CompanyListClock): string[][] {
  return rows.map((r) => {
    const scanned = r.score !== null
    return [
      r.domain,
      r.name ?? '',
      // Never scanned is EMPTY, not 0 — the page shows "—" for the same reason.
      scanned ? String(r.score) : '',
      tierLabel(r) ?? '',
      scanned ? yesNo(r.qualified) : '',
      r.disqualifiedReason ?? '',
      isoOrBlank(r.lastScanAt),
      yesNo(r.lastScanOk),
      // From the scan's ran_at, never findings.stale. No scan, no answer.
      r.lastScanAt === null ? '' : yesNo(isStale(r.lastScanAt, clock.staleAfterDays, clock.now)),
      r.openDealStage ?? '',
    ]
  })
}

export const FINDINGS_COLUMNS = [
  'domain', 'name', 'scan_ran_at', 'scan_ok', 'stale',
  'signal_key', 'observed', 'gap', 'scored', 'weight', 'detail', 'evidence',
] as const

/** What the findings mapper reads — `exportsFindingsForLatestScans` returns it. */
export interface FindingsCsvGroup {
  readonly company: { readonly domain: string; readonly name: string | null }
  readonly scan: { readonly ranAt: Date; readonly ok: boolean }
  readonly findings: readonly {
    readonly signalKey: string
    readonly observed: boolean
    readonly gap: boolean | null
    readonly scored: boolean
    readonly weight: number
    readonly detail: string | null
    readonly evidence: unknown
  }[]
}

/**
 * One row per finding of each company's latest scan.
 *
 * `gap` and `weight` are EMPTY for a signal the scanner could not observe.
 * The database already stores gap NULL there; the weight is stored as 0,
 * and a 0 in a spreadsheet column is a number somebody sums — "this signal
 * counted for nothing" — when the truth is that nobody knows (§2.2).
 * `stale` is per row but derived from the SCAN's `ran_at`, because that is
 * when every finding in it was observed.
 *
 * `gap` reads `not applicable` for the scanner's not-applicable rows (no CSP
 * to judge, no HSTS header to read) rather than `no`: they are stored
 * observed with no gap, and a `no` in a gap column is a pass somebody filters
 * on, when the page gave nothing to judge (`isNotApplicable`, the rule the
 * company page and the diff use).
 *
 * A latest scan that recorded no findings still gets one row, with the signal
 * columns empty, so a failed scan reads as a failed scan rather than as a
 * company that is not in the file.
 */
export function findingsCsvRows(groups: readonly FindingsCsvGroup[], clock: CompanyListClock): string[][] {
  const out: string[][] = []
  for (const g of groups) {
    const scanCells = [
      g.company.domain,
      g.company.name ?? '',
      isoOrBlank(g.scan.ranAt),
      yesNo(g.scan.ok),
      yesNo(isStale(g.scan.ranAt, clock.staleAfterDays, clock.now)),
    ]
    if (g.findings.length === 0) {
      out.push([...scanCells, '', '', '', '', '', '', ''])
      continue
    }
    for (const f of g.findings) {
      out.push([
        ...scanCells,
        f.signalKey,
        yesNo(f.observed),
        !f.observed ? '' : isNotApplicable(f) ? 'not applicable' : yesNo(f.gap),
        yesNo(f.scored),
        f.observed ? String(f.weight) : '',
        f.detail ?? '',
        JSON.stringify(f.evidence ?? {}),
      ])
    }
  }
  return out
}

export const CONSENTS_COLUMNS = [
  'contact_id', 'email', 'company_domain', 'channel', 'state', 'source', 'recorded_at',
] as const

/** What the consents mapper reads — `exportsConsentLedgerRows` returns it. */
export interface ConsentCsvInput {
  readonly contactId: string
  readonly email: string | null
  readonly companyDomain: string | null
  readonly channel: string
  readonly state: 'granted' | 'refused' | 'never_asked'
  readonly source: string | null
  readonly recordedAt: Date | null
}

/**
 * The consent ledger, one row per contact per channel. `state` is written
 * out in words — `granted`, `refused`, `never_asked` — rather than yes/no/blank,
 * because the difference between the last two is the whole point (§2.1: only
 * one of them may never be asked again).
 */
export function consentsCsvRows(rows: readonly ConsentCsvInput[]): string[][] {
  return rows.map((r) => [
    r.contactId,
    r.email ?? '',
    r.companyDomain ?? '',
    r.channel,
    r.state,
    r.source ?? '',
    isoOrBlank(r.recordedAt),
  ])
}
