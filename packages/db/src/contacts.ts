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
import { normaliseEmail } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type ContactRow = typeof schema.contacts.$inferSelect
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
})

export type ContactInput = z.infer<typeof contactInput>

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

  const company = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, input.companyId)))
    .limit(1)
  if (company.length === 0) return { ok: false, message: 'That company is not in the CRM.' }

  const rows = await db
    .insert(schema.contacts)
    .values({
      orgId,
      companyId: input.companyId,
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      title: input.title || null,
      email,
      phone: input.phone || null,
      linkedinUrl: input.linkedinUrl || null,
      timeZone: input.timeZone || null,
      source: input.source,
    })
    .returning()
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
