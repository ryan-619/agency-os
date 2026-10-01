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
 *
 * And one edit, `contactsUpdate`, with the rule an edit form would otherwise
 * break: a suppression is keyed by VALUE, so changing the address a
 * suppression matches would leave the opt-out standing against an address
 * nobody holds any more, and the next enrolment would send. An edit may not
 * make a suppression stop matching the person it was recorded for.
 *
 * The same edit is the one way a BOUNCE mark is lifted. A permanent bounce is
 * evidence about the address (0018's `email_bounced_at`), so correcting the
 * address is what clears it — and nothing else does: not approving a
 * message, not resuming the contact. The opposite of the suppression rule,
 * on purpose: an opt-out follows the person, a bounce follows the address.
 */
import { and, asc, eq, ilike, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  normaliseEmail, normaliseLinkedIn, normalisePhone, suppressionKeysFor,
  type Channel, type SuppressionKind,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import type { ConsentRow, ContactRow } from './contacts.js'
import { isUniqueViolation } from './pg-errors.js'

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
    return { ok: false, reason: 'refused_is_final', message: REFUSED_IS_FINAL }
  }

  // The read above turns the common case into a sentence before anything is
  // written. It is not what keeps the rule: two writers can both pass it —
  // a refusal committed between a grant's SELECT and its INSERT — and the
  // statement below is what refuses the grant then.
  const written = await contactsConsentUpsert(db, {
    orgId: args.orgId,
    contactId: args.contactId,
    channel: args.channel,
    granted: args.granted,
    source,
    ...(args.evidence ? { evidence: args.evidence } : {}),
  })
  if (written === 'refused_is_final') return { ok: false, reason: 'refused_is_final', message: REFUSED_IS_FINAL }
  return { ok: true, previous }
}

const REFUSED_IS_FINAL =
  'This person refused this channel, and a refusal is not overwritten by a grant (§2.1). ' +
  'An owner can lift the refusal on the record; only after that can a new consent be recorded.'

/**
 * The upsert, with §2.1's rule IN the statement: `ON CONFLICT … DO UPDATE …
 * WHERE consents.granted OR NOT excluded.granted`. A refusal always writes
 * (over a grant, or as a second no). A grant writes over nothing or over a
 * grant; over a stored refusal the conflict matches, the WHERE is false,
 * nothing is updated and RETURNING is empty — `refused_is_final`.
 *
 * The statement this replaced had an unconditional DO UPDATE and relied on
 * the caller's SELECT, so under READ COMMITTED a grant that read "never
 * asked" and then lost the race to a refusal overwrote it — after which
 * `decideSend` allows SMS or voice to a person who said no.
 *
 * Exported for the test that calls it with `contactsRecordConsent`'s
 * pre-check skipped: PGlite is one session, so no test here can interleave
 * two writers, and the guard has to be shown to hold on its own. Every other
 * caller goes through `contactsRecordConsent`.
 */
export async function contactsConsentUpsert(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly channel: ConsentWriteChannel
    readonly granted: boolean
    /** Already trimmed and checked non-blank by the caller. */
    readonly source: string
    readonly evidence?: Record<string, unknown>
  },
): Promise<'written' | 'refused_is_final'> {
  const rows = await db
    .insert(schema.consents)
    .values({
      orgId: args.orgId,
      contactId: args.contactId,
      channel: args.channel,
      granted: args.granted,
      source: args.source,
      evidence: args.evidence ?? {},
    })
    .onConflictDoUpdate({
      target: [schema.consents.contactId, schema.consents.channel],
      set: { granted: args.granted, source: args.source, evidence: args.evidence ?? {}, recordedAt: sql`now()` },
      setWhere: sql`${schema.consents.granted} OR NOT excluded.granted`,
    })
    .returning({ id: schema.consents.id })
  return rows.length === 1 ? 'written' : 'refused_is_final'
}

export type ContactsLiftOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'blank_reason' | 'no_refusal'; readonly message: string }

/**
 * Lift a recorded refusal — the ONE way a `granted: false` row goes away.
 *
 * The row is deleted, so the person is back to never-asked: absence is NO
 * to the send path, and a new grant has to be recorded with its own source.
 * Audited as `consent.refusal_lifted` naming who and why, in the same
 * transaction as the DELETE.
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
  // One transaction: the refusal goes and the record of who lifted it and
  // why is written, or neither. Before, an audit write that failed after
  // the DELETE had committed left a person back at never-asked with nothing
  // saying who decided that — for an act this module calls audited.
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    const deleted = await tx
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
      return { ok: false, reason: 'no_refusal', message: 'There is no recorded refusal on that channel to lift.' } as const
    }
    await appendAudit(tx, {
      orgId: args.orgId,
      actor: args.actorUserId,
      action: 'consent.refusal_lifted',
      subjectType: 'contact',
      subjectId: args.contactId,
      detail: { channel: args.channel, reason },
    })
    return { ok: true } as const
  })
}

// ---------------------------------------------------------------------------
// The ledger: every person in the org, with their company and their consents
// ---------------------------------------------------------------------------

/**
 * One person on /contacts. The company's zone rides along because it is the
 * zone quiet hours fall back to (`sendFactsFor`), and a page that showed only
 * the contact's own would call a sendable person unsendable.
 */
