import { NextResponse } from 'next/server'
import { assertCan, can } from '@agency/core'
import { appendAudit, campaignInput, readCampaign, updateCampaign, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Edit a campaign (PROMPT.md §8.4).
 *
 * Turning auto-send ON is the consequential edit and it is owner-only
 * (§2.4). Turning it OFF is not gated: it is what a person reaches for when
 * a campaign is doing something they do not want, and a stop with
 * preconditions is not a stop.
 *
 * Edits take effect on the next message. The send path reads the campaign's
 * cap, quiet hours and auto-send from the row on every dispatch, so nothing
 * here needs to restart anything — and nothing here can be used to slip a
 * message past a rule, because the rules are not here.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  try {
    assertCan(principal, 'campaigns:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  const db = getDb() as unknown as AgencyDb
  const current = await readCampaign(db, user.orgId, id)
  if (!current) return NextResponse.json({ error: 'No such campaign.' }, { status: 404 })

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

  // ON needs an owner. OFF, or already on and staying on, does not.
  if (parsed.data.autoSend && !current.autoSend) {
    try {
      assertCan(principal, 'campaigns:set_auto_send')
    } catch {
      return NextResponse.json(
        { error: 'Only an owner can turn auto-send on.' },
        { status: 403 },
      )
    }
  }

  // A caller who may not switch auto-send on writes with `current.autoSend`
  // in the predicate: if an owner turned it off between this caller's read
  // and their save, the UPDATE matches nothing rather than turning it back
  // on. An owner is not gated, so nothing is checked for them.
  const mayToggle = can(principal, 'campaigns:set_auto_send')
  const updated = await updateCampaign(db, user.orgId, id, parsed.data, mayToggle ? null : current.autoSend)
  if (!updated) {
    const still = await readCampaign(db, user.orgId, id)
    if (!still) return NextResponse.json({ error: 'No such campaign.' }, { status: 404 })
    return NextResponse.json(
      { error: 'Someone changed this campaign’s auto-send while you were editing. Reload and try again.' },
      { status: 409 },
    )
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action:
      parsed.data.autoSend !== current.autoSend
        ? parsed.data.autoSend
          ? 'campaign.auto_send_on'
          : 'campaign.auto_send_off'
        : 'campaign.updated',
    subjectType: 'campaign',
    subjectId: id,
    detail: {
      name: updated.name,
      channel: updated.channel,
      autoSend: updated.autoSend,
      dailyCap: updated.dailyCap,
      status: updated.status,
    },
  }).catch(() => {})
  return NextResponse.json({ id, autoSend: updated.autoSend, status: updated.status })
}
