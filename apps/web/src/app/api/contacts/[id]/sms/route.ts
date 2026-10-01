import { NextResponse } from 'next/server'
import { assertCan, normalisePhone, renderTemplate } from '@agency/core'
import { previewSend, readCampaign, readContact, smsDraft, templatesList, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { deployment, nothingWillSendNote } from '@/lib/deployment'
import {
  NO_PHONE, SMS_MAX_REQUEST_BYTES, smsCheckAnswer, smsDraftAnswer, smsDraftSchema, smsRenderAnswer,
} from './outcome'

/**
 * Draft one SMS to one contact, from a registered template (0019) — the
 * composer's "Draft SMS" on /contacts.
 *
 * Nothing is sent from here. `smsDraft` renders the template with the
 * values given, puts the exact words to the send path's own dry run
 * (`previewSend`) and, unless that answers a refusal nobody may approve past,
 * parks an `awaiting_approval` row for a person on /approvals. The worker
 * sends it only after approval, through `dispatchTouch`, which runs every
 * rule again — the template included — at that moment.
 *
 * `dryRun: true` asks the question without writing: the rendered words and
 * the send path's decision about them, for the composer to show before
 * anybody presses Draft. It runs the same steps in the same order, so the
 * answer it gives is the answer `smsDraft` would act on.
 *
 * Gated as answering a reply is (`campaigns:write`): a draft is a message
 * a person will be asked to approve. Another org's contact, campaign or
 * template is a 404, never a 403.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'campaigns:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such contact.' }, { status: 404 })

  const raw = await request.text()
  if (raw.length > SMS_MAX_REQUEST_BYTES) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = smsDraftSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That request could not be read.' }, { status: 400 })
  }
  const input = parsed.data
  const db = getDb() as unknown as AgencyDb
  const now = new Date()

  if (!input.dryRun) {
    const outcome = await smsDraft(db, {
      orgId: user.orgId,
      contactId: id,
      campaignId: input.campaignId,
      templateId: input.templateId,
      vars: input.vars,
      createdBy: user.id,
      now,
    })
    const answer = smsDraftAnswer(outcome, nothingWillSendNote(deployment()))
    return NextResponse.json(answer.body, { status: answer.status })
  }

  // The dry run: `smsDraft`'s own checks, in its order, writing nothing.
  const contact = await readContact(db, user.orgId, id)
  if (!contact) return NextResponse.json({ error: 'That contact is not in this org.' }, { status: 404 })
  if (!contact.phone || !normalisePhone(contact.phone)) return NextResponse.json({ error: NO_PHONE }, { status: 409 })
  const campaign = await readCampaign(db, user.orgId, input.campaignId)
  if (!campaign) return NextResponse.json({ error: 'That campaign is not in this org.' }, { status: 404 })
  if (campaign.channel !== 'sms') {
    return NextResponse.json(
      { error: `That is a ${campaign.channel} campaign. An SMS goes under an SMS campaign, where its cap and quiet hours live.` },
      { status: 400 },
    )
  }
  const template = (await templatesList(db, user.orgId, { channel: 'sms' })).find((t) => t.id === input.templateId)
  if (!template) return NextResponse.json({ error: 'That is not an SMS template of this org.' }, { status: 404 })
  if (!template.active) return NextResponse.json({ error: 'That template has been switched off. Draft from an active one.' }, { status: 409 })

  const rendered = renderTemplate(template.body, input.vars)
  if (!rendered.ok) {
    const answer = smsRenderAnswer(rendered)
    return NextResponse.json(answer.body, { status: answer.status })
  }
  const preview = await previewSend(db, {
    orgId: user.orgId,
    contactId: id,
    campaignId: campaign.id,
    now,
    writtenAt: now,
    words: { templateId: template.id, body: rendered.text },
  })
  if (!preview.ok) {
    return NextResponse.json({ error: preview.message, reason: preview.reason }, { status: preview.reason === 'missing' ? 409 : 404 })
  }
  const answer = smsCheckAnswer({ decision: preview.decision, wouldNeedApproval: preview.wouldNeedApproval, body: rendered.text })
  return NextResponse.json(answer.body, { status: answer.status })
}
