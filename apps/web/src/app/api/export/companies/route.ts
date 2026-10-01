import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  activeIcpProfile, appendAudit, companyList, exportsOpenDealStages, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { applyCompanyQuery, companyQueryFilters, parseCompanyQuery, readIcp } from '@/lib/company-list'
import {
  COMPANIES_COLUMNS, EXPORT_ROW_CAP, companiesCsvRows, exportFile, exportHeaders, tooManyRowsMessage,
} from '@/lib/csv'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * The companies list as CSV — the SAME rows the page shows for the same query
 * string, because both go through `applyCompanyQuery`. An unscanned company's
 * score is empty, not 0; `stale` is derived from the latest scan's `ran_at`
 * against the ICP's threshold, never read from `findings.stale`.
 *
 * Lead data leaving the database is recorded (§2.3, §5.5): one audit row,
 * written BEFORE the file is produced, and an export whose audit row cannot be
 * written is not produced at all. A read that silently skipped its record
 * would be the one export nobody could account for.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

export async function GET(request: Request): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'companies:read')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = getDb() as unknown as AgencyDb
  const [list, openDeals, icpRow] = await Promise.all([
    companyList(db, user.orgId),
    exportsOpenDealStages(db, user.orgId),
    activeIcpProfile(db, user.orgId),
  ])

  // An unreadable ICP must not make the export a 500; the threshold falls
  // back to the documented default, as the page does and says.
  const clock = { staleAfterDays: readIcp(icpRow?.definition).staleAfterDays, now: new Date() }
  const query = parseCompanyQuery(new URL(request.url).searchParams)
  const rows = applyCompanyQuery(
    list.map((r) => ({ ...r, openDealStage: openDeals.get(r.companyId) ?? null })),
    query,
    clock,
  )
  if (rows.length > EXPORT_ROW_CAP) {
    return NextResponse.json({ error: tooManyRowsMessage(rows.length) }, { status: 413 })
  }

  try {
    await appendAudit(db, {
      orgId: user.orgId,
      actor: user.id,
      action: 'export.companies',
      detail: { rows: rows.length, filters: companyQueryFilters(query) },
    })
  } catch (err) {
    // The name only: a driver message can carry the DSN.
    log.error('export not recorded', { view: 'companies', err: err instanceof Error ? err.name : 'unknown' })
    return NextResponse.json(
      { error: 'The export could not be recorded in the audit log, so it was not produced. Try again.' },
      { status: 503 },
    )
  }

  return new Response(exportFile(COMPANIES_COLUMNS, companiesCsvRows(rows, clock)), {
    status: 200,
    headers: exportHeaders('companies', clock.now),
  })
}
