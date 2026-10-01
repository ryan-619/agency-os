import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, exportsConsentLedgerRows, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import {
  CONSENTS_COLUMNS, EXPORT_ROW_CAP, consentsCsvRows, exportFile, exportHeaders, tooManyRowsMessage,
} from '@/lib/csv'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * The consent ledger as CSV: every contact, one row per channel, with what
 * was recorded, where it came from and when.
 *
 * This is the shape a data-subject request asks for, so a channel with no
 * row is written `never_asked` rather than left out (§2.1: absence is NO, and
 * "nobody asked" is a different no from "they said no"). Gated on
 * `contacts:read`, not `companies:read`: it names people, not companies.
 *
 * Audited before the file is produced, like the other two exports.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

export async function GET(): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:read')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = getDb() as unknown as AgencyDb
  const ledger = await exportsConsentLedgerRows(db, user.orgId)
  if (ledger.length > EXPORT_ROW_CAP) {
    return NextResponse.json({ error: tooManyRowsMessage(ledger.length) }, { status: 413 })
  }

  try {
    await appendAudit(db, {
      orgId: user.orgId,
      actor: user.id,
      action: 'export.consents',
      detail: { rows: ledger.length, filters: {} },
    })
  } catch (err) {
    log.error('export not recorded', { view: 'consents', err: err instanceof Error ? err.name : 'unknown' })
    return NextResponse.json(
      { error: 'The export could not be recorded in the audit log, so it was not produced. Try again.' },
      { status: 503 },
    )
  }

  const now = new Date()
  return new Response(exportFile(CONSENTS_COLUMNS, consentsCsvRows(ledger)), {
    status: 200,
    headers: exportHeaders('consents', now),
  })
}
