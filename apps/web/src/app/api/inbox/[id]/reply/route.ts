import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertCan } from '@agency/core'
import { replyQueueDraft, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { deployment, nothingWillSendNote } from '@/lib/deployment'
import {
  ANSWER_DRAFTED_NOTE, ANSWER_OPTED_OUT_ERROR, ANSWER_REFUSAL_STATUS, INBOX_MAX_REQUEST_BYTES,
  answerSchema, firstIssue,
} from '@/lib/inbox-view'

/**
 * Answer a reply — as a draft a person approves (PROMPT.md §2.4, §8.4).
 *
 * Nothing is sent from here. `replyQueueDraft` parks an `awaiting_approval`
 * OUTBOUND row naming the reply in `answers_touch_id`; a person approves it
 * on /approvals, and the worker's `dispatchTouch` re-runs every §2.1 rule at
 * the moment of sending and threads it under their message (In-Reply-To from
 * the reply's Message-ID).
 *
 * Drafting RESUMES the person, because their reply paused them in every
 * campaign and an approved answer to a paused person is refused. That is a
 * person's decision and it is audited as one. It is never made for somebody
 * who asked to stop: an opted-out reply, a suppressed address or a recorded
 * refusal of the channel is a 409 and the pause stays exactly where it was.
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
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'campaigns:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'That reply is not in this inbox.' }, { status: 404 })

  const raw = await request.text()
  if (raw.length > INBOX_MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = answerSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 })

  const db = getDb() as unknown as AgencyDb
  const r = await replyQueueDraft(db, {
    orgId: user.orgId,
    inboundTouchId: id,
    subject: parsed.data.subject,
    body: parsed.data.body,
    campaignId: parsed.data.campaignId ?? null,
    actor: user.id,
  })
  if (!r.ok) {
    const error = r.reason === 'opted_out' ? ANSWER_OPTED_OUT_ERROR : r.message
    return NextResponse.json({ error, reason: r.reason }, { status: ANSWER_REFUSAL_STATUS[r.reason] })
  }

  return NextResponse.json(
    {
      touchId: r.touchId,
      resumed: r.resumed,
      wouldHold: r.wouldHold,
      note: ANSWER_DRAFTED_NOTE,
      // A deployment with no worker drains nothing. Said here, beside the
      // draft, rather than letting "approve it" read as "it will go".
      deployment: nothingWillSendNote(deployment()),
    },
    { status: 201 },
  )
}
