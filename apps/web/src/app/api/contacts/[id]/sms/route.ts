import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import type { AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { deployment, nothingWillSendNote } from '@/lib/deployment'
import { log } from '@/lib/logger'
import { SMS_MAX_REQUEST_BYTES, smsComposerAnswer, smsDraftSchema } from './outcome'

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
 * `dryRun: true` asks the question without writing: `smsDraft` itself with
 * its `dryRun` option, which runs every one of its checks in its own order —
 * the campaign's status and an SMS already waiting included — and stops
 * before the insert. So Check cannot offer a Draft that then answers 409.
 * Both go through `smsComposerAnswer` (`./outcome.ts`), which also catches a
 * database fault: drizzle's error quotes the number and the words, and a
 * fault that escaped here was logged whole.
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

  const answer = await smsComposerAnswer(
    getDb() as unknown as AgencyDb,
    {
      orgId: user.orgId,
      contactId: id,
      createdBy: user.id,
      input: parsed.data,
      now: new Date(),
      nothingWillSend: nothingWillSendNote(deployment()),
    },
    log,
  )
  return NextResponse.json(answer.body, { status: answer.status })
}
