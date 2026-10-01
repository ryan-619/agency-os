/**
 * The reads behind the three CSV exports and the companies list's `openDeal`
 * filter.
 *
 * An export is lead data leaving the database, so these functions return the
 * facts in the shape the database holds them and decide nothing about how
 * they are written: a NULL stays null all the way to the CSV writer, which
 * renders it as an empty cell. §2.2's rule is that "not observed" is unknown,
 * never "missing" — and the one place that rule is easiest to break is the
 * moment a column of nulls meets a spreadsheet that reads blank as FALSE.
 *
 * Freshness is deliberately NOT computed here. The caller derives `stale`
 * from the scan's `ran_at` with `isStale()` and the ICP's threshold, exactly
 * as the company page does; `findings.stale` is a cache written by a sweep
 * (CLAUDE.md §1) and is not returned at all, so nobody can export it by
 * accident.
 *
 * Every name is prefixed `exports…` because `queries.ts` re-exports this
 * module with `export *`; the row types say `Exports…` for the same reason —
 * a second `FindingRow` anywhere in the barrel is a build break.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { CONSENT_CHANNELS, type ConsentChannel } from './send-preview.js'

/**
 * The stage of every company's OPEN deal, keyed by company id.
 *
 * Open means `closed_at IS NULL` — the definition `openDealFor` and 0012's
 * `deals_one_open_per_company` use — so a won or lost deal is not in the map
 * and its company reads as having no open deal, which is true. The join to
 * `companies` re-checks the org: `deals.company_id` is a plain FK to
 * `companies(id)`, so the database alone would accept another org's company
 * under this org's deal.
 */
export async function exportsOpenDealStages(db: AgencyDb, orgId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ companyId: schema.deals.companyId, stage: schema.deals.stage })
    .from(schema.deals)
    .innerJoin(
      schema.companies,
      and(eq(schema.companies.id, schema.deals.companyId), eq(schema.companies.orgId, orgId)),
    )
    .where(and(eq(schema.deals.orgId, orgId), sql`${schema.deals.closedAt} IS NULL`))
    .orderBy(desc(schema.deals.createdAt))

  // The partial unique index allows at most one open deal per company; newest
  // first means that if it ever did not, the map would carry the newer one.
  const out = new Map<string, string>()
  for (const r of rows) if (!out.has(r.companyId)) out.set(r.companyId, r.stage)
  return out
}

/** One finding as an export needs it. `stale` is absent on purpose — see the module comment. */
export interface ExportsFinding {
  readonly signalKey: string
  readonly observed: boolean
  /** NULL whenever `observed` is false (the database enforces it). */
  readonly gap: boolean | null
  readonly scored: boolean
  readonly weight: number
  readonly detail: string | null
  readonly evidence: unknown
}

export interface ExportsLatestScanFindings {
  readonly company: { readonly id: string; readonly domain: string; readonly name: string | null }
  readonly scan: { readonly id: string; readonly ranAt: Date; readonly ok: boolean }
  readonly findings: readonly ExportsFinding[]
}

/**
 * Every company's LATEST scan with its findings, companies in domain order,
 * findings in signal-key order.
 *
 * The latest scan, not every scan: a file with two scans' rows for one
 * company invites a reader to add them up, and the older one is superseded
 * evidence. A company that has never been scanned has no scan to report and
 * is left out — the companies export says "never scanned" for it with an
 * empty score. A latest scan that wrote no findings (a failed fetch can) is
 * still returned, with an empty list, so the caller can say the scan
 * happened rather than dropping the company silently.
 *
 * Three org-scoped reads folded in memory, the same shape as `companyList()`
 * and for the same reason: the typed builder cannot express DISTINCT ON, and
 * `db.execute` returns `unknown` on the driver-agnostic type.
 */
