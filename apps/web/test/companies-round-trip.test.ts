/**
 * A companies export goes back in through /companies/import as the same
 * domains and names.
 *
 * The export is domain-first so that it would, and for as long as the
 * importer read everything after the first comma as the name it did not: a
 * NEW domain came back named `Acme,72,A — call first,yes,…`. These run the
 * exporter the route uses (`exportFile` over `companiesCsvRows`) into the
 * reader the import page uses (`parseCompanySeeds`) — first over rows built
 * here, then over rows a real database stored, scored and listed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile } from '@agency/core'
import { SEED_DIR, schema, type AgencyDb } from '@agency/db'
import { companyList, importCompanies, parseCompanySeeds, recordScan } from '@agency/db/repository'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { COMPANIES_COLUMNS, companiesCsvRows, exportFile, type CompanyCsvInput } from '../src/lib/csv'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const CLOCK = { staleAfterDays: 14, now: NOW }

/**
 * Names that break a naive reader, each the way a real one arrives: a comma
 * typed into the booking page, quotes, a line break, a non-ASCII letter, and
 * the cells the exporter guards because a spreadsheet would evaluate them.
 */
const NAMES: Readonly<Record<string, string>> = {
  'comma.example': 'Acme, Inc.',
  'quotes.example': 'The "Real" Co',
  'newline.example': 'Line one\nLine two',
  'accent.example': 'José Müller GmbH',
  'formula.example': '=HYPERLINK("https://evil.example","Open")',
  'minus.example': '-minus Labs',
  'at.example': '@handle',
  'plain.example': 'Plain',
  'empty.example': '',
}

const row = (domain: string, over: Partial<CompanyCsvInput> = {}): CompanyCsvInput => ({
  domain,
  name: NAMES[domain] ?? null,
  score: null,
  tier: null,
  qualified: false,
  disqualifiedReason: null,
  lastScanAt: null,
  lastScanOk: null,
  openDealStage: null,
  ...over,
})

describe('export, then import', () => {
  it('gives back the same domains and names, and nothing from the other columns', () => {
    const rows = Object.keys(NAMES).map((d, i) =>
      i % 2 === 0
        ? row(d, { score: 72, tier: 'A', qualified: true, lastScanAt: NOW, lastScanOk: true, openDealStage: 'contacted' })
        : row(d),
    )
    const file = exportFile(COMPANIES_COLUMNS, companiesCsvRows(rows, CLOCK))
    expect(parseCompanySeeds(file)).toEqual(Object.entries(NAMES).map(([domain, name]) => ({ domain, name })))
  })

  it('reads a company with no name as having none', () => {
    const file = exportFile(COMPANIES_COLUMNS, companiesCsvRows([row('nameless.example')], CLOCK))
    expect(parseCompanySeeds(file)).toEqual([{ domain: 'nameless.example', name: '' }])
  })
})

describe('export, then import, through a real database', () => {
  let test: TestDb
  let db: AgencyDb
  let fromOrg: string
  let toOrg: string

  const icp: IcpDefinition = parseIcpDefinition(
    JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
  )

  /** Every ICP signal observed, `csp` and `hsts` as gaps — a company the list scores. */
  function profile(domain: string): SiteProfile {
    const observations: Record<string, Observation> = {}
    for (const key of Object.keys(icp.signals)) {
      const gap = key === 'csp' || key === 'hsts'
      observations[key] = { observed: true, gap, detail: gap ? 'absent' : '', evidence: { header: key, seen: gap ? 'absent' : 'present' } }
    }
    return {
      domain, company: domain, title: domain, fetchOk: true, fetchError: '', hasLoginSurface: true,
      isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations,
    }
  }

  beforeAll(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const orgs = await db.insert(schema.orgs).values([{ name: 'From' }, { name: 'To' }]).returning({ id: schema.orgs.id })
    fromOrg = orgs[0]!.id
    toOrg = orgs[1]!.id
  })
  afterAll(async () => {
    await test.close()
  })

  it('stores the same domains and names in the org it is imported into', async () => {
    await importCompanies(db, fromOrg, Object.entries(NAMES).map(([domain, name]) => ({ domain, name })))
    // Score two of them, so their rows carry a score, a tier and a scan time —
    // the columns the old reader folded into the name.
    const [p] = await db
      .insert(schema.icpProfiles)
      .values({ orgId: fromOrg, name: icp.label, definition: icp as unknown as Record<string, unknown> })
      .returning({ id: schema.icpProfiles.id })
    const listed = await companyList(db, fromOrg)
    for (const c of listed.filter((r) => r.domain === 'comma.example' || r.domain === 'quotes.example')) {
      await recordScan(db, {
        orgId: fromOrg, companyId: c.companyId, icpProfile: { id: p!.id, definition: icp }, raw: {}, profile: profile(c.domain),
      })
    }

    const source = await companyList(db, fromOrg)
    expect(source.filter((r) => r.score !== null).length).toBe(2)
    const file = exportFile(
      COMPANIES_COLUMNS,
      companiesCsvRows(source.map((r) => ({ ...r, openDealStage: null })), CLOCK),
    )

    const parsed = parseCompanySeeds(file)
    const result = await importCompanies(db, toOrg, parsed, 'import')
    expect(result.inserted).toBe(source.length)

    const back = await companyList(db, toOrg)
    const names = (rows: readonly { domain: string; name: string | null }[]) =>
      rows.map((r) => ({ domain: r.domain, name: r.name ?? '' }))
    expect(names(back)).toEqual(names(source))
    expect(back.find((r) => r.domain === 'comma.example')?.name).toBe('Acme, Inc.')
  })
})
