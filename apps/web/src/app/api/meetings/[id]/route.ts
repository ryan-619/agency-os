import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import {
  cancelMeeting, readMeeting, rescheduleMeeting, setMeetingOutcome, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { wallClockToInstant } from '@/lib/wall-clock'

/**
 * What happened to a meeting (PROMPT.md §8.6): it was held, they did not turn
 * up, it moved to another time, or it was called off.
 *
 * None of it tells anybody anything. No invitation was sent from here, so
 * cancelling withdraws none and rescheduling sends none — a person who sent
 * one from their calendar changes it there, and every response says so.
 * A no-show does not move the deal: it is not a lost deal, and writing it as
 * one would be the product deciding something nobody decided.
 *
 * The rules live in `packages/db/src/meetings.ts`, where one UPDATE decides
 * each write; this route only validates the body and turns a refusal into a
 * status and a sentence — 404 for a meeting this org does not have, 409 for
 * one whose state refuses the write.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f-]{36}$/i
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  not_yet: 409,
  cancelled: 409,
  already_rescheduled: 409,
  invalid: 400,
}

/**
 * `YYYY-MM-DDTHH:MM`, and a date that exists. `wallClockToInstant` hands the
 * fields to `Date.UTC`, which rolls 30 February forward to 2 March without
 * complaint — a meeting recorded on a day nobody typed.
 */
function isRealWallClock(local: string): boolean {
  const m = WALL_CLOCK.exec(local)
  if (!m) return false
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    && t.getUTCHours() === h && t.getUTCMinutes() === mi
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such meeting.' }, { status: 404 })
  const db = getDb() as unknown as AgencyDb
  const current = await readMeeting(db, user.orgId, id)
  if (!current) return NextResponse.json({ error: 'No such meeting.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const b = (body ?? {}) as { action?: unknown; outcome?: unknown; startsAtLocal?: unknown; timeZone?: unknown }

  if (b.action === 'outcome') {
    if (b.outcome === 'rescheduled') {
      return NextResponse.json(
        { error: 'A rescheduled meeting needs its new time — send action "reschedule" with startsAtLocal and timeZone.' },
        { status: 400 },
      )
    }
    if (b.outcome !== 'held' && b.outcome !== 'no_show') {
      return NextResponse.json({ error: 'outcome must be held or no_show' }, { status: 400 })
    }
    const r = await setMeetingOutcome(db, { orgId: user.orgId, id, outcome: b.outcome, actor: user.id })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: REFUSAL_STATUS[r.reason] ?? 409 })
    return NextResponse.json({ id, outcome: r.meeting.outcome })
  }

  if (b.action === 'cancel') {
    if (await cancelMeeting(db, user.orgId, id, user.id)) {
      return NextResponse.json({
        id,
        cancelled: true,
        note: 'Cancelled here. Nobody was told — if you sent an invitation from your calendar, cancel it there.',
      })
    }
    // The UPDATE decided; this re-read only names why it matched nothing.
    const now = await readMeeting(db, user.orgId, id)
    if (!now) return NextResponse.json({ error: 'No such meeting.' }, { status: 404 })
    return NextResponse.json(
      {
        error: now.cancelledAt
          ? 'This meeting is already cancelled.'
          : 'What happened at this meeting is already recorded, so it cannot be called off. Correct the outcome instead.',
      },
      { status: 409 },
    )
  }

  if (b.action === 'reschedule') {
    if (typeof b.startsAtLocal !== 'string' || !isRealWallClock(b.startsAtLocal)) {
      return NextResponse.json({ error: 'startsAtLocal must be a date and time, YYYY-MM-DDTHH:MM' }, { status: 400 })
    }
    if (typeof b.timeZone !== 'string' || !b.timeZone.trim()) {
      return NextResponse.json({ error: 'timeZone is required — the new time is a wall-clock time somewhere' }, { status: 400 })
    }
    const timeZone = b.timeZone.trim()
    const startsAt = wallClockToInstant(b.startsAtLocal, timeZone)
    if (!startsAt) {
      return NextResponse.json({ error: `"${timeZone.slice(0, 64)}" is not a timezone this system recognises.` }, { status: 400 })
    }
    const r = await rescheduleMeeting(db, {
      orgId: user.orgId, id, startsAt, timeZone, actor: user.id, createdBy: user.id,
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: REFUSAL_STATUS[r.reason] ?? 409 })
    return NextResponse.json({
      id,
      outcome: r.meeting.outcome,
      replacement: r.replacement.id,
      deal: r.deal,
      note: 'Recorded at the new time. No invitation was sent — move the event in your calendar.',
    })
  }

  return NextResponse.json({ error: 'action must be outcome, cancel or reschedule' }, { status: 400 })
}
