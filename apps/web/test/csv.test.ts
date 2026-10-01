/**
 * The CSV writer and the three export views. A spreadsheet reads a blank as
 * false and an `=` as a formula; these tests are about neither happening by
 * accident.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPANIES_COLUMNS, CONSENTS_COLUMNS, CRLF, EXPORT_ROW_CAP, FINDINGS_COLUMNS, INTERNAL_NOTICE, UTF8_BOM,
  companiesCsvRows, consentsCsvRows, csvDocument, csvField, csvLine, exportFile, exportFilename, exportHeaders,
  findingsCsvRows, tooManyRowsMessage, type CompanyCsvInput,
} from '../src/lib/csv'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const CLOCK = { staleAfterDays: 14, now: NOW }
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)

describe('csvField', () => {
  it('leaves a plain field alone and an empty field empty', () => {
    expect(csvField('rentman.io')).toBe('rentman.io')
    expect(csvField('')).toBe('')
  })

  it('quotes a comma, a quote (doubled), LF and CRLF', () => {
    expect(csvField('Acme, Inc')).toBe('"Acme, Inc"')
    expect(csvField('the "real" one')).toBe('"the ""real"" one"')
    expect(csvField('one\ntwo')).toBe('"one\ntwo"')
    expect(csvField('one\r\ntwo')).toBe('"one\r\ntwo"')
  })

  it('neutralises a cell a spreadsheet would evaluate', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvField('+1')).toBe("'+1")
    expect(csvField('-1')).toBe("'-1")
    expect(csvField('@x')).toBe("'@x")
    expect(csvField('\t=1')).toBe("'\t=1")
    // Guarded FIRST, then quoted: the apostrophe lands inside the quotes.
    expect(csvField('=HYPERLINK("https://evil.example","Open")')).toBe(
      '"\'=HYPERLINK(""https://evil.example"",""Open"")"',
    )
  })

  it('leaves a formula character alone when it is not the first one', () => {
    expect(csvField('a=b')).toBe('a=b')
    expect(csvField('max-age=31536000')).toBe('max-age=31536000')
  })
})

describe('csvLine, csvDocument, exportFile', () => {
  it('ends every record in CRLF', () => {
    expect(csvLine(['a', 'b,c', ''])).toBe('a,"b,c",' + CRLF)
  })

  it('writes the header even with no rows, and adds no BOM itself', () => {
    expect(csvDocument(['domain', 'name'], [])).toBe('domain,name\r\n')
    expect(csvDocument(['domain', 'name'], [['a.io', 'A'], ['b.io', '']])).toBe('domain,name\r\na.io,A\r\nb.io,\r\n')
  })

  it('starts the file with the BOM and the internal notice', () => {
    expect(UTF8_BOM).toBe('﻿')
    const file = exportFile(['domain'], [['a.io']])
    expect(file).toBe('﻿# internal — never prospect-facing\r\ndomain\r\na.io\r\n')
    expect(file.startsWith(UTF8_BOM + INTERNAL_NOTICE + CRLF)).toBe(true)
  })

  it('names the file by view and UTC date, in ASCII', () => {
    expect(exportFilename('companies', NOW)).toBe('companies-2026-09-30.csv')
    expect(exportFilename('consents', new Date('2026-12-31T23:30:00-05:00'))).toBe('consents-2027-01-01.csv')
    const h = exportHeaders('findings', NOW)
    expect(h['content-disposition']).toBe('attachment; filename="findings-2026-09-30.csv"')
    expect(h['content-type']).toBe('text/csv; charset=utf-8')
    expect(h['cache-control']).toBe('no-store')
  })

  it('says nothing was exported when the cap refuses', () => {
    expect(EXPORT_ROW_CAP).toBe(20_000)
    expect(tooManyRowsMessage(20_001)).toMatch(/20,001 rows; the limit is 20,000\. Nothing was exported/)
  })
})

describe('companiesCsvRows', () => {
  const base: CompanyCsvInput = {
    domain: 'acme.example', name: 'Acme', score: 82, tier: 'A — call first', qualified: true,
    disqualifiedReason: null, lastScanAt: daysAgo(2), lastScanOk: true, openDealStage: 'meeting',
  }
  const cells = (over: Partial<CompanyCsvInput>) => {
    const [r] = companiesCsvRows([{ ...base, ...over }], CLOCK)
    return Object.fromEntries(COMPANIES_COLUMNS.map((c, i) => [c, r![i]]))
  }

  it('writes a scanned company in full', () => {
    expect(cells({})).toEqual({
      domain: 'acme.example', name: 'Acme', score: '82', tier: 'A — call first', qualified: 'yes',
      disqualified_reason: '', last_scan_at: daysAgo(2).toISOString(), last_scan_ok: 'yes', stale: 'no',
      open_deal_stage: 'meeting',
    })
  })

  it('writes a never-scanned company with an EMPTY score — not 0 — and no stale, tier or qualified', () => {
    const never = cells({ score: null, tier: null, qualified: false, lastScanAt: null, lastScanOk: null, openDealStage: null, name: null })
    expect(never.score).toBe('')
    expect(never.score).not.toBe('0')
    expect(never).toMatchObject({ name: '', tier: '', qualified: '', last_scan_at: '', last_scan_ok: '', stale: '', open_deal_stage: '' })
  })

  it('keeps a real zero as 0', () => {
    expect(cells({ score: 0, tier: null, qualified: false }).score).toBe('0')
  })

  it('derives stale yes / no from the scan time and the threshold', () => {
    expect(cells({ lastScanAt: daysAgo(20) }).stale).toBe('yes')
    expect(cells({ lastScanAt: daysAgo(13) }).stale).toBe('no')
  })

  it('writes disqualified over a stored tier, and below threshold for a scored company without one', () => {
    expect(cells({ disqualifiedReason: 'headcount', qualified: false }).tier).toBe('disqualified')
    expect(cells({ tier: null, score: 30, qualified: false })).toMatchObject({ tier: 'below threshold', qualified: 'no' })
  })

  it('neutralises a company name a stranger wrote through the booking page', () => {
    const [r] = companiesCsvRows([{ ...base, name: '=HYPERLINK("https://evil.example")' }], CLOCK)
    expect(csvLine(r!)).toContain(`"'=HYPERLINK(""https://evil.example"")"`)
  })
})

describe('findingsCsvRows', () => {
  const group = {
    company: { domain: 'acme.example', name: 'Acme' },
    scan: { ranAt: daysAgo(20), ok: true },
    findings: [
      { signalKey: 'csp', observed: true, gap: true, scored: true, weight: 10, detail: 'no CSP', evidence: { header: 'absent' } },
      { signalKey: 'hsts', observed: true, gap: false, scored: true, weight: 0, detail: null, evidence: { header: 'max-age=1' } },
      { signalKey: 'trust_page', observed: false, gap: null, scored: true, weight: 0, detail: 'timed out', evidence: {} },
    ],
  }
  const col = (row: readonly string[], name: (typeof FINDINGS_COLUMNS)[number]) => row[FINDINGS_COLUMNS.indexOf(name)]

  it('leaves gap and weight BLANK for an unobserved signal — never "no" and never 0', () => {
    const rows = findingsCsvRows([group], CLOCK)
    const unobserved = rows.find((r) => col(r, 'signal_key') === 'trust_page')!
    expect(col(unobserved, 'observed')).toBe('no')
    expect(col(unobserved, 'gap')).toBe('')
    expect(col(unobserved, 'weight')).toBe('')
    const inPlace = rows.find((r) => col(r, 'signal_key') === 'hsts')!
    expect(col(inPlace, 'gap')).toBe('no')
    expect(col(inPlace, 'weight')).toBe('0')
  })

  // additive.ts stores "not applicable" as observed with no gap; a `no` in
  // the gap column is a pass somebody filters on.
  it('writes "not applicable" in the gap column for a not-applicable row, never "no"', () => {
    const na = {
      signalKey: 'csp_quality', observed: true, gap: false, scored: false, weight: 0,
      detail: 'not applicable — no enforced Content-Security-Policy to judge', evidence: { seen: 'absent' },
    }
    const clean = { ...na, signalKey: 'hsts_quality', detail: 'max-age=31536000' }
    const rows = findingsCsvRows([{ ...group, findings: [na, clean] }], CLOCK)
    expect(col(rows.find((r) => col(r, 'signal_key') === 'csp_quality')!, 'gap')).toBe('not applicable')
    expect(col(rows.find((r) => col(r, 'signal_key') === 'hsts_quality')!, 'gap')).toBe('no')
  })

  it('writes stale per row from the scan time, and the evidence as JSON', () => {
    const rows = findingsCsvRows([group], CLOCK)
    expect(rows.map((r) => col(r, 'stale'))).toEqual(['yes', 'yes', 'yes'])
    expect(col(rows[0]!, 'evidence')).toBe('{"header":"absent"}')
    const fresh = findingsCsvRows([{ ...group, scan: { ranAt: daysAgo(1), ok: true } }], CLOCK)
    expect(col(fresh[0]!, 'stale')).toBe('no')
  })

  it('keeps a scan with no findings as one row with the signal columns empty', () => {
    const rows = findingsCsvRows([{ ...group, scan: { ranAt: daysAgo(1), ok: false }, findings: [] }], CLOCK)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(FINDINGS_COLUMNS.length)
    expect(col(rows[0]!, 'scan_ok')).toBe('no')
    expect(col(rows[0]!, 'signal_key')).toBe('')
    expect(col(rows[0]!, 'observed')).toBe('')
  })
})

describe('consentsCsvRows', () => {
  it('writes the three states in words, and blanks what was never recorded', () => {
    const rows = consentsCsvRows([
      { contactId: 'c1', email: 'jane@acme.example', companyDomain: 'acme.example', channel: 'email', state: 'granted', source: 'booking form', recordedAt: NOW },
      { contactId: 'c1', email: 'jane@acme.example', companyDomain: 'acme.example', channel: 'sms', state: 'refused', source: '-reply: stop', recordedAt: NOW },
      { contactId: 'c1', email: 'jane@acme.example', companyDomain: 'acme.example', channel: 'voice', state: 'never_asked', source: null, recordedAt: null },
    ])
    expect(rows.map((r) => r[CONSENTS_COLUMNS.indexOf('state')])).toEqual(['granted', 'refused', 'never_asked'])
    expect(rows[2]).toEqual(['c1', 'jane@acme.example', 'acme.example', 'voice', 'never_asked', '', ''])
    expect(rows[0]![CONSENTS_COLUMNS.indexOf('recorded_at')]).toBe('2026-09-30T12:00:00.000Z')
    // A free-text source goes through the same guard as everything else.
    expect(csvLine(rows[1]!)).toContain(",'-reply: stop,")
  })
})
