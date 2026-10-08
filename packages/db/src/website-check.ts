/**
 * The public free website check (2026-10-08): a business types in its
 * website and gets its own audit page at once; the agency gets a lead.
 *
 * The booking page's rules (`booking.ts`), because it is the same kind of
 * surface — a stranger writing to the database: the org is found by its
 * public booking slug and nothing about it is revealed but its name; every
 * field is bounded; a NEW contact gets the one consent the form asked for —
 * email, about the result — carrying the form's exact wording. And two of its
 * own: at most `CHECKS_PER_HOUR` checks an hour for the org, and one per site
 * (or per address on file) per hour, because each check makes the agency's
 * server request somebody's website.
 *
 * **A site or an address already on file changes nothing** (review,
 * 2026-10-08). Anybody can type any domain and any address, so a request
 * that names a company or a person the CRM already holds is not evidence of
 * who sent it: it is recorded, with one task for a person to confirm who
 * asked (`VERIFY_TASK_TITLE`, the name and address they gave in its detail),
 * and the visitor is thanked — no scan (a new scan would supersede the one
 * every draft and proposal quotes), no contact or consent, no deal moved,
 * and no audit page, whose findings are the agency's evidence about a
 * prospect. Only a site AND an address nobody has on file are filed as a new
 * inbound lead, scanned and answered with their page.
 *
 * The caps are counted under `pg_advisory_xact_lock(hashtext('check.requested'),
 * hashtext(orgId))`, in the transaction that writes the request's own row, so
 * twenty requests arriving at once cannot each read nineteen.
 *
 * This records the request; for a new lead the route then scans the site
 * (bounded) and mints the business's audit page link. Audited
 * `check.requested` — ids and whether it was already on file, never the
 * address or the name.
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { normaliseEmail } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { orgByBookingSlug } from './booking.js'
import { isKnownTimeZone, recordConsent } from './contacts.js'
import { advanceDeal } from './deals.js'
import { tasksCreate } from './tasks.js'

export const CHECKS_PER_HOUR = 20

/** The task a request naming a site or an address on file leaves, one open at a time per company. */
export const VERIFY_TASK_TITLE = 'Confirm who asked for a free website check'

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
  /** A new inbound lead: the route scans the site and answers with the business's page. */
  | { readonly ok: true; readonly recognised: false; readonly orgId: string; readonly orgName: string; readonly companyId: string }
  /** A site or an address already on file: recorded, a task made, nothing else — the visitor is only thanked. */
  | { readonly ok: true; readonly recognised: true; readonly orgId: string; readonly orgName: string }
  | { readonly ok: false; readonly status: 400 | 404 | 429; readonly message: string }

const BUSY = 'A lot of sites are being checked right now. Please try again in an hour.'
const AGAIN = 'This site was checked a few minutes ago. Please try again in an hour.'

/** What the task tells a person: who asked, in their own words, and that nothing was done. */
export function verifyTaskDetail(domain: string, name: string, email: string): string {
  return (
    `Someone asked for a free website check of ${domain} through the public check page, giving the name ` +
    `“${name}” and the address ${email}. That site or address is already on file, so nothing was scanned, changed ` +
    'or sent, and they were only thanked. They may not be who they say they are: confirm with the business before ' +
    'you send them anything or share what we found.'
  )
}

