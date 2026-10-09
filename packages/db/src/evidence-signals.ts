/**
 * What changed (2026-10-09): a dated reason to reach out, read from our own
 * scans and nothing else.
 *
 * A re-scan that finds a gap CLOSED says the business is investing in its
 * site — the moment to offer the next thing. One that finds a gap OPENED is
 * a problem they can see for themselves — the moment to call. Both were
 * already visible one company at a time (`get_evidence_changes`, the company
 * page's diff) and nowhere together, so nobody saw them until they looked.
 *
 * `recordScan` calls `noteEvidenceChange` after writing an `ok` scan's
 * findings: it compares them with the previous successful scan's through
 * `diffFindings` — the one reader of a change (§2, "Evidence: history, the
 * diff and the timeline"): a signal neither scan observed is not a change,
 * a side with nothing to judge is never a fix or a regression — over SCORED
 * signals only, and when something was fixed or regressed it appends ONE
 * `evidence.changed` row: ids, counts and signal KEYS, never the details. A
 * company with an open deal also gets one task for the deal's owner, or
 * nobody — a call where there is a number nobody asked us to stop calling,
 * a to-do otherwise — titled by what changed and dated by the scan. The
 * audit row is the record and the dedupe: one per scan, so a scan is noted
 * once however many readers run.
 *
 * `whatChanged` reads those rows back for the dashboard, the morning brief
 * and chat (`get_evidence_signals`), with each company as it is now. The
 * keys are worded through the ICP's `why`, the words a finding is shown
 * under everywhere else. Nothing here sends anything.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { diffFindings, type IcpDefinition } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { findingsForScan } from './evidence.js'
import { tasksCreate } from './tasks.js'

export const EVIDENCE_SIGNALS_DAYS = 7
export const EVIDENCE_SIGNALS_MAX = 10
/** A task names at most this many signals; the row names them all. */
const TASK_SIGNALS_MAX = 3

const DAY = 86_400_000

export interface EvidenceChangeNote {
  readonly fixed: readonly string[]
  readonly regressed: readonly string[]
  readonly taskId: string | null
}

/**
 * Compare a just-recorded successful scan with the one before it and note
 * what changed. Runs inside `recordScan`'s transaction, after the findings
 * are written. Null when there is no earlier successful scan or nothing
 * scored was fixed or regressed; it never throws past a failed note, because
 * a scan that was recorded must not be rolled back for a line about it.
 */
