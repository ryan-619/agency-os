/**
 * Contacts — the people a message is addressed to (PROMPT.md §2.1, §8.4).
 *
 * Phase 2 had none: the agent drafted ABOUT a company, to nobody. Phase 4
 * sends, and a message goes to a person, so this is where a person is
 * recorded — with the two things §2.1 says the send path will demand of them:
 * a consent record per channel (absence means NO), and a timezone quiet hours
 * can be evaluated in (absence means WAIT).
 *
 * Nothing here decides whether a contact may be written to. `decideSend` does,
 * on every message, from these rows.
 */
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ADDRESS_SOURCE_MAX, isAddressSource, normaliseEmail, normaliseLinkedIn, normalisePhone } from '@agency/core'
import * as schema from './schema.js'
import { isCheckViolation } from './pg-errors.js'
import type { AgencyDb } from './repository.js'

export type ContactRow = typeof schema.contacts.$inferSelect

/**
 * The two sentences an address that cannot be stored is refused with, on
 * every writer of a contact: `createContact`, `contactsUpdate` and the
 * routes in front of them. One wording, because a person who meets the same
 * refusal on the form and in chat should read the same thing.
 */
export function phoneNotInternational(raw: string): string {
  return (
    `"${raw}" is not a number in international form. Include the country code, like ` +
    '+1 415 555 0100 — without one it cannot be matched against an opt-out.'
  )
}

export function linkedinUnreadable(raw: string): string {
  return (
    `"${raw}" could not be read as a LinkedIn profile. Paste the full URL, like ` +
    'linkedin.com/in/jane-doe — a bare handle does not say whether it is a person or a company.'
  )
}

/**
 * Whether a LinkedIn URL can be stored on a contact: one `normaliseLinkedIn`
 * reads, as an edit requires. The form's route asks it before
 * `createContact`; the CSV import keeps its own rule (it stores the URL as
 * the file had it), so this is not in `createContact` itself.
 */
export function linkedinIsReadable(raw: string): boolean {
  return normaliseLinkedIn(raw) !== null
}

/** Postgres's unique_violation, wherever drizzle wrapped it. */
function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    if ((cur as { code?: unknown }).code === '23505') return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}
export type ConsentRow = typeof schema.consents.$inferSelect

export const contactInput = z.object({
  companyId: z.uuid(),
  firstName: z.string().trim().max(80).optional().nullable(),
  lastName: z.string().trim().max(80).optional().nullable(),
  title: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().max(254).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  linkedinUrl: z.string().trim().max(500).optional().nullable(),
  /**
   * IANA. Optional, and the consequence of leaving it empty is stated on the
   * form: nothing can be sent to this person until it is set, because quiet
   * hours cannot be checked. Validated by the runtime rather than a list,
   * which is what the database CHECK defers to as well (0010).
   */
  timeZone: z.string().trim().max(64).optional().nullable(),
  source: z.string().trim().max(40).default('manual'),
  /**
   * Where the email and the phone came from (0029), in core's
   * ADDRESS_SOURCE_PATTERN: `person`, `import`, `inbound`, `chat`,
   * `connector:<name>` or the page it was seen on. Omitted is NULL — "not
   * recorded" — never a guess at one. Each caller stamps its own (the form's
   * route `person`, the import `import`, the public forms `inbound`, the
   * assistant what it was shown); `createContact` refuses one that is not in
   * the pattern, or that names an address the contact does not have. Bounded
   * loosely here so the refusal is `createContact`'s sentence, not a parse
   * error.
   */
  emailSource: z.string().trim().max(ADDRESS_SOURCE_MAX * 2).optional().nullable(),
  phoneSource: z.string().trim().max(ADDRESS_SOURCE_MAX * 2).optional().nullable(),
})

export type ContactInput = z.infer<typeof contactInput>

/** The values `contacts_source_check` (0003) admits for the ROW's source. */
export const CONTACT_ROW_SOURCES = ['apollo', 'manual', 'import', 'agent', 'inbound'] as const

