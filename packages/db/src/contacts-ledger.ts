// STUB — filled in wave 2 by consent-ledger-and-check-send (the two consent writers below are final; keep them)
/**
 * The /contacts ledger: every person, their consent per channel and what the
 * send path would say about them today. Reads through `consentLedgerFor` and
 * `previewSend` in send-preview.ts; adds nothing to the rules.
 *
 * Two writers live here already, because §2.1 has a rule the existing
 * `recordConsent` in contacts.ts cannot keep: "they said no" must never be
 * re-asked. That function is an upsert, so any member with contacts:write
 * could POST `{ channel: 'sms', granted: true }` over a `granted: false` row
 * and the refusal would be gone — after which `decideSend` allows SMS or
 * voice to a person who said no. `contactsRecordConsent` refuses that. A
 * refusal is lifted only by `contactsLiftRefusal`: an explicit, audited act
 * that returns the person to NEVER ASKED (absence is no), never to granted —
 * lifting a refusal is not a grant, and the grant that may follow carries
 * its own source and evidence. The route gates the lift to owners.
 */
import { and, eq, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'

export type ConsentWriteChannel = 'email' | 'sms' | 'voice' | 'whatsapp'

export type ContactsConsentOutcome =
  | { readonly ok: true; readonly previous: 'granted' | 'refused' | 'never_asked' }
  | { readonly ok: false; readonly reason: 'blank_source' | 'refused_is_final' | 'no_such_contact'; readonly message: string }

/**
 * Record what a person said about one channel — with the one rule an upsert
 * cannot keep: a `granted: false` row is FINAL against a later grant.
 *
 * A refusal over a grant is recorded (they said no now). A refusal over a
 * refusal is recorded too — a second no, with its own evidence. A grant over
 * a grant refreshes the source and evidence. A grant over a refusal is
 * refused with `refused_is_final`, and the caller shows the person the way
 * that exists: an owner lifting the refusal, on the record.
 */
export async function contactsRecordConsent(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly channel: ConsentWriteChannel
    readonly granted: boolean
    readonly source: string
    readonly evidence?: Record<string, unknown>
  },
): Promise<ContactsConsentOutcome> {
  const source = args.source.trim()
  if (!source) {
    return { ok: false, reason: 'blank_source', message: 'Say where this consent came from — a form, a call, a reply.' }
  }

  const contact = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId)))
    .limit(1)
  if (!contact[0]) {
    return { ok: false, reason: 'no_such_contact', message: 'No contact with that id is in this org. Nothing was recorded.' }
  }

  const existing = await db
    .select({ granted: schema.consents.granted })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.orgId, args.orgId),
        eq(schema.consents.contactId, args.contactId),
        eq(schema.consents.channel, args.channel),
      ),
    )
    .limit(1)
  const previous: 'granted' | 'refused' | 'never_asked' =
    existing[0] === undefined ? 'never_asked' : existing[0].granted ? 'granted' : 'refused'

  if (previous === 'refused' && args.granted) {
    return {
      ok: false,
      reason: 'refused_is_final',
      message:
        'This person refused this channel, and a refusal is not overwritten by a grant (§2.1). ' +
        'An owner can lift the refusal on the record; only after that can a new consent be recorded.',
    }
  }

  // The same statement `recordConsent` runs, now that the rule has been
  // checked. Two writers racing past the read above would both be grants
  // or both refusals of the same row; the rule cannot be lost that way.
  await db
    .insert(schema.consents)
    .values({
      orgId: args.orgId,
      contactId: args.contactId,
      channel: args.channel,
      granted: args.granted,
      source,
      evidence: args.evidence ?? {},
    })
    .onConflictDoUpdate({
      target: [schema.consents.contactId, schema.consents.channel],
      set: { granted: args.granted, source, evidence: args.evidence ?? {}, recordedAt: sql`now()` },
    })
  return { ok: true, previous }
}

export type ContactsLiftOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'blank_reason' | 'no_refusal'; readonly message: string }

/**
 * Lift a recorded refusal — the ONE way a `granted: false` row goes away.
 *
 * The row is deleted, so the person is back to never-asked: absence is NO
 * to the send path, and a new grant has to be recorded with its own source.
 * Audited as `consent.refusal_lifted` naming who and why, with ids only.
 * The route must allow this to owners alone; the function takes the actor
 * for the record and does not decide roles.
 */
export async function contactsLiftRefusal(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly channel: ConsentWriteChannel
    readonly actorUserId: string
    readonly reason: string
  },
): Promise<ContactsLiftOutcome> {
  const reason = args.reason.trim()
  if (!reason) {
    return { ok: false, reason: 'blank_reason', message: 'Say why the refusal is being lifted — it goes in the audit log.' }
  }
  const deleted = await db
    .delete(schema.consents)
    .where(
      and(
        eq(schema.consents.orgId, args.orgId),
        eq(schema.consents.contactId, args.contactId),
        eq(schema.consents.channel, args.channel),
        eq(schema.consents.granted, false),
      ),
    )
    .returning({ id: schema.consents.id })
  if (deleted.length === 0) {
    return { ok: false, reason: 'no_refusal', message: 'There is no recorded refusal on that channel to lift.' }
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actorUserId,
    action: 'consent.refusal_lifted',
    subjectType: 'contact',
    subjectId: args.contactId,
    detail: { channel: args.channel, reason },
  })
  return { ok: true }
}
