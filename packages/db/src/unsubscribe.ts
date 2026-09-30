/**
 * The VERIFY-and-record half of RFC 8058 one-click unsubscribe (§2.1).
 *
 * A click IS the opt-out — the fourth way a suppression row is written,
 * beside a person on the suppressions page, a reply that says stop, and a
 * spoken opt-out. So it is held to the same obligation: the row is written,
 * or the failure is loud. Never a quiet "done" over a row that is not there.
 *
 * Safe for the web bundle: verifying cannot mint. The minter lives in
 * `unsubscribe-mint.ts`, which only the package root exports, and this file
 * computes the MAC itself rather than importing it from there.
 *
 * ## The token names a ROW, and the row names everything else
 *
 * `${touchId}.${hmac}` — see `unsubscribe-mint.ts` for why there is no
 * address, no expiry and no org in it. The touch is found by id ACROSS orgs,
 * as `handleInboundEmail` finds a reply by Message-ID: the token is the proof
 * that this system sent that message, and the row it names is the only
 * source of the org a forged request cannot choose.
 *
 * ## Which address is suppressed
 *
 * The one the message was DELIVERED to — `touches.recipient`, captured at
 * send time — first, and the contact's current address as well when it has
 * been edited since. Suppressing only the current one was the design this
 * replaced, and it is wrong in exactly the case that matters: after an edit
 * the click suppresses a string nobody clicked from, and the mailbox that
 * asked to be left alone keeps receiving mail. And a touch whose contact was
 * deleted still names its recipient (`contact_id` is SET NULL so the log
 * outlives the contact), so there is still something to record — a contact
 * re-imported next month starts from NO on consent and finds the suppression
 * already there.
 *
 * Only a touch with NO recipient — erased, or a worker that died between the
 * provider and the write — cannot say what to suppress, and that is the
 * loud path, not a refusal: somebody clicked, and a person has to look.
 *
 * Except when the erasure is the reason AND the address is provably on the
 * list. An erasure suppresses every recipient before it scrubs them, and its
 * `contact.erased` row names, per message, the suppression row that now holds
 * that message's recipient (`suppressedRecipients`). A click on such a
 * message's old link is answered "done" — idempotent, no alarm — when that
 * row names this touch AND the suppression row it names still exists. Any
 * other missing recipient, or a kept row an owner has since removed, stays
 * loud: "certain" is the bar, because a quiet "done" over a row that is not
 * there is the one failure this module exists to prevent.
 *
 * ## A failure pauses them with the failure as the reason
 *
 * On the loud path the pause OVERWRITES an earlier reason. `pauseContact`
 * keeps the first on purpose (a second reply must not replace the first),
 * but here an older `replied …` left in place let answering that reply in
 * /inbox resume a person whose opt-out was never recorded.
 */
import { timingSafeEqual, createHmac } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { normaliseEmail } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { addSuppression } from './campaigns.js'
import { pauseContact, type InboundLog } from './outreach.js'

const TOUCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAC_HEX = /^[0-9a-f]{64}$/

export type UnsubscribeTokenCheck = { readonly ok: true; readonly touchId: string } | { readonly ok: false }

/**
 * Whether `token` is one this deployment minted, and for which touch.
 *
 * The shape is checked before the MAC, so a malformed token never reaches
 * the database as a uuid it would reject with a 500. The MAC is compared in
 * constant time on equal-length buffers — both are 32 bytes by the time the
 * shape check has passed, so the length test cannot leak anything. A blank
 * secret verifies nothing: fail closed, even if a caller forgot to check.
 *
 * The answer to a bad token carries no reason. "Wrong MAC" and "malformed"
 * are the same 404 to whoever is probing.
 */
