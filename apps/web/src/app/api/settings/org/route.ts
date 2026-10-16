import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import { renameOrg, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Rename the organisation (Settings → Organisation). Owners only — the
 * capability that manages the team (`users:write`), because the name is the
 * agency's to everyone it writes to: every opener's sign-off, "Prepared by"
 * on every proposal, the booking page, the sidebar. `renameOrg` audits it
 * (`org.renamed { from, to }`) in the same transaction.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_BODY_BYTES = 2_000

export async function PATCH(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'users:write')) {
    return NextResponse.json({ error: 'Only an owner can rename the organisation.' }, { status: 403 })
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'That name is far too long.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const name = (body as { name?: unknown } | null)?.name
  try {
    const outcome = await renameOrg(getDb() as unknown as AgencyDb, { orgId: user.orgId, name, actor: user.id })
    if (outcome.ok) return NextResponse.json({ name: outcome.name, changed: outcome.changed })
    const status = outcome.reason === 'taken' ? 409 : outcome.reason === 'not_found' ? 404 : 400
    return NextResponse.json({ error: outcome.message }, { status })
  } catch (err) {
    // The class only: a driver's message quotes the bound parameters.
    log.error('organisation rename failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The name could not be saved. Nothing changed; try again.' }, { status: 500 })
  }
}
