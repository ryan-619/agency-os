import { NextResponse } from 'next/server'
import { assertCan, can } from '@agency/core'
import { appendAudit, campaignEditInput, readCampaign, updateCampaign, type AgencyDb, type CampaignUpdate } from '@agency/db/queries'
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
 *
 * Two saves are refused with a 409 sentence rather than written (review
 * round 3, findings 2 and 13): one built on a status that changed since the
 * form loaded it — the worker pauses a campaign whose addresses bounce, and
 * a save that changed only the cap used to re-activate it — and a channel
 * switch while messages written for the old channel are still waiting.
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
  const parsed = campaignEditInput.safeParse(body)
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
  // on. An owner is not gated, so nothing is checked for them. The status
  // the FORM loaded goes in the predicate too, for everybody.
  const mayToggle = can(principal, 'campaigns:set_auto_send')
  const { expectStatus, ...input } = parsed.data
  const saved = await updateCampaign(db, user.orgId, id, input, {
    autoSend: mayToggle ? null : current.autoSend,
    status: expectStatus ?? null,
  })
  if (!saved.ok) {
    if (saved.reason === 'not_found') return NextResponse.json({ error: 'No such campaign.' }, { status: 404 })
    return NextResponse.json({ error: refusedSave(saved) }, { status: 409 })
  }
  const updated = saved.row

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

/** The 409's sentence: what changed or waits, and that nothing was saved. */
function refusedSave(saved: Exclude<CampaignUpdate, { ok: true } | { reason: 'not_found' }>): string {
  switch (saved.reason) {
    case 'auto_send_changed':
      return 'Someone changed this campaign’s auto-send while you were editing. Reload and try again; nothing was saved.'
    case 'status_changed':
      return (
        `This campaign was set to ${saved.status} while you were editing` +
        (saved.status === 'paused'
          ? ' (the worker pauses a campaign whose addresses bounce, and this page says when it did)'
          : '') +
        '. Nothing was saved: reload to see it as it is now, then save again if it should change.'
      )
    case 'channel_has_live_messages':
      return (
        `${saved.live} ${saved.live === 1 ? 'message' : 'messages'} written for ${saved.channel === 'linkedin' ? 'LinkedIn' : saved.channel} ` +
        `${saved.live === 1 ? 'is' : 'are'} still waiting in this campaign (awaiting approval, approved, queued or sending), so ` +
        'its channel cannot change: each was written for that medium. It can change once none are waiting; to write on ' +
        'the other channel now, create a new campaign for it. Nothing was saved.'
      )
    case 'changed':
      return 'This campaign changed while you were editing. Reload and try again; nothing was saved.'
  }
}
