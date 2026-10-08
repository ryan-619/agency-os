/**
 * The public free website check (2026-10-08): a business types in its
 * website and gets its own audit page at once; the agency gets a lead.
 *
 * The booking page's rules (`booking.ts`), because it is the same kind of
 * surface — a stranger writing to the database: the org is found by its
 * public booking slug and nothing about it is revealed but its name; every
 * field is bounded; a company or a contact already on file is used as it is
 * and never rewritten by an anonymous form; a NEW contact gets the one
 * consent the form asked for — email, about the result — carrying the form's
 * exact wording. And two of its own: at most `CHECKS_PER_HOUR` checks an hour
 * for the org, and one per site per hour, because each check makes the
 * agency's server request somebody's website.
 *
 * This records the request; the route then scans the site (bounded) and
 * mints the business's audit page link. Audited `check.requested` — ids and
 * whether it was already on file, never the address or the name.
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import { normaliseEmail } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { orgByBookingSlug } from './booking.js'
import { isKnownTimeZone, recordConsent } from './contacts.js'
import { advanceDeal } from './deals.js'

export const CHECKS_PER_HOUR = 20

export interface CheckRequest {
  readonly slug: string
  /** The site's host, already normalised and judged scannable by the caller. */
  readonly domain: string
  readonly businessName: string | null
  readonly name: string
  readonly email: string
  readonly timeZone: string | null
  readonly consentWording: string
  readonly now: Date
}

export type CheckOutcome =
  | { readonly ok: true; readonly orgId: string; readonly orgName: string; readonly companyId: string; readonly recognised: boolean }
  | { readonly ok: false; readonly status: 400 | 404 | 429; readonly message: string }

export async function websiteCheckRequest(db: AgencyDb, req: CheckRequest): Promise<CheckOutcome> {
  const org = await orgByBookingSlug(db, req.slug)
  if (!org) return { ok: false, status: 404, message: 'This page is not active.' }
  const email = normaliseEmail(req.email)
  if (!email) return { ok: false, status: 400, message: 'That does not look like an email address.' }
  const name = req.name.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!name) return { ok: false, status: 400, message: 'Please tell us your name.' }
  const zone = req.timeZone && isKnownTimeZone(req.timeZone) ? req.timeZone : 'Asia/Kolkata'

  const hourAgo = new Date(req.now.getTime() - 3_600_000)
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, org.id), eq(schema.auditLog.action, 'check.requested'), gte(schema.auditLog.createdAt, hourAgo)))
  if ((recent?.n ?? 0) >= CHECKS_PER_HOUR) {
    return { ok: false, status: 429, message: 'A lot of sites are being checked right now. Please try again in an hour.' }
  }
  const [company] = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, org.id), eq(schema.companies.domain, req.domain)))
    .limit(1)
  if (company) {
    const [again] = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.orgId, org.id), eq(schema.auditLog.action, 'check.requested'), eq(schema.auditLog.subjectId, company.id),
        gte(schema.auditLog.createdAt, hourAgo),
      ))
      .limit(1)
    if (again) return { ok: false, status: 429, message: 'This site was checked a few minutes ago. Please try again in an hour.' }
  }
  const [known] = await db
    .select({ id: schema.contacts.id, companyId: schema.contacts.companyId })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, org.id), eq(schema.contacts.email, email)))
    .limit(1)

  const result = await db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    const companyId =
      company?.id ??
      (
        await t
          .insert(schema.companies)
          .values({ orgId: org.id, domain: req.domain, name: req.businessName?.trim().slice(0, 120) || null, source: 'inbound', timeZone: zone })
          .returning({ id: schema.companies.id })
      )[0]!.id
    if (!known) {
      const [contact] = await t
        .insert(schema.contacts)
        .values({ orgId: org.id, companyId, email, firstName: name.split(' ')[0] ?? name, lastName: name.split(' ').slice(1).join(' ') || null, timeZone: zone })
        .returning({ id: schema.contacts.id })
      await recordConsent(t, {
        orgId: org.id, contactId: contact!.id, channel: 'email', granted: true, source: 'website check form',
        evidence: { wording: req.consentWording, at: req.now.toISOString() },
      })
    }
    await advanceDeal(t, { orgId: org.id, companyId, to: 'replied', nextAction: 'Call — they asked for a free website check' })
    await appendAudit(t, {
      orgId: org.id, actor: 'website_check', action: 'check.requested', subjectType: 'company', subjectId: companyId,
      detail: { recognised: Boolean(company || known) },
    })
    return { companyId }
  })
  return { ok: true, orgId: org.id, orgName: org.name, companyId: result.companyId, recognised: Boolean(company || known) }
}