export interface LedgerRow extends ContactRow {
  readonly companyDomain: string
  readonly companyName: string | null
  readonly companyTimeZone: string | null
  readonly consents: ConsentRow[]
}

export interface LedgerQuery {
  readonly companyId?: string
  /** true: only paused people. false: only people who are not. Absent: both. */
  readonly paused?: boolean
  /** Matched against name, address and company, case-insensitively. */
  readonly q?: string
  /** Default 100, at most 500 — the page reads a suppression answer per row. */
  readonly limit?: number
  readonly offset?: number
}

export const LEDGER_DEFAULT_LIMIT = 100
export const LEDGER_MAX_LIMIT = 500

/** `%` and `_` are ILIKE wildcards; a person searching for them means them. */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * The people in one org, each with their company and every consent row.
 *
 * Two queries: the people joined to their company (inner — a contact's
 * company is NOT NULL and cascades, so a contact without one does not
 * exist), then the consents for exactly those ids. The consent rows are
 * the raw record; turning them into never-asked / refused / granted, and
 * asking the suppression list, is `consentLedgerFor`'s job, so the ledger
 * and the tools cannot disagree about a person.
 */
export async function contactsLedger(
  db: AgencyDb,
  orgId: string,
  q: LedgerQuery = {},
): Promise<LedgerRow[]> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? LEDGER_DEFAULT_LIMIT), 1), LEDGER_MAX_LIMIT)
  const offset = Math.max(Math.trunc(q.offset ?? 0), 0)

  const where: SQL[] = [eq(schema.contacts.orgId, orgId)]
  if (q.companyId) where.push(eq(schema.contacts.companyId, q.companyId))
  if (q.paused === true) where.push(isNotNull(schema.contacts.pausedAt))
  if (q.paused === false) where.push(isNull(schema.contacts.pausedAt))
  const text = q.q?.trim()
  if (text) {
    const term = likeTerm(text.slice(0, 200))
    where.push(
      or(
        ilike(schema.contacts.firstName, term),
        ilike(schema.contacts.lastName, term),
        ilike(schema.contacts.email, term),
        ilike(schema.contacts.title, term),
        ilike(schema.companies.domain, term),
        ilike(schema.companies.name, term),
        sql`(coalesce(${schema.contacts.firstName}, '') || ' ' || coalesce(${schema.contacts.lastName}, '')) ILIKE ${term}`,
      )!,
    )
  }

  const rows = await db
    .select({
      contact: schema.contacts,
      companyDomain: schema.companies.domain,
      companyName: schema.companies.name,
      companyTimeZone: schema.companies.timeZone,
    })
    .from(schema.contacts)
    // The company's org is checked too: a contact filed under another org's
    // company would be a bug, and it must not become a leak.
    .innerJoin(
      schema.companies,
      and(eq(schema.companies.id, schema.contacts.companyId), eq(schema.companies.orgId, orgId)),
    )
    .where(and(...where))
    .orderBy(asc(schema.companies.domain), asc(schema.contacts.createdAt), asc(schema.contacts.id))
    .limit(limit)
    .offset(offset)
  if (rows.length === 0) return []

  const consents = await db
    .select()
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.orgId, orgId),
        sql`${schema.consents.contactId} IN (${sql.join(rows.map((r) => sql`${r.contact.id}`), sql`, `)})`,
      ),
    )
  return rows.map((r) => ({
    ...r.contact,
    companyDomain: r.companyDomain,
    companyName: r.companyName,
    companyTimeZone: r.companyTimeZone,
    consents: consents.filter((c) => c.contactId === r.contact.id),
  }))
}

// ---------------------------------------------------------------------------
// Editing a contact
// ---------------------------------------------------------------------------

/**
 * The fields a person may edit on /contacts. Same bounds as `contactInput`.
 * `undefined` leaves a field alone; `null` (or an empty string) clears it.
 * The company, the timezone, the source and the pause are NOT here: each has
 * its own action with its own audit row, and a general-purpose edit that
 * could also move a person between companies is a way to file one company's
 * contact under another's deal.
 */
export const contactPatchInput = z.object({
  firstName: z.string().trim().max(80).optional().nullable(),
  lastName: z.string().trim().max(80).optional().nullable(),
  title: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().max(254).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  linkedinUrl: z.string().trim().max(500).optional().nullable(),
})