export function verifyUnsubscribeToken(secret: string, token: string): UnsubscribeTokenCheck {
  if (!secret || typeof token !== 'string' || token.length > 128) return { ok: false }
  const dot = token.indexOf('.')
  if (dot < 0) return { ok: false }
  const touchId = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  if (!TOUCH_ID.test(touchId) || !MAC_HEX.test(mac)) return { ok: false }
  const expected = createHmac('sha256', secret).update(touchId).digest()
  const given = Buffer.from(mac, 'hex')
  if (given.length !== expected.length) return { ok: false }
  return timingSafeEqual(expected, given) ? { ok: true, touchId } : { ok: false }
}

/**
 * The display name of the org that sent this message, for the page that asks
 * "stop receiving email from <org>?" — and nothing else about it. Null when
 * the id names no outbound email, which the page renders as an invalid link.
 */
export async function unsubscribeOrgName(db: AgencyDb, touchId: string): Promise<string | null> {
  const rows = await db
    .select({ name: schema.orgs.name })
    .from(schema.touches)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.touches.orgId))
    .where(and(eq(schema.touches.id, touchId), eq(schema.touches.direction, 'out'), eq(schema.touches.channel, 'email')))
    .limit(1)
  return rows[0]?.name ?? null
}

export type UnsubscribeOutcome =
  | {
      readonly ok: true
      readonly touchId: string
      readonly orgId: string
      readonly contactId: string | null
      /** True when every address was already on the list: a repeat click, or a mail client and a person both. */
      readonly alreadyPresent: boolean
      /** How many addresses are now suppressed for this click: the delivered one, and the current one if it differs. */
      readonly addresses: number
      readonly paused: boolean
      readonly cancelled: number
      /**
       * True when the touch was scrubbed by an erasure that kept its recipient
       * on the list, and that row is still there — nothing was written now.
       */
      readonly erased: boolean
    }
  | { readonly ok: false; readonly reason: 'not_found'; readonly message: string }
  | {
      readonly ok: false
      readonly reason: 'not_recorded'
      readonly message: string
      /** A reason CLASS — `no_recipient`, `unparseable_address`, an error's name — never an address. */
      readonly why: string
      readonly touchId: string
      /** Null only when the database could not even say whose message this was. */
      readonly orgId: string | null
      readonly contactId: string | null
    }

const NOT_RECORDED = 'We could not record this. A person has been told.'

/**
 * Record a one-click unsubscribe for the touch a verified token named.
 *
 * In order: the suppression rows (the thing that matters — the send path
 * refuses on them whatever else happens), then the pause and the cancel of
 * anything queued (so nothing already approved goes out in the next tick
 * either), then the audit row. The pause and the cancel run on the failure
 * path too: they are the safe direction, and a click whose row could not be
 * written is exactly when nothing else should go to that person.
 *
 * Never throws. Every failure to write a suppression — `addSuppression`
 * answering `ok: false` for an address it cannot normalise, or THROWING, which
 * is what a database fault actually does — is `not_recorded`, already audited
 * as `unsubscribe.not_recorded` and logged `OPT-OUT NOT RECORDED` at error by
 * the time the caller sees it. The caller's job is the notification and the
 * 500. (The same two-shaped failure `recordOptOut` in calls.ts learned to
 * catch.)
 *
 * Idempotent: a second click finds every row present, pauses nothing new,
 * cancels nothing, and writes no second audit row — a mail client's POST and
 * the person's own click are one opt-out, not two.
 */