export async function websiteCheckRequest(db: AgencyDb, req: CheckRequest): Promise<CheckOutcome> {
  const org = await orgByBookingSlug(db, req.slug)
  if (!org) return { ok: false, status: 404, message: 'This page is not active.' }
  const email = normaliseEmail(req.email)
  if (!email) return { ok: false, status: 400, message: 'That does not look like an email address.' }
  const name = req.name.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!name) return { ok: false, status: 400, message: 'Please tell us your name.' }
  const zone = req.timeZone && isKnownTimeZone(req.timeZone) ? req.timeZone : 'Asia/Kolkata'
  const hourAgo = new Date(req.now.getTime() - 3_600_000)

  return db.transaction(async (tx): Promise<CheckOutcome> => {
    const t = tx as unknown as AgencyDb
    // Every read below is under the org's lock, so the caps hold for requests that arrive together.
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('check.requested'), hashtext(${org.id}))`)
    const [recent] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, org.id), eq(schema.auditLog.action, 'check.requested'), gte(schema.auditLog.createdAt, hourAgo)))
    if ((recent?.n ?? 0) >= CHECKS_PER_HOUR) return { ok: false, status: 429, message: BUSY }

    const [company] = await t
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, org.id), eq(schema.companies.domain, req.domain)))
      .limit(1)
    const [known] = await t
      .select({ id: schema.contacts.id, companyId: schema.contacts.companyId })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, org.id), eq(schema.contacts.email, email)))
      .limit(1)
    const askedOf = [company?.id, known?.id].filter((id): id is string => Boolean(id))
    for (const subjectId of askedOf) {
      const [again] = await t
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(and(
          eq(schema.auditLog.orgId, org.id), eq(schema.auditLog.action, 'check.requested'), eq(schema.auditLog.subjectId, subjectId),
          gte(schema.auditLog.createdAt, hourAgo),
        ))
        .limit(1)
      if (again) return { ok: false, status: 429, message: AGAIN }
    }

    if (company || known) {
      const companyId = company?.id ?? known?.companyId ?? null
      const [open] = companyId
        ? await t
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(and(
              eq(schema.tasks.orgId, org.id), eq(schema.tasks.companyId, companyId), eq(schema.tasks.title, VERIFY_TASK_TITLE),
              isNull(schema.tasks.doneAt),
            ))
            .limit(1)
        : []
      // In a savepoint: a refused task must not take the request's own row with it.
      const task = open
        ? null
        : await t
            .transaction((sp) =>
              tasksCreate(sp as unknown as AgencyDb, {
                orgId: org.id, kind: 'todo', title: VERIFY_TASK_TITLE, detail: verifyTaskDetail(req.domain, name, email),
                companyId, dueAt: req.now, createdBy: null, actor: 'website_check',
              }),
            )
            .catch(() => null)
      await appendAudit(t, {
        orgId: org.id, actor: 'website_check', action: 'check.requested',
        subjectType: company ? 'company' : 'contact', subjectId: company?.id ?? known!.id,
        detail: {
          recognised: true,
          by: company && known ? 'site_and_address' : company ? 'site' : 'address',
          task: open ? 'already_open' : task?.ok ? 'made' : 'not_made',
        },
      })
      return { ok: true, recognised: true, orgId: org.id, orgName: org.name }
    }

    const [created] = await t
      .insert(schema.companies)
      .values({ orgId: org.id, domain: req.domain, name: req.businessName?.trim().slice(0, 120) || null, source: 'inbound', timeZone: zone })
      .returning({ id: schema.companies.id })
    const companyId = created!.id
    const [contact] = await t
      .insert(schema.contacts)
      .values({ orgId: org.id, companyId, email, firstName: name.split(' ')[0] ?? name, lastName: name.split(' ').slice(1).join(' ') || null, timeZone: zone })
      .returning({ id: schema.contacts.id })
    await recordConsent(t, {
      orgId: org.id, contactId: contact!.id, channel: 'email', granted: true, source: 'website check form',
      evidence: { wording: req.consentWording, at: req.now.toISOString() },
    })
    await advanceDeal(t, { orgId: org.id, companyId, to: 'replied', nextAction: 'Call — they asked for a free website check' })
    await appendAudit(t, {
      orgId: org.id, actor: 'website_check', action: 'check.requested', subjectType: 'company', subjectId: companyId,
      detail: { recognised: false },
    })
    return { ok: true, recognised: false, orgId: org.id, orgName: org.name, companyId }
  })
}
