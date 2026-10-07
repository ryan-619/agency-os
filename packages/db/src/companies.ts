/**
 * Editing a company's own record: its name, its country and its IANA zone
 * (PROMPT.md §2.1, §8.2).
 *
 * The ZONE is the one that matters. `sendFactsFor` reads a contact's own zone
 * and falls back to the company's, so this value decides when quiet hours
 * begin for every person here who has none of their own — and when neither
 * is set, the send path refuses rather than guess. It is DECLARED, never
 * derived from `country`: a country is not a timezone (the US has six), and
 * a guess made here would be quoted by the send path as though somebody knew
 * it. So the zone is checked against the runtime's own database with
 * `isKnownTimeZone`, the same check `createContact` makes, and refused with
 * the same sentence.
 *
 * Never the domain. It is the key every scan, finding, score and proposal
 * hangs off; a company that moved domains is a new company to scan.
 */
import { and, count, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { COMPANY_STAGES } from '@agency/core'
import * as schema from './schema.js'
import type { Company } from './schema.js'
import { isKnownTimeZone } from './contacts.js'
import type { AgencyDb } from './repository.js'

/**
 * A partial edit. `undefined` (the key left out) leaves a field alone; `null`
 * — or a value that is blank once trimmed — clears it.
 *
 * Strict: an unknown key is refused rather than dropped, so `timezone` or
 * `domain` in a body is an error the sender sees instead of a 200 that
 * changed nothing.
 */
export const companyPatchInput = z
  .object({
    name: z.string().trim().max(160).nullable().optional(),
    country: z.string().trim().max(80).nullable().optional(),
    timeZone: z.string().trim().max(64).nullable().optional(),
    // 0021: what the company is, from research. A headcount is a claim, so it
    // is stored with where it came from (`headcountSource`), and a source
    // never stands without a headcount.
    headcount: z
      .number('A headcount is a whole number of people.')
      .int('A headcount is a whole number of people.')
      .min(1, 'A headcount is at least 1.')
      .max(10_000_000, 'A headcount is at most 10,000,000.')
      .nullable()
      .optional(),
    headcountSource: z.string().trim().max(300, 'Where the headcount came from is at most 300 characters.').nullable().optional(),
    industry: z.string().trim().max(80, 'An industry is at most 80 characters.').nullable().optional(),
    city: z.string().trim().max(80, 'A city is at most 80 characters.').nullable().optional(),
    stage: z.enum(COMPANY_STAGES, `A stage is one of: ${COMPANY_STAGES.join(', ')}.`).nullable().optional(),
    description: z.string().trim().max(600, 'A description is at most 600 characters.').nullable().optional(),
  })
  .strict()

export type CompanyPatchInput = z.infer<typeof companyPatchInput>

/** The fields an edit may touch, in the order `changed` lists them. */
export const COMPANY_EDITABLE_FIELDS = [
  'name', 'country', 'timeZone', 'industry', 'city', 'stage', 'headcount', 'headcountSource', 'description',
] as const

export type CompanyEditableField = (typeof COMPANY_EDITABLE_FIELDS)[number]

const UUID = z.uuid()

/**
 * Change a company's name, country or zone.
 *
 * `changed` names the fields whose stored value is now different — not the
 * fields the caller sent — so an audit row built from it says what actually
 * happened, and an edit that changed nothing writes nothing.
 *
 * A company in another org is `not_found`, indistinguishable from one that
 * does not exist.
 */
export async function companiesUpdate(
  db: AgencyDb,
  orgId: string,
  id: string,
  patch: CompanyPatchInput,
): Promise<
  | { ok: true; company: Company; changed: CompanyEditableField[] }
  | { ok: false; message: string; reason: 'not_found' | 'invalid' }
> {
  const notFound = { ok: false as const, message: 'That company is not in the CRM.', reason: 'not_found' as const }
  if (!UUID.safeParse(id).success) return notFound

  // Parsed again here, not only at the route: a caller that built the patch
  // by hand still gets the trim, the limits and the refusal of unknown keys.
  const parsed = companyPatchInput.safeParse(patch)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      message: `${first?.path.join('.') || 'input'}: ${first?.message ?? 'Invalid.'}`,
      reason: 'invalid',
    }
  }
  const blankIsNull = (v: string | null | undefined): string | null | undefined =>
    v === undefined ? undefined : v === null || v === '' ? null : v
  const next: { [K in CompanyEditableField]: Company[K] | undefined } = {
    name: blankIsNull(parsed.data.name),
    country: blankIsNull(parsed.data.country),
    timeZone: blankIsNull(parsed.data.timeZone),
    industry: blankIsNull(parsed.data.industry),
    city: blankIsNull(parsed.data.city),
    stage: parsed.data.stage,
    headcount: parsed.data.headcount,
    headcountSource: blankIsNull(parsed.data.headcountSource),
    description: blankIsNull(parsed.data.description),
  }

  if (next.timeZone && !isKnownTimeZone(next.timeZone)) {
    return {
      ok: false,
      message: `"${next.timeZone}" is not a timezone this system recognises. Use an IANA name like Europe/London.`,
      reason: 'invalid',
    }
  }

  const rows = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, id)))
    .limit(1)
  const current = rows[0]
  if (!current) return notFound

  // A headcount cleared takes its source with it; a source with no headcount
  // is refused, because it would be a citation for nothing (0021's CHECK says
  // so too — this says it in a sentence first).
  if (next.headcount === null && next.headcountSource === undefined && current.headcountSource !== null) {
    next.headcountSource = null
  }
  const headcountAfter = next.headcount !== undefined ? next.headcount : current.headcount
  const sourceAfter = next.headcountSource !== undefined ? next.headcountSource : current.headcountSource
  if (sourceAfter !== null && headcountAfter === null) {
    return {
      ok: false,
      message: 'headcountSource: a source needs the headcount it is for. Give the headcount as well, or no source.',
      reason: 'invalid',
    }
  }

  const changed = COMPANY_EDITABLE_FIELDS.filter((f) => next[f] !== undefined && next[f] !== current[f])
  if (changed.length === 0) return { ok: true, company: current, changed: [] }

  const set: Partial<{ [K in CompanyEditableField]: Company[K] }> = {}
  for (const f of changed) (set as Record<string, unknown>)[f] = next[f] ?? null
  const updated = await db
    .update(schema.companies)
    .set(set)
    .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, id)))
    .returning()
  const company = updated[0]
  // Deleted between the read and the write.
  if (!company) return notFound
  return { ok: true, company, changed }
}

/**
 * What the company page's edit control shows: the record, and how many people
 * here have no zone of their own — for whom the company's zone is the ONLY
 * one the send path has.
 */
export async function companiesEditView(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<{ company: Company; contactsWithoutZone: number } | null> {
  if (!UUID.safeParse(id).success) return null
  const rows = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, id)))
    .limit(1)
  const company = rows[0]
  if (!company) return null
  const [zoneless] = await db
    .select({ n: count() })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.orgId, orgId),
        eq(schema.contacts.companyId, id),
        isNull(schema.contacts.timeZone),
      ),
    )
  return { company, contactsWithoutZone: Number(zoneless?.n ?? 0) }
}