export async function recordUnsubscribe(
  db: AgencyDb,
  args: {
    readonly touchId: string
    readonly now?: Date
    /** See `InboundLog`. Defaults to a structured line on stderr. */
    readonly log?: InboundLog
  },
): Promise<UnsubscribeOutcome> {
  const now = args.now ?? new Date()
  const log = args.log ?? stderrLog

  let touch: { orgId: string; contactId: string | null; channel: string; direction: string; recipient: string | null } | undefined
  let currentEmail: string | null = null
  try {
    ;[touch] = await db
      .select({
        orgId: schema.touches.orgId,
        contactId: schema.touches.contactId,
        channel: schema.touches.channel,
        direction: schema.touches.direction,
        recipient: schema.touches.recipient,
      })
      .from(schema.touches)
      .where(eq(schema.touches.id, args.touchId))
      .limit(1)
    if (touch?.contactId) {
      const [contact] = await db
        .select({ email: schema.contacts.email })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, touch.contactId), eq(schema.contacts.orgId, touch.orgId)))
        .limit(1)
      currentEmail = contact?.email ?? null
    }
  } catch (err) {
    // Nothing is known — not even the org — so there is nothing to audit
    // against. The log line is the alarm.
    const why = errorName(err)
    log.error('OPT-OUT NOT RECORDED — record it by hand', { path: 'unsubscribe', touchId: args.touchId, why })
    return { ok: false, reason: 'not_recorded', message: NOT_RECORDED, why, touchId: args.touchId, orgId: null, contactId: null }
  }

  // A token only this deployment can mint named a row that is not an
  // outbound email: nothing was ever sent with a link for it. The same
  // answer as a bad token.
  if (!touch || touch.direction !== 'out' || touch.channel !== 'email') {
    return { ok: false, reason: 'not_found', message: 'This link is not valid.' }
  }
  const { orgId, contactId } = touch
  const reason = `unsubscribed by one-click link, ${now.toISOString().slice(0, 10)}`

  // An erased message names nobody and no address. When the erasure provably
  // kept its recipient on the list, the click was already honoured.
  if (touch.recipient === null && contactId === null) {
    let kept = false
    try {
      kept = await erasureKeptRecipient(db, orgId, args.touchId)
    } catch (err) {
      // Not provable, so the loud path below: `no_recipient` is still true.
      log.error('unsubscribe could not read the erasure record', { touchId: args.touchId, orgId, error: errorName(err) })
    }
    if (kept) {
      return {
        ok: true, touchId: args.touchId, orgId, contactId, alreadyPresent: true, addresses: 1, paused: false, cancelled: 0,
        erased: true,
      }
    }
  }

  const suppress = async (value: string): Promise<{ ok: true; alreadyPresent: boolean } | { ok: false; why: string }> => {
    try {
      const r = await addSuppression(db, { orgId, kind: 'email', value, reason, source: 'unsubscribe' })
      // `r.message` quotes the address back; the audit row and the log carry
      // a reason CLASS instead (§2.3).
      return r.ok ? { ok: true, alreadyPresent: r.alreadyPresent } : { ok: false, why: 'unparseable_address' }
    } catch (err) {
      return { ok: false, why: errorName(err) }
    }
  }

  // The delivered address first; the current one only when it is a
  // different address, compared the way the suppression list stores them.
  const delivered = touch.recipient
  const same =
    delivered !== null &&
    currentEmail !== null &&
    (normaliseEmail(currentEmail) ?? currentEmail) === (normaliseEmail(delivered) ?? delivered)
  const results = [
    delivered === null ? ({ ok: false, why: 'no_recipient' } as const) : await suppress(delivered),
    ...(currentEmail !== null && !same ? [await suppress(currentEmail)] : []),
  ]

  const failed = results.find((r): r is { ok: false; why: string } => !r.ok)

  let paused = false
  let cancelled = 0
  if (contactId) {
    try {
      // Recorded: the idempotent pause, which keeps an earlier reason. Not
      // recorded: THIS reason, over any earlier one (see the header).
      paused = failed
        ? await pauseOverriding(
            db, orgId, contactId, `opt-out not recorded: one-click unsubscribe ${now.toISOString()} (${failed.why})`, now,
          )
        : await pauseContact(db, orgId, contactId, `unsubscribed ${now.toISOString()}`, now)
    } catch (err) {
      log.error('unsubscribe could not pause the contact', { touchId: args.touchId, contactId, error: errorName(err) })
    }
    try {
      // Marked refused rather than deleted, as a reply does: the record that
      // a message was about to go, and did not, is the useful one.
      const rows = await db
        .update(schema.touches)
        .set({ status: 'refused', refusalCode: 'consent_revoked' })
        .where(
          and(
            eq(schema.touches.orgId, orgId),
            eq(schema.touches.contactId, contactId),
            eq(schema.touches.direction, 'out'),
            inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved']),
          ),
        )
        .returning({ id: schema.touches.id })
      cancelled = rows.length
    } catch (err) {
      log.error('unsubscribe could not cancel queued messages', { touchId: args.touchId, contactId, error: errorName(err) })
    }
  }

  if (failed) {
    // §2.1's Phase 4 obligation, for a click: an opt-out that failed to
    // store fails loudly to a human and never falls through. The audit row
    // is what the digest and the compliance page count; the log line is
    // what a person sees today; the caller adds the notification.
    await appendAudit(db, {
      orgId,
      actor: 'system',
      action: 'unsubscribe.not_recorded',
      subjectType: 'touch',
      subjectId: args.touchId,
      detail: { touchId: args.touchId, contactId, why: failed.why, paused, cancelledQueued: cancelled },
    }).catch(() => {})
    log.error('OPT-OUT NOT RECORDED — record it by hand', {
      path: 'unsubscribe', touchId: args.touchId, contactId, orgId, why: failed.why,
    })
    return { ok: false, reason: 'not_recorded', message: NOT_RECORDED, why: failed.why, touchId: args.touchId, orgId, contactId }
  }

  const alreadyPresent = results.every((r) => r.ok && r.alreadyPresent)
  if (!alreadyPresent || paused || cancelled > 0) {
    await appendAudit(db, {
      orgId,
      actor: 'system',
      action: 'contact.unsubscribed',
      subjectType: contactId ? 'contact' : 'touch',
      subjectId: contactId ?? args.touchId,
      // §2.3: ids and counts. Never the address.
      detail: { contactId, touchId: args.touchId, addresses: results.length, paused, cancelledQueued: cancelled },
    }).catch(() => {})
  }

  return {
    ok: true, touchId: args.touchId, orgId, contactId, alreadyPresent, addresses: results.length, paused, cancelled,
    erased: false,
  }
}