const SOURCE_NOT_KNOWN = {
  email:
    'That is not a source the email can be recorded with. Name the page it was seen on (https://…), ' +
    'or person, import, inbound, chat or connector:<name>.',
  phone:
    'That is not a source the phone number can be recorded with. Name the page it was seen on (https://…), ' +
    'or person, import, inbound, chat or connector:<name>.',
} as const

const SOURCE_WITHOUT_ADDRESS = {
  email: 'A source was given for an email address, but the contact has none. Give the address with it, or leave the source out.',
  phone: 'A source was given for a phone number, but the contact has none. Give the number with it, or leave the source out.',
} as const

/**
 * A control character, C0 or C1, which no page's address and none of our own
 * words carry. `isAddressSource` lets them through (JavaScript's `\S` matches
 * them), and the database does not agree: Postgres refuses U+0000 in any text,
 * which reached the INSERT as a 500, and reads U+0085 as a space, so the
 * CHECK refused a value the writer had passed (measured on the engine the
 * tests run, every code point of the Basic Multilingual Plane —
 * `contact-sources.test.ts`).
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

/**
 * Why an address's source cannot be stored, as a sentence, or null when it
 * can. `which` names the address in the sentence; `address` is the address
 * as it will be stored, or null for none. A source with no address is refused
 * rather than dropped: the caller said where something came from that is not
 * there, which is a mistake worth hearing about (0029's
 * `contacts_*_source_needs_*` CHECKs say the same to anything that gets past
 * this).
 */
export function addressSourceProblem(
  which: 'email' | 'phone',
  source: string | null | undefined,
  address: string | null,
): string | null {
  if (!source) return null
  if (!isAddressSource(source) || CONTROL_CHARACTER.test(source)) return SOURCE_NOT_KNOWN[which]
  if (!address) return SOURCE_WITHOUT_ADDRESS[which]
  return null
}

function rowSourceRefused(source: string): string {
  return `"${source}" is not a source a contact can have — one of ${CONTACT_ROW_SOURCES.join(', ')}.`
}

/**
 * The sentence for a CHECK on `contacts` that refused a new row, by its name.
 * The checks in `createContact` run first, so reaching one is a race or a
 * caller that went around them — a person still reads a sentence, never a 500.
 */
function contactCheckSentence(err: unknown, input: ContactInput): string | null {
  if (isCheckViolation(err, 'contacts_source_check')) return rowSourceRefused(input.source)
  if (isCheckViolation(err, 'contacts_email_source_is_known')) return SOURCE_NOT_KNOWN.email
  if (isCheckViolation(err, 'contacts_phone_source_is_known')) return SOURCE_NOT_KNOWN.phone
  if (isCheckViolation(err, 'contacts_email_source_needs_an_email')) return SOURCE_WITHOUT_ADDRESS.email
  if (isCheckViolation(err, 'contacts_phone_source_needs_a_phone')) return SOURCE_WITHOUT_ADDRESS.phone
  if (isCheckViolation(err)) return 'That contact could not be stored as given: one of its values is not one the CRM accepts.'
  return null
}

/** True if the runtime's own timezone database knows this zone. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export async function listContactsForCompany(
  db: AgencyDb,
  orgId: string,
  companyId: string,
): Promise<Array<ContactRow & { consents: ConsentRow[] }>> {
  const rows = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.companyId, companyId)))
    .orderBy(asc(schema.contacts.createdAt))
  if (rows.length === 0) return []
  const consents = await db
    .select()
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.orgId, orgId),
        sql`${schema.consents.contactId} IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})`,
      ),
    )
  return rows.map((r) => ({ ...r, consents: consents.filter((c) => c.contactId === r.id) }))
}

export async function readContact(db: AgencyDb, orgId: string, id: string): Promise<ContactRow | null> {
  const rows = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, id)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Add a contact, or say what is wrong with it.
 *
 * The email is normalised on the way in — the same fold the suppression list
 * uses, so `Priya@Rentman.IO` on a contact and `priya@rentman.io` on the
 * suppression list are the same person to the send path. An address that
 * cannot be normalised is refused here, because a contact who cannot be
 * checked against the suppression list is one the send path will refuse
 * anyway, and the person entering them should hear that now.
 */
