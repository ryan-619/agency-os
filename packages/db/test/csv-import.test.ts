/**
 * The company importer reads two formats, and must not confuse them.
 *
 *   * The `domain,name` list the seed and the paste box have always taken:
 *     everything after the first comma is the name, unquoted commas and all.
 *     It must read exactly as it did — `legacyParse` below is the function as
 *     it shipped, and every plain input is run through both.
 *   * The companies EXPORT (`apps/web/src/lib/csv.ts`): a BOM, an internal
 *     notice line, then RFC 4180 with a header naming ten columns. Read the old
 *     way, a re-imported export gave a new domain the name
 *     `Acme,72,A — call first,yes,…`. It is recognised by its header — a line
 *     of column names that includes `domain` and `name` and more besides — and
 *     read as RFC 4180, taking those two columns and ignoring the rest.
 */
import { describe, expect, it } from 'vitest'
import { parseCompanySeeds } from '../src/csv.js'

/** `parseCompanySeeds` as it shipped at 04b909c, verbatim. */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/
function legacyParse(csv: string): Array<{ domain: string; name: string }> {
  const out: Array<{ domain: string; name: string }> = []
  const seen = new Set<string>()
  for (const raw of csv.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [domain = '', ...rest] = line.split(',')
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!d || d === 'domain') continue
    if (!DOMAIN.test(d)) {
      throw new Error(`Seed list contains something that is not a domain: "${domain.trim()}"`)
    }
    if (seen.has(d)) continue
    seen.add(d)
    const name = rest.join(',').trim().replace(/^"(.*)"$/s, '$1')
    out.push({ domain: d, name })
  }
  return out
}

const outcome = (fn: () => unknown): unknown => {
  try {
    return { ok: fn() }
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) }
  }
}

const BOM = '﻿'
const NOTICE = '# internal — never prospect-facing'
const HEADER = 'domain,name,score,tier,qualified,disqualified_reason,last_scan_at,last_scan_ok,stale,open_deal_stage'

describe('the plain domain,name list reads exactly as it always did', () => {
  const PLAIN: readonly string[] = [
    '',
    'rentman.io,Rentman',
    'domain,name\nrentman.io,Rentman\neagronom.com,eAgronom\namberlo.io',
    ['domain,name', '', '# a comment', 'Rentman.IO,Rentman', 'solo.dev'].join('\n'),
    'acme.com,Acme, Inc.',
    'acme.com,"Acme, Inc."',
    'acme.com,"The ""Real"" One"',
    'https://acme.com/pricing,Acme',
    '﻿domain,name\r\nacme.com,Acme\r\n',
    'acme.com,Acme\nACME.com,Acme Again',
    'not a domain at all,Nope',
    'localhost,Local',
    'domain,name\nacme.com,Acme\n"quoted.com",Quoted',
    // Data that merely CONTAINS the words is not a header.
    'acme.com,Acme,domain,name,extra',
    '# domain,name,score\nacme.com,Acme',
    'domain , name\nacme.com , Acme ',
    'Domain,Name\nacme.com,Acme',
    // A header with a blank column is not a row of column names.
    'domain,name,\nacme.com,Acme,',
    'domain,company name,notes\nacme.com,Acme,first',
    '   \n\t\n# nothing but comments\n',
  ]

  it.each(PLAIN.map((s) => [JSON.stringify(s).slice(0, 60), s] as const))('%s', (_label, input) => {
    expect(outcome(() => parseCompanySeeds(input))).toEqual(outcome(() => legacyParse(input)))
  })

  it('reads the shipped seed file the same way', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { SEED_DIR } = await import('../src/paths.js')
    const seed = readFileSync(join(SEED_DIR, 'companies-security-gap-saas.csv'), 'utf8')
    expect(parseCompanySeeds(seed)).toEqual(legacyParse(seed))
    expect(parseCompanySeeds(seed).length).toBeGreaterThan(10)
  })
})