export type ContactPatch = z.infer<typeof contactPatchInput>

export type ContactsUpdateOutcome =
  | {
      readonly ok: true
      readonly contact: ContactRow
      readonly changed: string[]
      /** True when the email changed on a contact whose address had bounced, and the mark was lifted. */
      readonly bounceCleared: boolean
    }
  | {
      readonly ok: false
      readonly reason: 'no_such_contact' | 'unreadable' | 'no_address' | 'duplicate' | 'suppressed' | 'changed_meanwhile'
      readonly message: string
    }

type AddressField = 'email' | 'phone' | 'linkedinUrl'

/** The channel whose key builder reads each address field. */
const KEY_CHANNEL: Record<AddressField, Channel> = { email: 'email', phone: 'sms', linkedinUrl: 'linkedin' }

const KIND_WORDS: Record<SuppressionKind, string> = {
  email: 'email address',
  domain: 'email domain',
  phone: 'phone number',
  linkedin: 'LinkedIn profile',
}

/** Every suppression key a stored value produces; none for an empty or unreadable one. */
function keysOf(field: AddressField, value: string | null): { kind: SuppressionKind; value: string }[] {
  if (!value) return []
  return [...(suppressionKeysFor(value, KEY_CHANNEL[field]) ?? [])]
}

/** Blank is absent. The form sends '' for a cleared input; the column wants NULL. */
function blankIsNull(v: string | null): string | null {
  const t = v?.trim()
  return t ? t : null
}

/**
 * Change a contact's name, title or addresses, or say why not.
 *
 * Addresses are held to the rule `createContact` holds an email to: a value
 * the suppression list could never match is one the send path would refuse,
 * so the person typing it hears that now. The email is folded
 * (`normaliseEmail`), a phone is stored in E.164, and a LinkedIn URL is kept
 * as typed — it is a link somebody clicks — but must be one
 * `normaliseLinkedIn` can read. A value that did not change is not
 * re-validated, so a contact imported with a local number can still have
 * its title corrected.
 *
 * The rule an edit form would otherwise break (§2.1): a suppression is keyed
 * by value, so editing a suppressed address away leaves the opt-out matching
 * nobody and makes the new address sendable. Every suppression row that
 * matches this person before the edit must still match them after it, or
 * the edit is refused and an owner decides. An email moving within a
 * suppressed domain is allowed, because the domain row still matches. The
 * same condition is repeated inside the UPDATE, so a "stop" that lands
 * between the check and the write fails the edit rather than being edited
 * past.
 *
 * `changed` names the fields whose stored value moved — the audit row the
 * route writes carries those names and never the values (§2.3).
 *
 * A changed email lifts a bounce mark in the same UPDATE — the mark was
 * about the old address — and writes `contact.bounce_cleared` naming the
 * code it lifted. The same-address-different-case edit changes nothing and
 * so lifts nothing.
 */