export async function createContact(
  db: AgencyDb,
  orgId: string,
  input: ContactInput,
): Promise<{ ok: true; contact: ContactRow } | { ok: false; message: string }> {
  let email: string | null = null
  if (input.email) {
    email = normaliseEmail(input.email)
    if (!email) return { ok: false, message: `"${input.email}" could not be read as an email address.` }
  }
  if (input.timeZone && !isKnownTimeZone(input.timeZone)) {
    return {
      ok: false,
      message: `"${input.timeZone}" is not a timezone this system recognises. Use an IANA name like Europe/London.`,
    }
  }
  if (!email && !input.phone && !input.linkedinUrl) {
    return { ok: false, message: 'A contact needs at least one way to reach them.' }
  }
  // Stored as E.164, as an edit stores it (§1): a number in any other form
  // matches no suppression key and no text sent back, so a STOP from it would
  // find nobody. The CSV import has already normalised it, or dropped it.
  let phone: string | null = null
  if (input.phone) {
    phone = normalisePhone(input.phone)
    if (!phone) return { ok: false, message: phoneNotInternational(input.phone) }
  }
  if (!(CONTACT_ROW_SOURCES as readonly string[]).includes(input.source)) {
    return { ok: false, message: rowSourceRefused(input.source) }
  }
  // Where each address came from (0029), checked against the addresses as
  // they will be STORED — a phone the caller sent blank has no source either.
  const emailSourceProblem = addressSourceProblem('email', input.emailSource, email)
  if (emailSourceProblem) return { ok: false, message: emailSourceProblem }
  const phoneSourceProblem = addressSourceProblem('phone', input.phoneSource, phone)
  if (phoneSourceProblem) return { ok: false, message: phoneSourceProblem }

  const company = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, input.companyId)))
    .limit(1)
  if (company.length === 0) return { ok: false, message: 'That company is not in the CRM.' }

  // `contacts_org_email_key` is on (org_id, lower(email)). Checked first so
  // the person gets a sentence; caught below so a race gets the same one
  // rather than a 500.
  if (email) {
    const taken = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), sql`lower(${schema.contacts.email}) = ${email}`))
      .limit(1)
    if (taken.length > 0) return { ok: false, message: `${email} is already a contact in this CRM.` }
  }

  let rows
  try {
    rows = await db
    .insert(schema.contacts)
    .values({
      orgId,
      companyId: input.companyId,
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      title: input.title || null,
      email,
      phone,
      linkedinUrl: input.linkedinUrl || null,
      timeZone: input.timeZone || null,
      source: input.source,
      emailSource: input.emailSource || null,
      phoneSource: input.phoneSource || null,
    })
    .returning()
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, message: `${email} is already a contact in this CRM.` }
    const sentence = contactCheckSentence(err, input)
    if (sentence) return { ok: false, message: sentence }
    throw err
  }
  const contact = rows[0]
  if (!contact) throw new Error('contact insert returned no row')
  return { ok: true, contact }
}

export async function updateContactTimeZone(
  db: AgencyDb,
  orgId: string,
  id: string,
  timeZone: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (timeZone && !isKnownTimeZone(timeZone)) {
    return { ok: false, message: `"${timeZone}" is not a timezone this system recognises.` }
  }
  await db
    .update(schema.contacts)
    .set({ timeZone })
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, id)))
  return { ok: true }
}

/**
 * Record consent for one channel (§2.1).
 *
 * One row per (contact, channel), replaced rather than appended: the current
 * state is the answer the send path wants, and the history is in the audit
 * log the caller writes. `source` is required by the schema and by sense — a
 * consent nobody can say the origin of is not a consent.
 *
 * Note what this does NOT do: it does not remove a suppression. A contact
 * who opted in yesterday and asked to be left alone this morning is
 * suppressed, and only a person removing the suppression changes that.
 */
export async function recordConsent(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly channel: 'email' | 'sms' | 'voice' | 'whatsapp'
    readonly granted: boolean
    readonly source: string
    readonly evidence?: Record<string, unknown>
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const source = args.source.trim()
  if (!source) return { ok: false, message: 'Say where this consent came from — a form, a call, a reply.' }

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
  return { ok: true }
}
