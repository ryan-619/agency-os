/**
 * A website certificate about to expire (2026-10-08): a dated reason to call.
 * After that day, browsers warn a business's customers that its site is not
 * secure — and the agency renews certificates.
 *
 * Read from evidence only: the certificate's expiry date as the scanner saw it
 * (`tls` finding, `evidence.expires`) on a company's LATEST successful scan,
 * and only while that scan is inside its re-verification deadline
 * (`staleAfterDaysOf`) — a certificate seen weeks ago may have been renewed
 * since. Within `CERT_ALERT_DAYS` of the date (or up to a week past it), a
 * task for the open deal's owner, or nobody: a call where there is a number
 * nobody asked us to stop calling, a to-do otherwise. Once per company per
 * expiry date (`cert.alerted`). The daily cron runs it; nothing is sent.
 */
import { and, eq, isNull, desc, sql } from 'drizzle-orm'
import { isStale, staleAfterDaysOf } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { activeIcpProfile } from './repository.js'
import { appendAudit } from './approvals.js'
import { tasksCreate } from './tasks.js'

export const CERT_ALERT_DAYS = 14
const DAY = 86_400_000

const rowsOf = (res: unknown): Record<string, unknown>[] =>
  (Array.isArray(res) ? res : ((res as { rows?: unknown[] } | null)?.rows ?? [])) as Record<string, unknown>[]

/** Days from `now` to an expiry date (YYYY-MM-DD, the end of that day in UTC); negative once it has passed. */
export function daysToCertExpiry(expires: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return null
  const end = Date.parse(`${expires}T23:59:59Z`)
  return Number.isNaN(end) ? null : Math.floor((end - now.getTime()) / DAY)
}

export async function certificateAlerts(db: AgencyDb, args: { readonly now: Date; readonly orgId?: string }): Promise<{ readonly alerted: number }> {
  const since = new Date(args.now.getTime() - 60 * DAY)
  const rows = rowsOf(await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (company_id) id, org_id, company_id, ran_at
        FROM scans
       WHERE ok AND ran_at >= ${since.toISOString()}::timestamptz
             ${args.orgId ? sql`AND org_id = ${args.orgId}::uuid` : sql``}
       ORDER BY company_id, ran_at DESC
    )
    SELECT l.org_id, l.company_id, l.ran_at, f.evidence->>'expires' AS expires, co.name, co.domain
      FROM latest l
      JOIN findings f ON f.scan_id = l.id AND f.signal_key = 'tls' AND f.observed
      JOIN companies co ON co.id = l.company_id
     WHERE f.evidence->>'expires' IS NOT NULL`))
  const deadlines = new Map<string, number>()
  let alerted = 0
  for (const r of rows) {
    const orgId = String(r.org_id)
    const companyId = String(r.company_id)
    const expires = String(r.expires)
    const ranAt = r.ran_at instanceof Date ? r.ran_at : new Date(String(r.ran_at))
    const left = daysToCertExpiry(expires, args.now)
    if (left === null || left > CERT_ALERT_DAYS || left < -7) continue
    if (!deadlines.has(orgId)) deadlines.set(orgId, staleAfterDaysOf((await activeIcpProfile(db, orgId))?.definition))
    if (isStale(ranAt, deadlines.get(orgId)!, args.now)) continue
    const [already] = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.action, 'cert.alerted'),
        eq(schema.auditLog.subjectId, companyId),
        sql`${schema.auditLog.detail}->>'expires' = ${expires}`,
      ))
      .limit(1)
    if (already) continue
    const [deal] = await db
      .select({ id: schema.deals.id, ownerUserId: schema.deals.ownerUserId })
      .from(schema.deals)
      .where(and(eq(schema.deals.orgId, orgId), eq(schema.deals.companyId, companyId), isNull(schema.deals.closedAt)))
      .orderBy(desc(schema.deals.createdAt))
      .limit(1)
    const name = [...String(r.name || r.domain)].slice(0, 60).join('')
    const when = left < 0 ? `expired on ${expires}` : left === 0 ? `expires today (${expires})` : `expires on ${expires}, in ${left} ${left === 1 ? 'day' : 'days'}`
    const title = left < 0 ? `Tell ${name} their website’s certificate has expired` : `Tell ${name} their website’s certificate ${left <= 1 ? 'expires now' : `expires in ${left} days`}`
    const detail =
      `Our scan of ${String(r.domain)} on ${ranAt.toISOString().slice(0, 10)} saw that its security certificate ${when}. ` +
      'After that day, browsers warn visitors that the site is not secure, and many leave. Offer to renew it — and to set up ' +
      'automatic renewal so it does not happen again.'
    // A call where there is a number to call, a to-do otherwise; the deal's owner while they have access, nobody otherwise.
    attempt: for (const assignee of deal?.ownerUserId ? [deal.ownerUserId, null] : [null]) {
      for (const kind of ['call', 'todo'] as const) {
        const made = await tasksCreate(db, {
          orgId, companyId, dealId: deal?.id ?? null, kind, title: [...title].slice(0, 200).join(''), detail,
          assigneeUserId: assignee, dueAt: args.now, createdBy: null, actor: 'system',
        }).catch(() => null)
        if (made?.ok) {
          await appendAudit(db, {
            orgId, actor: 'system', action: 'cert.alerted', subjectType: 'company', subjectId: companyId,
            detail: { expires, daysLeft: left, taskId: made.task.id },
          })
          alerted += 1
          break attempt
        }
        if (made && made.reason === 'assignee_not_in_org') break
      }
    }
  }
  return { alerted }
}
