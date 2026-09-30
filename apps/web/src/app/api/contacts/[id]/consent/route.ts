import { NextResponse } from 'next/server'
import { assertCan, can } from '@agency/core'
import {
  appendAudit, contactsLiftRefusal, contactsRecordConsent, readContact, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Record consent for one channel, or lift a refusal (PROMPT.md §2.1).
 *
 * "Every contact row carries a `consent` record. `sms_consent` and
 * `voice_consent` are separate booleans with a `source` and `recorded_at`."
 * One row per channel, so a yes to email says nothing about SMS — and a
 * `source` is required by the schema, by this route, and by sense: a consent
 * nobody can say the origin of is not one.
 *
 * Written through `contactsRecordConsent`, never the `recordConsent` upsert:
 * "they said no" is never re-asked, so a grant over a recorded refusal is
 * answered 409 with the sentence that says why and what exists instead. What
 * exists instead is `{ action: 'lift' }` — owner-only, with a reason, audited
 * by the writer itself — which returns the person to NEVER ASKED, not to
 * granted. A grant after that is a second, separate act with its own source.
 *
 * `wording` is the words the person was shown or told when they answered —
 * the booking page stores its form's exact text the same way. Optional here,
 * because the company page's quick buttons do not ask for it; the /contacts
 * form does, and when it is given the evidence says which form it came from.
 *
 * Recording a consent does NOT remove a suppression. Somebody who opted in
 * last month and asked to be left alone this morning is suppressed, and only
 * an owner removing the suppression changes that.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CHANNELS = new Set(['email', 'sms', 'voice', 'whatsapp'])
type ConsentChannel = 'email' | 'sms' | 'voice' | 'whatsapp'

/** The same bound on the wording the /contacts form enforces. */
const MAX_WORDING = 600

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  try {
    assertCan(principal, 'contacts:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  const db = getDb() as unknown as AgencyDb
  if (!(await readContact(db, user.orgId, id))) {
    return NextResponse.json({ error: 'No such contact.' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { action, channel, granted, source, wording, reason } = (body ?? {}) as {
    action?: unknown; channel?: unknown; granted?: unknown; source?: unknown; wording?: unknown; reason?: unknown
  }
  if (typeof channel !== 'string' || !CHANNELS.has(channel)) {
    return NextResponse.json({ error: 'channel must be email, sms, voice or whatsapp' }, { status: 400 })
  }

  if (action === 'lift') {
    // The one way a refusal leaves the table. Owner-only, like removing a
    // suppression: it decides that somebody who said no may be asked again.
    if (!can(principal, 'users:write')) {
      return NextResponse.json(
        { error: 'Only an owner can lift a refusal — it means asking again somebody who said no.' },
        { status: 403 },
      )
    }
    const r = await contactsLiftRefusal(db, {
      orgId: user.orgId,
      contactId: id,
      channel: channel as ConsentChannel,
      actorUserId: user.id,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
    })
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'no_refusal' ? 409 : 400 })
    return NextResponse.json({ channel, state: 'never_asked' })
  }
  if (action !== undefined && action !== 'record') {
    return NextResponse.json({ error: 'action must be record or lift' }, { status: 400 })
  }

  if (typeof granted !== 'boolean') {
    return NextResponse.json({ error: 'granted must be true or false' }, { status: 400 })
  }
  // Checked HERE, before the "(recorded by …)" suffix is appended: with the
  // suffix, a blank source is non-blank, and the writer's own check — the
  // one the schema's `consents_source_is_not_blank` backs — never fires.
  // Found by review.
  if (typeof source !== 'string' || source.trim().length === 0) {
    return NextResponse.json({ error: 'Say where this consent came from — a form, a call, a reply.' }, { status: 400 })
  }
  if (wording !== undefined && wording !== null && typeof wording !== 'string') {
    return NextResponse.json({ error: 'wording must be text' }, { status: 400 })
  }
  const words = typeof wording === 'string' ? wording.trim() : ''
  if (words.length > MAX_WORDING) {
    return NextResponse.json(
      { error: `Keep the wording to ${MAX_WORDING} characters — the sentence they agreed to, not the whole page.` },
      { status: 400 },
    )
  }

  const recordedBy = user.email ?? user.id
  const r = await contactsRecordConsent(db, {
    orgId: user.orgId,
    contactId: id,
    channel: channel as ConsentChannel,
    granted,
    source: `${source.trim()} (recorded by ${recordedBy})`,
    evidence: words ? { form: 'contacts_page', wording: words, recordedBy } : { recordedBy },
  })
  if (!r.ok) {
    const status = r.reason === 'refused_is_final' ? 409 : r.reason === 'no_such_contact' ? 404 : 400
    return NextResponse.json({ error: r.message, reason: r.reason }, { status })
  }

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: granted ? 'consent.granted' : 'consent.declined',
    subjectType: 'contact',
    subjectId: id,
    // The wording is evidence on the consent row; the audit row says only
    // that there was some, and what the channel stood at before.
    detail: { channel, source: source.trim().slice(0, 200), previous: r.previous, hasWording: words.length > 0 },
  }).catch(() => {})
  return NextResponse.json({ channel, granted, previous: r.previous })
}
