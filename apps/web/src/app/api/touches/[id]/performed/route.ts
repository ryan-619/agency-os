import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { linkedinFinishStep, linkedinPerformStep, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { refusalWords } from '@/lib/refusal-words'

/**
 * A person performs a LinkedIn step (§2.1, §8.4).
 *
 * LinkedIn has no automated provider; the provider is the person pressing
 * the button. This route is not a second sender: `start` runs the message
 * through `dispatchTouch`, the one send path, with that person as the
 * provider — every §2.1 rule is checked at that moment, and the words come
 * back in the response ONLY when they all pass. A refusal or a deferral hands
 * over nothing, so there is nothing to send against a row the rules stopped.
 *
 *   start      claim, run the rules, hand over the words (or say why not)
 *   sent       "I sent it" — the person handed the words sent them
 *   not_sent   "I did not send it" — they were handed and it did not go
 *   dismiss    close a step the rules stopped, once somebody has read why
 *
 * The claim and the settle happen in this one request. A request that dies
 * between them leaves the row `sending`, and the step list marks it failed
 * when it is next read — no worker is needed, which is what lets this work
 * on the worker-less deployment. Nothing here logs the words or the profile.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f-]{36}$/i
const ACTIONS = ['start', 'sent', 'not_sent', 'dismiss'] as const
type Action = (typeof ACTIONS)[number]

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
  if (!UUID.test(id)) return NextResponse.json({ error: 'That message is not in the CRM.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { action } = (body ?? {}) as { action?: unknown }
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 })
  }
  const db = getDb() as unknown as AgencyDb

  if ((action as Action) === 'start') {
    const r = await linkedinPerformStep(db, { orgId: user.orgId, touchId: id, userId: user.id })
    if (!r.ok) {
      return NextResponse.json({ error: r.message, reason: r.reason }, { status: r.reason === 'not_found' ? 404 : 409 })
    }
    switch (r.status) {
      case 'sent':
        return NextResponse.json({ status: 'sent', words: r.words })
      case 'deferred':
        return NextResponse.json({
          status: 'deferred',
          code: r.code,
          label: refusalWords(r.code),
          reason: r.reason,
          until: r.until.toISOString(),
        })
      case 'refused':
        return NextResponse.json({ status: 'refused', code: r.code, label: refusalWords(r.code), reason: r.reason })
    }
  }

  const outcome = action === 'dismiss' ? 'dismissed' : (action as 'sent' | 'not_sent')
  const r = await linkedinFinishStep(db, { orgId: user.orgId, touchId: id, userId: user.id, outcome })
  if (!r.ok) {
    return NextResponse.json({ error: r.message, reason: r.reason }, { status: r.reason === 'not_found' ? 404 : 409 })
  }
  return NextResponse.json({ status: 'done', outcome, alreadyDone: r.alreadyDone })
}
