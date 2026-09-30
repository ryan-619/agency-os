import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { activeIcpProfile, appendAudit, exportsFindingsForLatestScans, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { readIcp } from '@/lib/company-list'
import {
  EXPORT_ROW_CAP, FINDINGS_COLUMNS, exportFile, exportHeaders, findingsCsvRows, tooManyRowsMessage,
} from '@/lib/csv'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Every finding of every company's LATEST scan, as CSV.
 *
 * §2.2 governs this file harder than the other two, because it is the one a
 * person will pivot: `gap` and `weight` are EMPTY for a signal the scanner
 * could not observe — a blank a spreadsheet can count as unknown, where a
 * "no" or a 0 would be counted as a fact nobody observed. `stale` is written
 * on every row from the scan's own `ran_at` against the ICP's threshold,
 * never from `findings.stale` (which the query does not even return).
 *
 * Audited before the file is produced, like the companies export; an export
 * whose record cannot be written is refused.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

export async function GET(): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'companies:read')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = getDb() as unknown as AgencyDb
  const [groups, icpRow] = await Promise.all([
    exportsFindingsForLatestScans(db, user.orgId),
    activeIcpProfile(db, user.orgId),
  ])

  const now = new Date()
  const rows = findingsCsvRows(groups, { staleAfterDays: readIcp(icpRow?.definition).staleAfterDays, now })
  if (rows.length > EXPORT_ROW_CAP) {
    return NextResponse.json({ error: tooManyRowsMessage(rows.length) }, { status: 413 })
  }

  try {
    await appendAudit(db, {
      orgId: user.orgId,
      actor: user.id,
      action: 'export.findings',
      detail: { rows: rows.length, filters: {} },
    })
  } catch (err) {
    log.error('export not recorded', { view: 'findings', err: err instanceof Error ? err.name : 'unknown' })
    return NextResponse.json(
      { error: 'The export could not be recorded in the audit log, so it was not produced. Try again.' },
      { status: 503 },
    )
  }

  return new Response(exportFile(FINDINGS_COLUMNS, rows), {
    status: 200,
    headers: exportHeaders('findings', now),
  })
}