export async function exportsFindingsForLatestScans(
  db: AgencyDb,
  orgId: string,
): Promise<ExportsLatestScanFindings[]> {
  const companies = await db
    .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
    .from(schema.companies)
    .where(eq(schema.companies.orgId, orgId))
    .orderBy(schema.companies.domain)

  const scans = await db
    .select({ id: schema.scans.id, companyId: schema.scans.companyId, ranAt: schema.scans.ranAt, ok: schema.scans.ok })
    .from(schema.scans)
    .where(eq(schema.scans.orgId, orgId))
    .orderBy(desc(schema.scans.ranAt))

  // Newest first, so the first scan seen per company is its latest.
  const latest = new Map<string, (typeof scans)[number]>()
  for (const s of scans) if (!latest.has(s.companyId)) latest.set(s.companyId, s)
  if (latest.size === 0) return []

  const scanIds = [...latest.values()].map((s) => s.id)
  const findingRows = await db
    .select({
      scanId: schema.findings.scanId,
      signalKey: schema.findings.signalKey,
      observed: schema.findings.observed,
      gap: schema.findings.gap,
      scored: schema.findings.scored,
      weight: schema.findings.weight,
      detail: schema.findings.detail,
      evidence: schema.findings.evidence,
    })
    .from(schema.findings)
    .where(and(eq(schema.findings.orgId, orgId), inArray(schema.findings.scanId, scanIds)))
    .orderBy(schema.findings.signalKey)

  const byScan = new Map<string, ExportsFinding[]>()
  for (const { scanId, ...f } of findingRows) {
    const list = byScan.get(scanId)
    if (list) list.push(f)
    else byScan.set(scanId, [f])
  }

  const out: ExportsLatestScanFindings[] = []
  for (const c of companies) {
    const scan = latest.get(c.id)
    if (!scan) continue
    out.push({
      company: { id: c.id, domain: c.domain, name: c.name },
      scan: { id: scan.id, ranAt: scan.ranAt, ok: scan.ok },
      findings: byScan.get(scan.id) ?? [],
    })
  }
  return out
}

/** One contact × one channel of the consent ledger. */
export interface ExportsConsentLedgerRow {
  readonly contactId: string
  readonly email: string | null
  /** Null only if the contact's company is not this org's — which the schema does not rule out. */
  readonly companyDomain: string | null
  readonly channel: ConsentChannel
  /**
   * Three states, because "nobody asked" and "they said no" are different
   * facts (§2.1). `never_asked` is synthesised for a missing row — absence
   * is NO, and the file says which kind of no it is.
   */
  readonly state: 'granted' | 'refused' | 'never_asked'
  readonly source: string | null
  readonly recordedAt: Date | null
}

/**
 * The consent ledger as a table: every contact in the org, one row for each
 * of the four consent channels, in the order `CONSENT_CHANNELS` gives.
 *
 * This is the shape a data-subject request asks for — what did you record
 * about me, where did it come from, and when — so a channel with no row is
 * written as `never_asked` rather than left out. Omitting it would make the
 * file look like the ledger has nothing to say about that channel, when what
 * it says is "no".
 *
 * The join to `companies` re-checks the org for the same reason
 * `exportsOpenDealStages` does. The consents read is org-scoped, and only
 * this org's contacts are iterated, so a consent row can reach the file only
 * through a contact that is this org's.
 */
export async function exportsConsentLedgerRows(db: AgencyDb, orgId: string): Promise<ExportsConsentLedgerRow[]> {
  const contacts = await db
    .select({ id: schema.contacts.id, email: schema.contacts.email, companyDomain: schema.companies.domain })
    .from(schema.contacts)
    .leftJoin(
      schema.companies,
      and(eq(schema.companies.id, schema.contacts.companyId), eq(schema.companies.orgId, orgId)),
    )
    .where(eq(schema.contacts.orgId, orgId))
    .orderBy(schema.companies.domain, schema.contacts.email, schema.contacts.id)
  if (contacts.length === 0) return []

  const consentRows = await db
    .select({
      contactId: schema.consents.contactId,
      channel: schema.consents.channel,
      granted: schema.consents.granted,
      source: schema.consents.source,
      recordedAt: schema.consents.recordedAt,
    })
    .from(schema.consents)
    .where(eq(schema.consents.orgId, orgId))

  // `UNIQUE (contact_id, channel)` makes this key exact.
  const recorded = new Map<string, (typeof consentRows)[number]>()
  for (const r of consentRows) recorded.set(`${r.contactId} ${r.channel}`, r)

  const out: ExportsConsentLedgerRow[] = []
  for (const c of contacts) {
    for (const channel of CONSENT_CHANNELS) {
      const row = recorded.get(`${c.id} ${channel}`)
      out.push({
        contactId: c.id,
        email: c.email,
        companyDomain: c.companyDomain,
        channel,
        state: row === undefined ? 'never_asked' : row.granted ? 'granted' : 'refused',
        source: row?.source ?? null,
        recordedAt: row?.recordedAt ?? null,
      })
    }
  }
  return out
}