/**
 * Did an erasure keep this message's recipient on the suppression list, and
 * is that row still there? The `contact.erased` row names the suppression row
 * per message (`suppressedRecipients`); an owner may have removed it since,
 * and then the click has not been honoured and must say so.
 */
async function erasureKeptRecipient(db: AgencyDb, orgId: string, touchId: string): Promise<boolean> {
  const marks = await db
    .select({ suppressionId: sql<string | null>`${schema.auditLog.detail}->'suppressedRecipients'->>${touchId}` })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.action, 'contact.erased'),
        sql`${schema.auditLog.detail}->'suppressedRecipients'->>${touchId} IS NOT NULL`,
      ),
    )
  const ids = marks.map((m) => m.suppressionId).filter((id): id is string => typeof id === 'string' && TOUCH_ID.test(id))
  if (ids.length === 0) return false
  const held = await db
    .select({ id: schema.suppressions.id })
    .from(schema.suppressions)
    .where(
      and(eq(schema.suppressions.orgId, orgId), eq(schema.suppressions.kind, 'email'), inArray(schema.suppressions.id, ids)),
    )
    .limit(1)
  return held.length === 1
}

/**
 * Pause them with THIS reason, whether or not they were already paused — the
 * failure path's pause (see the header). Written here rather than as a
 * parameter on `pauseContact`, which outreach.ts owns.
 */
async function pauseOverriding(db: AgencyDb, orgId: string, contactId: string, reason: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(schema.contacts)
    .set({ pausedAt: now, pausedReason: reason.slice(0, 500) })
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
    .returning({ id: schema.contacts.id })
  return rows.length === 1
}

const stderrLog: InboundLog = {
  error: (message, fields) => {
    console.error(JSON.stringify({ level: 'error', message, ...fields, at: new Date().toISOString() }))
  },
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError'
}
