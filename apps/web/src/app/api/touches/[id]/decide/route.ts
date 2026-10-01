import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { approveDraft, denyDraft, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * A person decides on a message draft (PROMPT.md §2.4, §8.4).
 *
 * The other approval route, `/api/approvals/[id]/decide`, answers the agent's
 * TOOL-CALL gate — a turn parked on `canUseTool`. This answers a DRAFT: a
 * `touches` row the agent (or a person) wrote, which may be days old and has
 * no turn left to trace it to.
 *
 * Approving names three things the draft did not have: the recipient, the
 * campaign, and the approver. The first two are chosen HERE, by the person
 * reading the draft, because the agent had no contacts to address it to and
 * the campaign is where the cap and the quiet hours live.
 *
 * Approving does not send. The row becomes `approved`, and the worker's next
 * tick runs it through every §2.1 rule and then the provider. The person
 * approved the words, and the rules are checked at the moment of sending.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'approvals:decide')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { decision, contactId, campaignId, note } = (body ?? {}) as {
    decision?: unknown
    contactId?: unknown
    campaignId?: unknown
    note?: unknown
  }
  const noteText = typeof note === 'string' ? note.slice(0, 500) : null
  const db = getDb() as unknown as AgencyDb

  if (decision === 'denied') {
    const r = await denyDraft(db, { orgId: user.orgId, touchId: id, decidedBy: user.id, note: noteText })
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === 'not_found' ? 404 : 409 })
    return NextResponse.json({ status: 'refused' })
  }

  if (decision !== 'approved') {
    return NextResponse.json({ error: 'decision must be approved or denied' }, { status: 400 })
  }
  if (typeof contactId !== 'string' || !contactId) {
    return NextResponse.json({ error: 'Choose who this goes to.' }, { status: 400 })
  }
  if (typeof campaignId !== 'string' || !campaignId) {
    return NextResponse.json({ error: 'Choose the campaign it goes out under.' }, { status: 400 })
  }

  const r = await approveDraft(db, {
    orgId: user.orgId,
    touchId: id,
    contactId,
    campaignId,
    approvedBy: user.id,
    note: noteText,
  })
  if (!r.ok) {
    const messages: Record<typeof r.reason, [string, number]> = {
      not_found: ['That draft no longer exists.', 404],
      already_decided: ['Someone already decided this.', 409],
      no_such_contact: ['That contact is not in the CRM.', 400],
      no_such_campaign: ['That campaign does not exist.', 400],
      wrong_company: [
        'That person is at a different company from the one this draft is about. A draft quotes ' +
          'one company’s findings and cannot be sent to another.',
        400,
      ],
      wrong_channel: [
        'That campaign is for a different channel from this draft. A message written for one medium ' +
          'is not sent through another; choose a campaign on the same channel.',
        400,
      ],
      rendered_for_another: [
        'This message was written for one person — its registered template was filled in with their details — so ' +
          'it can be approved only to them. To reach somebody else, draft one for them (an SMS: Draft SMS on /contacts).',
        400,
      ],
    }
    const [message, status] = messages[r.reason]
    return NextResponse.json({ error: message, reason: r.reason }, { status })
  }
  return NextResponse.json({ status: 'approved', touchId: r.touch.id })
}
