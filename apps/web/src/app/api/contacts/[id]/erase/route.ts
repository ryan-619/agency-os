import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { erasureErase, type AgencyDb, type ErasureOutcome } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { notify } from '@/lib/slack'

/**
 * Erase a person — and keep the suppression (§2.1).
 *
 * `erasureErase` does it in one transaction: their address, number and
 * profile go on the suppression list FIRST, then their words, addresses and
 * numbers are scrubbed from the log, notes and tasks about them are deleted,
 * and the contact row goes (consents with it). A key that cannot be stored
 * aborts the lot, so an erasure can never be the thing that lets a person
 * who asked to be left alone be contacted again after a re-import.
 *
 * ## Who may
 *
 * Owners only (`users:write`) — the only gate this product has for an act
 * that cannot be undone. And only with the contact's id typed back in the
 * body as `{ confirm: '<id>' }`: a stray click, or a replayed request for a
 * different row, erases nobody.
 *
 * ## When it fails
 *
 * Loudly, as `/api/unsubscribe` does. By the time `erasureErase` answers
 * `suppression_failed` it has rolled everything back, paused the contact,
 * written `contact.erasure_failed` and logged `OPT-OUT NOT RECORDED` at
 * error. This route adds the Slack notification — AWAITED, not scheduled
 * with `after()`: it is the failure path, and a host without `waitUntil`
 * would drop a scheduled post silently — and answers 500 with a sentence
 * that says what to fix. The event names the person's most recent message
 * because its shape requires one; a person with no messages at all is not
 * notified, and the log line and the audit row are the alarm.
 *
 * The response carries counts, reason classes and call SIDs — never an
 * address, a number or a word they wrote (§2.3).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY = 1024

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'users:write')
  } catch {
    return NextResponse.json({ error: 'Only an owner can erase a contact.' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such contact.' }, { status: 404 })

  const raw = await request.text().catch(() => '')
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const confirm = (body as { confirm?: unknown } | null)?.confirm
  if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== id.toLowerCase()) {
    return NextResponse.json(
      { error: 'Type the contact’s id exactly to confirm. Nothing was erased.' },
      { status: 400 },
    )
  }

  let outcome: ErasureOutcome
  try {
    outcome = await erasureErase(getDb() as unknown as AgencyDb, {
      orgId: user.orgId,
      contactId: id.toLowerCase(),
      actor: user.id,
      log: { error: (message, fields) => log.error(message, fields ? { ...fields } : undefined) },
    })
  } catch (err) {
    // `erasureErase` never throws; `getDb()` can, on a deployment with no
    // database configured. Nothing was erased, and nothing was recorded.
    log.error('OPT-OUT NOT RECORDED — an erasure could not start; nothing was erased', {
      path: 'erasure',
      contactId: id,
      why: err instanceof Error ? err.name : 'UnknownError',
    })
    return NextResponse.json(
      { error: 'The erasure could not start, so nothing was erased and nothing was suppressed. Try again.' },
      { status: 500 },
    )
  }

  if (outcome.ok) {
    log.info('contact erased', {
      contactId: id,
      touchesScrubbed: outcome.touchesScrubbed,
      callsScrubbed: outcome.callsScrubbed,
      suppressionsAdded: outcome.suppressionsAdded,
    })
    return NextResponse.json({
      erased: true,
      touchesScrubbed: outcome.touchesScrubbed,
      callsScrubbed: outcome.callsScrubbed,
      suppressionsAdded: outcome.suppressionsAdded,
      suppressionsNew: outcome.suppressionsNew,
      meetingsScrubbed: outcome.meetingsScrubbed,
      notesDeleted: outcome.notesDeleted,
      tasksDeleted: outcome.tasksDeleted,
      cancelled: outcome.cancelled,
      companyRenamed: outcome.companyRenamed,
      skipped: outcome.skipped,
      recordingsAtCarrier: outcome.recordingsAtCarrier,
    })
  }
  if (outcome.reason === 'not_found') return NextResponse.json({ error: outcome.message }, { status: 404 })

  if (outcome.latestTouchId) {
    await notify({
      kind: 'opt_out_not_recorded',
      orgId: user.orgId,
      touchId: outcome.latestTouchId,
      contactId: id,
      path: 'erasure',
    })
  } else {
    log.warn('erasure failure not sent to Slack: the person has no message for the event to name', { contactId: id })
  }
  return NextResponse.json(
    { error: outcome.message, reason: outcome.reason, why: outcome.why, paused: outcome.paused },
    { status: 500 },
  )
}