export async function contactsUpdate(
  db: AgencyDb,
  orgId: string,
  id: string,
  patch: ContactPatch,
  /** Who is editing, for the `contact.bounce_cleared` row. The route's own `contact.updated` row names them too. */
  opts: { readonly actor?: string } = {},
): Promise<ContactsUpdateOutcome> {
  const found = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, id)))
    .limit(1)
  const old = found[0]
  if (!old) return { ok: false, reason: 'no_such_contact', message: 'No contact with that id is in this org. Nothing was changed.' }

  const next: Partial<Record<'firstName' | 'lastName' | 'title' | AddressField, string | null>> = {}

  for (const field of ['firstName', 'lastName', 'title'] as const) {
    if (patch[field] === undefined) continue
    const v = blankIsNull(patch[field])
    if (v !== old[field]) next[field] = v
  }

  if (patch.email !== undefined) {
    const raw = blankIsNull(patch.email)
    const v = raw === null ? null : normaliseEmail(raw)
    if (raw !== null && v === null) {
      return { ok: false, reason: 'unreadable', message: `"${raw}" could not be read as an email address.` }
    }
    if (v !== (old.email?.toLowerCase() ?? null)) next.email = v
  }

  if (patch.phone !== undefined) {
    const raw = blankIsNull(patch.phone)
    if (raw !== old.phone) {
      const v = raw === null ? null : normalisePhone(raw)
      if (raw !== null && v === null) {
        return {
          ok: false,
          reason: 'unreadable',
          message:
            `"${raw}" is not a number in international form. Include the country code, like ` +
            '+1 415 555 0100 — without one it cannot be matched against an opt-out.',
        }
      }
      if (v !== old.phone) next.phone = v
    }
  }

  if (patch.linkedinUrl !== undefined) {
    const raw = blankIsNull(patch.linkedinUrl)
    if (raw !== old.linkedinUrl) {
      if (raw !== null && normaliseLinkedIn(raw) === null) {
        return {
          ok: false,
          reason: 'unreadable',
          message:
            `"${raw}" could not be read as a LinkedIn profile. Paste the full URL, like ` +
            'linkedin.com/in/jane-doe — a bare handle does not say whether it is a person or a company.',
        }
      }
      next.linkedinUrl = raw
    }
  }

  const changed = Object.keys(next)
  if (changed.length === 0) return { ok: true, contact: old, changed: [], bounceCleared: false }

  const after = (f: AddressField): string | null => (next[f] !== undefined ? next[f]! : old[f])
  if (!after('email') && !after('phone') && !after('linkedinUrl')) {
    return { ok: false, reason: 'no_address', message: 'A contact needs at least one way to reach them.' }
  }

  // The keys this person stops matching: every key an OLD address produces
  // that the NEW one does not. If any of them is a suppression row, the
  // edit would move the person out from under their own opt-out.
  const dropping: { kind: SuppressionKind; value: string }[] = []
  for (const f of ['email', 'phone', 'linkedinUrl'] as const) {
    if (next[f] === undefined) continue
    const kept = keysOf(f, after(f))
    for (const k of keysOf(f, old[f])) {
      if (!kept.some((n) => n.kind === k.kind && n.value === k.value)) dropping.push(k)
    }
  }
  const suppressedAmong = (keys: readonly { kind: SuppressionKind; value: string }[]) =>
    and(
      eq(schema.suppressions.orgId, orgId),
      or(...keys.map((k) => and(eq(schema.suppressions.kind, k.kind), eq(schema.suppressions.value, k.value)))),
    )
  if (dropping.length > 0) {
    const hits = await db
      .select({ kind: schema.suppressions.kind })
      .from(schema.suppressions)
      .where(suppressedAmong(dropping))
      .limit(1)
    const hit = hits[0]
    if (hit) {
      return {
        ok: false,
        reason: 'suppressed',
        message:
          `This contact's ${KIND_WORDS[hit.kind as SuppressionKind] ?? 'address'} is on the suppression list — ` +
          'an owner must remove the suppression before it can be changed. Changing it here would leave the ' +
          'opt-out matching an address they no longer have, and the next message would go to the new one.',
      }
    }
  }

  if (next.email) {
    const taken = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), sql`lower(${schema.contacts.email}) = ${next.email}`, ne(schema.contacts.id, id)))
      .limit(1)
    if (taken.length > 0) return { ok: false, reason: 'duplicate', message: `${next.email} is already a contact in this CRM.` }
  }

  // A mark is about the address being replaced; the new one has not
  // bounced. Cleared in the same statement as the change, so there is no
  // moment where the new address carries the old address's mark — and
  // cleared whenever the email changes, not only when the read above saw a
  // mark: a bounce landing between that read and this write was about the
  // OLD address too. The audit row names what the read saw.
  const emailChanges = next.email !== undefined
  const clearsBounce = emailChanges && old.emailBouncedAt !== null

  let rows: ContactRow[]
  try {
    rows = await db
      .update(schema.contacts)
      .set({
        ...next,
        ...(emailChanges ? { emailBouncedAt: null, emailBounceCode: null } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.contacts.orgId, orgId),
          eq(schema.contacts.id, id),
          // What the checks above read. If an address moved under us, or an
          // opt-out for one we are dropping arrived, this matches nothing.
          sql`${schema.contacts.email} IS NOT DISTINCT FROM ${old.email}`,
          sql`${schema.contacts.phone} IS NOT DISTINCT FROM ${old.phone}`,
          sql`${schema.contacts.linkedinUrl} IS NOT DISTINCT FROM ${old.linkedinUrl}`,
          ...(dropping.length > 0
            ? [sql`NOT EXISTS (SELECT 1 FROM ${schema.suppressions} WHERE ${suppressedAmong(dropping)})`]
            : []),
        ),
      )
      .returning()
  } catch (err) {
    // `contacts_org_email_key` — a race past the check above gets the same sentence.
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate', message: `${next.email} is already a contact in this CRM.` }
    throw err
  }
  const contact = rows[0]
  if (!contact) {
    return {
      ok: false,
      reason: 'changed_meanwhile',
      message: 'This contact changed while you were editing — an address, or an opt-out arriving. Reload and try again.',
    }
  }
  if (clearsBounce) {
    await appendAudit(db, {
      orgId,
      actor: opts.actor ?? 'system',
      action: 'contact.bounce_cleared',
      subjectType: 'contact',
      subjectId: id,
      // The code that was lifted, never either address (§2.3).
      detail: { code: old.emailBounceCode },
    }).catch(() => {})
  }
  return { ok: true, contact, changed, bounceCleared: clearsBounce }
}
