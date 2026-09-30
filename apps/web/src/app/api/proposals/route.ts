import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { generateProposal, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Generate a proposal from a company's findings (PROMPT.md §8.6).
 *
 * The scope is derived from the latest scan — nothing is typed in here but
 * the day rate. The generator refuses when there is nothing honest to write
 * from (no scan, an unreachable site, a stale scan, a scan scored under a
 * different ICP profile — `rescore` — or no gaps), and the refusal comes back
 * as the sentence to show, with the reason code so the UI can offer the fix
 * (re-scan) rather than a dead end.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { companyId, dayRate, currency } = (body ?? {}) as { companyId?: unknown; dayRate?: unknown; currency?: unknown }
  if (typeof companyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }
  if (dayRate !== undefined && dayRate !== null && (typeof dayRate !== 'number' || !Number.isFinite(dayRate) || dayRate <= 0)) {
    return NextResponse.json({ error: 'dayRate must be a positive number, or left out' }, { status: 400 })
  }
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    return NextResponse.json({ error: 'currency must be a three-letter code like USD' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const r = await generateProposal(db, {
    orgId: user.orgId,
    companyId,
    createdBy: user.id,
    actor: user.id,
    dayRate: typeof dayRate === 'number' ? dayRate : null,
    currency: typeof currency === 'string' ? currency : 'USD',
  })
  if (!r.ok) return NextResponse.json({ error: r.message, reason: r.reason }, { status: 409 })
  return NextResponse.json({ id: r.proposal.id, title: r.proposal.title }, { status: 201 })
}
