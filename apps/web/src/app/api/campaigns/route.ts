import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { appendAudit, campaignInput, createCampaign, isUniqueViolation, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Create a campaign (PROMPT.md §8.4).
 *
 * The one field with a rule of its own is `autoSend`. §2.4 makes it the
 * switch that lets mail leave the building without a per-message human, and
 * `campaigns:set_auto_send` is owner-only — so a member may create a campaign
 * but not one that sends by itself. The check is here, not on the form:
 * hiding a toggle is not access control.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  try {
    assertCan(principal, 'campaigns:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = campaignInput.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: `${first?.path.join('.') ?? 'input'}: ${first?.message ?? 'Invalid.'}` },
      { status: 400 },
    )
  }

  if (parsed.data.autoSend) {
    try {
      assertCan(principal, 'campaigns:set_auto_send')
    } catch {
      return NextResponse.json(
        { error: 'Only an owner can turn auto-send on. Save it off, and ask an owner.' },
        { status: 403 },
      )
    }
  }

  const db = getDb() as unknown as AgencyDb
  let row
  try {
    row = await createCampaign(db, user.orgId, parsed.data)
  } catch (err) {
    // Only a duplicate name is the person's to fix; every other fault read as
    // one before, which sent them to rename a campaign that did not exist.
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: `A campaign called "${parsed.data.name}" already exists.` }, { status: 409 })
    }
    log.error('campaign create failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The campaign could not be created. Nothing was saved; try again.' }, { status: 500 })
  }
  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'campaign.created',
    subjectType: 'campaign',
    subjectId: row.id,
    detail: { name: row.name, channel: row.channel, autoSend: row.autoSend, dailyCap: row.dailyCap },
  }).catch(() => {})
  return NextResponse.json({ id: row.id }, { status: 201 })
}