describe('a companies export reads back as its domains and names', () => {
  const file = (...rows: string[]): string => `${BOM}${NOTICE}\r\n${HEADER}\r\n${rows.map((r) => `${r}\r\n`).join('')}`

  it('takes the domain and name columns and ignores the rest', () => {
    const csv = file(
      'acme.com,Acme,72,A — call first,yes,,2026-09-30T12:00:00.000Z,yes,no,contacted',
      'beta.io,Beta,,,,,,,,',
    )
    expect(parseCompanySeeds(csv)).toEqual([
      { domain: 'acme.com', name: 'Acme' },
      { domain: 'beta.io', name: 'Beta' },
    ])
    // The bug this exists for: the old reader kept every column in the name.
    expect(legacyParse(csv)[0]!.name).toBe('Acme,72,A — call first,yes,,2026-09-30T12:00:00.000Z,yes,no,contacted')
  })

  it('keeps a quoted name whole — commas, doubled quotes and a line break', () => {
    const csv = file(
      'acme.com,"Acme, Inc.",72,A,yes,,,,,',
      'real.co,"The ""Real"" Co",,,,,,,,',
      'two.co,"Line one\r\nLine two",,,,,,,,',
      'last.co,"ends, with a comma,",,,,,,,,',
    )
    expect(parseCompanySeeds(csv)).toEqual([
      { domain: 'acme.com', name: 'Acme, Inc.' },
      { domain: 'real.co', name: 'The "Real" Co' },
      { domain: 'two.co', name: 'Line one\r\nLine two' },
      { domain: 'last.co', name: 'ends, with a comma,' },
    ])
  })

  it('takes back the apostrophe the exporter put in front of a formula', () => {
    const csv = file(
      `formula.io,"'=HYPERLINK(""https://evil.example"",""Open"")",,,,,,,,`,
      `minus.io,'-minus Labs,,,,,,,,`,
      `at.io,'@handle,,,,,,,,`,
      `plain.io,'Quoted with an apostrophe',,,,,,,,`,
    )
    expect(parseCompanySeeds(csv).map((r) => r.name)).toEqual([
      '=HYPERLINK("https://evil.example","Open")',
      '-minus Labs',
      '@handle',
      // An apostrophe in front of anything else was never the exporter's.
      "'Quoted with an apostrophe'",
    ])
  })

  it('finds the columns by name, wherever they are', () => {
    const csv = `name,stage,domain\n"Acme, Inc.",won,acme.com\nBeta,,beta.io\n`
    expect(parseCompanySeeds(csv)).toEqual([
      { domain: 'acme.com', name: 'Acme, Inc.' },
      { domain: 'beta.io', name: 'Beta' },
    ])
  })

  it('reads LF line endings, no BOM and no notice as well as the exporter’s own', () => {
    const csv = `${HEADER}\nacme.com,"Acme, Inc.",72,A,yes,,,,,\n`
    expect(parseCompanySeeds(csv)).toEqual([{ domain: 'acme.com', name: 'Acme, Inc.' }])
  })

  it('applies the same domain rules: lower-cased, scheme and path stripped, de-duplicated, refused if not a domain', () => {
    expect(parseCompanySeeds(file('HTTPS://Acme.COM/pricing,Acme,,,,,,,,', 'acme.com,Acme Again,,,,,,,,'))).toEqual([
      { domain: 'acme.com', name: 'Acme' },
    ])
    expect(() => parseCompanySeeds(file('localhost,Local,,,,,,,,'))).toThrow(
      'Seed list contains something that is not a domain: "localhost"',
    )
  })

  it('skips blank rows, comment lines and a repeated header, and reads a short row as having no name', () => {
    const csv = file('', '# a note somebody added', HEADER, 'acme.com', ',Nameless,,,,,,,,')
    expect(parseCompanySeeds(csv)).toEqual([{ domain: 'acme.com', name: '' }])
  })

  it('reads an export with no rows as nothing to import', () => {
    expect(parseCompanySeeds(file())).toEqual([])
  })

  it('refuses a quoted field that never closes rather than guessing where it ends', () => {
    expect(() => parseCompanySeeds(file('acme.com,"Acme, Inc.,,,,,,,,'))).toThrow(/quoted field that is never closed/)
  })
})