export async function noteEvidenceChange(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly scanId: string
    readonly icp: IcpDefinition
    readonly now?: Date
  },
): Promise<EvidenceChangeNote | null> {
  const now = args.now ?? new Date()
  const [newer, older] = await db
    .select({ id: schema.scans.id, ranAt: schema.scans.ranAt })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, args.orgId), eq(schema.scans.companyId, args.companyId), eq(schema.scans.ok, true)))
    .orderBy(desc(schema.scans.ranAt), desc(schema.scans.id))
    .limit(2)
  // The scan just written is the newest; anything else means a concurrent
  // writer, and then the comparison is theirs to make.
  if (!newer || newer.id !== args.scanId || !older) return null

  const [newerFindings, olderFindings] = await Promise.all([
    findingsForScan(db, args.orgId, newer.id),
    findingsForScan(db, args.orgId, older.id),
  ])
  const input = (f: (typeof newerFindings)[number]) => ({
    signalKey: f.signalKey, observed: f.observed, gap: f.gap, detail: f.detail,
    evidence: (f.evidence ?? {}) as Readonly<Record<string, unknown>>, weight: f.weight, scored: f.scored,
  })
  const diff = diffFindings(olderFindings.map(input), newerFindings.map(input))
  const scored = diff.rows.filter((r) => r.scored)
  const fixed = scored.filter((r) => r.change === 'fixed').map((r) => r.signalKey).sort()
  const regressed = scored.filter((r) => r.change === 'regressed').map((r) => r.signalKey).sort()
  if (fixed.length === 0 && regressed.length === 0) return null

  // A task only where somebody is working the company: an open deal.
  let taskId: string | null = null
  const [deal] = await db
    .select({ id: schema.deals.id, ownerUserId: schema.deals.ownerUserId })
    .from(schema.deals)
    .where(and(eq(schema.deals.orgId, args.orgId), eq(schema.deals.companyId, args.companyId), isNull(schema.deals.closedAt)))
    .orderBy(desc(schema.deals.createdAt))
    .limit(1)
  if (deal) {
    const [co] = await db
      .select({ name: schema.companies.name, domain: schema.companies.domain, phone: schema.companies.phone })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
      .limit(1)
    const name = [...String(co?.name || co?.domain || 'the company')].slice(0, 60).join('')
    const why = (key: string) => args.icp.signals[key]?.why ?? key
    const list = (keys: readonly string[]) =>
      keys.slice(0, TASK_SIGNALS_MAX).map(why).join('; ') + (keys.length > TASK_SIGNALS_MAX ? ` and ${keys.length - TASK_SIGNALS_MAX} more` : '')
    const date = newer.ranAt.toISOString().slice(0, 10)
    const title =
      regressed.length > 0
        ? `Call ${name}: their site lost something since our last look`
        : `Follow up ${name}: they fixed something on their site`
    const detail = [
      `Our scan of ${String(co?.domain ?? '')} on ${date} differs from the one before it.`,
      regressed.length > 0 ? `New gaps: ${list(regressed)}. A problem they can see for themselves — a dated reason to call.` : null,
      fixed.length > 0 ? `Fixed: ${list(fixed)}. They are investing in their site — the moment to offer the next thing.` : null,
      'Read the company page before you get in touch; only what the latest scan observed may be quoted.',
    ]
      .filter(Boolean)
      .join(' ')
    attempt: for (const assignee of deal.ownerUserId ? [deal.ownerUserId, null] : [null]) {
      for (const kind of ['call', 'todo'] as const) {
        const made = await tasksCreate(db, {
          orgId: args.orgId, companyId: args.companyId, dealId: deal.id, kind, title: [...title].slice(0, 200).join(''), detail,
          assigneeUserId: assignee, dueAt: now, createdBy: null, actor: 'system',
        }).catch(() => null)
        if (made?.ok) {
          taskId = made.task.id
          break attempt
        }
        if (made && made.reason === 'assignee_not_in_org') break
      }
    }
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: 'system',
    action: 'evidence.changed',
    subjectType: 'company',
    subjectId: args.companyId,
    detail: {
      scanId: args.scanId,
      olderScanId: older.id,
      fixed: fixed.length,
      regressed: regressed.length,
      keys: { fixed, regressed },
      taskId,
    },
  })
  return { fixed, regressed, taskId }
}

export interface EvidenceSignal {
  readonly at: Date
  readonly company: { readonly id: string; readonly domain: string; readonly name: string | null }
  readonly fixed: readonly string[]
  readonly regressed: readonly string[]
  readonly taskId: string | null
  /** The company has an open deal now. */
  readonly openDeal: boolean
}

/** What changed in the last `sinceDays`, newest first, each company as it is now. */
export async function whatChanged(
  db: AgencyDb,
  args: { readonly orgId: string; readonly now: Date; readonly sinceDays?: number; readonly limit?: number },
): Promise<EvidenceSignal[]> {
  const since = new Date(args.now.getTime() - (args.sinceDays ?? EVIDENCE_SIGNALS_DAYS) * DAY)
  const rows = await db
    .select({ createdAt: schema.auditLog.createdAt, subjectId: schema.auditLog.subjectId, detail: schema.auditLog.detail })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, args.orgId),
        eq(schema.auditLog.action, 'evidence.changed'),
        sql`${schema.auditLog.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(Math.max(1, Math.min(args.limit ?? EVIDENCE_SIGNALS_MAX, 50)))
  const ids = [...new Set(rows.map((r) => r.subjectId).filter((s): s is string => typeof s === 'string'))]
  if (ids.length === 0) return []
  const [companies, deals] = await Promise.all([
    db
      .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, args.orgId), inArray(schema.companies.id, ids))),
    db
      .select({ companyId: schema.deals.companyId })
      .from(schema.deals)
      .where(and(eq(schema.deals.orgId, args.orgId), inArray(schema.deals.companyId, ids), isNull(schema.deals.closedAt))),
  ])
  const byId = new Map(companies.map((c) => [c.id, c]))
  const open = new Set(deals.map((d) => d.companyId))
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: EvidenceSignal[] = []
  for (const r of rows) {
    const company = r.subjectId ? byId.get(r.subjectId) : undefined
    if (!company) continue
    const d = (r.detail ?? {}) as Record<string, unknown>
    const keys = (d.keys ?? {}) as Record<string, unknown>
    out.push({
      at: r.createdAt,
      company,
      fixed: strings(keys.fixed),
      regressed: strings(keys.regressed),
      taskId: typeof d.taskId === 'string' ? d.taskId : null,
      openDeal: open.has(company.id),
    })
  }
  return out
}
