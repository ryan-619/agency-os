import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { previewSend, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { maskRecipient, maskSuppressionKey } from '@/lib/consent-view'

/**
 * "Why can't I reach them?" — the send path's answer for one person under
 * one campaign, right now (§2.1, §8.4).
 *
 * A dry run. `previewSend` gathers the facts through the sender's own
 * `sendFactsFor` and asks the sender's own `decideSend`, and writes nothing:
 * no touch, no claim, no refusal, no audit row. Asking is not sending, and a
 * question that left a row behind would be counted by the next question.
 *
 * The answer carries the decision and the facts it was made from, with the
 * recipient masked to its domain — the page already shows the person's
 * addresses from its own read, and this response has no reason to carry
 * them again. Another org's contact or campaign is a 404, not a 403: its
 * existence is not this caller's to learn.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:read')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  const campaignId = new URL(request.url).searchParams.get('campaignId') ?? ''
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such contact.' }, { status: 404 })
  if (!UUID.test(campaignId)) {
    return NextResponse.json({ error: 'Choose a campaign — its cap and quiet hours are part of the answer.' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const preview = await previewSend(db, { orgId: user.orgId, contactId: id, campaignId, now: new Date() })
  if (!preview.ok) return NextResponse.json({ error: preview.message, reason: preview.reason }, { status: 404 })

  const { decision, wouldNeedApproval, facts } = preview
  return NextResponse.json({
    decision,
    wouldNeedApproval,
    facts: {
      ...facts,
      recipient: maskRecipient(facts.recipient),
      suppressionKeys: facts.suppressionKeys === null ? null : facts.suppressionKeys.map(maskSuppressionKey),
    },
  })
}
