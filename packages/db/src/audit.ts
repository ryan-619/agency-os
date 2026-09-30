/**
 * Reading the audit log (PROMPT.md §2.4, §4).
 *
 * "Approval decides, the audit log remembers." Everything that writes to
 * this system writes a line to `audit_log`, and until now nothing read it
 * back: the record existed and nobody could see it. These are its readers —
 * for /audit, and for any page that wants one entity's history. Nothing here
 * writes; `appendAudit` in approvals.ts is the one writer, and 0007's trigger
 * makes the table append-only underneath both.
 *
 * Four things a reader of this table has to get right, each of which looks
 * fine and is not:
 *
 *   * **Keyset paging on a microsecond column with a millisecond cursor.**
 *     `created_at` is `timestamptz`, which Postgres stores to the
 *     microsecond; a JavaScript `Date` holds milliseconds. A cursor built
 *     from the last row's `Date` is therefore EARLIER than the row it came
 *     from, by up to 999µs, and `(created_at, id) < cursor` skips every row
 *     written inside that gap — silently, on the one page that exists to
 *     show everything. So the comparison reads the cursor row's own stored
 *     `created_at`, by id, and the `Date` is only the fallback for a cursor
 *     row that no longer exists (an org cascade is the one DELETE allowed).
 *   * **`subject_id` is a uuid with no foreign key.** A subject can be gone
 *     and the row survives pointing at nothing — 0003's comment says the
 *     audit log "is what survives as the record". Every join here is a
 *     lookup that tolerates a miss, never an inner join that drops the row.
 *   * **`actor` is text.** A users.id, or a literal: `agent`, `system`,
 *     `voice`, `booking_page`, `share_link`. Only uuid-shaped actors are
 *     looked up, and a uuid that no longer resolves is a former teammate,
 *     not an error.
 *   * **Every query carries the org.** Subject ids and user ids are global
 *     uuids; a guessed id from another org must answer nothing, including on
 *     the cursor's own lookup.
 */
import { and, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type AuditRow = typeof schema.auditLog.$inferSelect

/** A page is bounded: nothing prunes this table, so "all of it" is not a page. */
export const AUDIT_PAGE_MAX = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The last row of the previous page. */
export interface AuditCursor {
  readonly createdAt: Date
  readonly id: string
}

export interface AuditListOptions {
  readonly limit?: number
  /** Rows strictly older than this one, in (created_at, id) order. */
  readonly before?: AuditCursor | null
  /**
   * A whole dotted segment, or a whole action: `send` matches `send.sent`
   * and `send.quiet_hours`, `send.sent` matches only itself, and neither
   * matches `sender.x`. Not a substring search — `_` is a LIKE wildcard and
   * nearly every action name contains one, so the prefix is escaped.
   */
  readonly actionPrefix?: string | null
  readonly actor?: string | null
  readonly subjectType?: string | null
  readonly subjectId?: string | null
}

/** Escape LIKE's metacharacters so a prefix means exactly what it says. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function pageSize(limit: number | undefined): number {
  const n = Math.trunc(limit ?? 100)
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), AUDIT_PAGE_MAX) : 100
}

/**
 * One page of the org's audit log, newest first.
 *
 * Ordered by (created_at, id) descending, which `audit_log_org_created_idx`
 * serves, with the id as the tie-break: rows written in one transaction
 * share a `now()`, and without a total order a page boundary between two of
 * them would show one twice or neither.
 *
 * A subject id or cursor id that is not a uuid matches no row, so it answers
 * an empty page rather than a Postgres cast error — both arrive from a URL.
 */
export async function listAudit(
  db: AgencyDb,
  orgId: string,
  opts: AuditListOptions = {},
): Promise<AuditRow[]> {
  const t = schema.auditLog
  const where: SQL[] = [eq(t.orgId, orgId)]

  if (opts.subjectId !== undefined && opts.subjectId !== null) {
    if (!UUID.test(opts.subjectId)) return []
    where.push(eq(t.subjectId, opts.subjectId))
  }
  if (opts.subjectType) where.push(eq(t.subjectType, opts.subjectType))
  if (opts.actor) where.push(eq(t.actor, opts.actor))

  const prefix = opts.actionPrefix?.trim().replace(/\.+$/, '')
  if (prefix) {
    const byPrefix = or(eq(t.action, prefix), like(t.action, `${escapeLike(prefix)}.%`))
    if (byPrefix) where.push(byPrefix)
  }

  if (opts.before) {
    if (!UUID.test(opts.before.id)) return []
    // The cursor row's STORED timestamp, to the microsecond — see the header.
    // Org-scoped, so another org's id falls through to the given Date.
    where.push(sql`(${t.createdAt}, ${t.id}) < (
      COALESCE(
        (SELECT c.created_at FROM audit_log c WHERE c.id = ${opts.before.id}::uuid AND c.org_id = ${orgId}::uuid),
        ${opts.before.createdAt.toISOString()}::timestamptz
      ),
      ${opts.before.id}::uuid
    )`)
  }

  return db
    .select()
    .from(t)
    .where(and(...where))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(pageSize(opts.limit))
}

/**
 * Everything recorded about one entity, newest first — `audit_log_subject_idx`.
 *
 * Only what names the entity as its SUBJECT. A deal moved by a send, a reply
 * or a booking is recorded inside `send.sent`, `contact.replied` or
 * `meeting.booked`, whose subject is the touch, the contact or the meeting;
 * a caller wanting a deal's whole story has to union those in.
 */
export async function auditForSubject(
  db: AgencyDb,
  orgId: string,
  subjectType: string,
  subjectId: string,
  limit = 100,
): Promise<AuditRow[]> {
  return listAudit(db, orgId, { subjectType, subjectId, limit })
}

export interface AuditCompany {
  readonly id: string
  readonly domain: string
  readonly name: string | null
}

type SubjectRef = Pick<AuditRow, 'id' | 'subjectType' | 'subjectId' | 'detail'>

/** The subject types whose row names a company. */
const COMPANY_SUBJECTS = new Set(['deal', 'contact', 'touch', 'meeting', 'proposal', 'company'])

/**
 * Which company each row is about, for the sentence and the link.
 *
 * The subject's own row is asked first — `deals`, `contacts`, `touches`
 * (its company, else its contact's), `meetings`, `proposals` — one batched
 * select per type. When the subject is gone (an erased contact, a deleted
 * touch) the row's own `detail.companyId` is the fallback, which most
 * pipeline rows carry. Either way the company is looked up inside the org,
 * so a stray id resolves to nothing rather than to somebody else's company.
 *
 * A row with no resolvable company is simply absent from the map: "a
 * company that no longer exists" is for the page to say, not a throw.
 */
export async function auditSubjectsToCompanies(
  db: AgencyDb,
  orgId: string,
  rows: readonly SubjectRef[],
): Promise<Map<string, AuditCompany>> {
  const idsOf = (type: string): string[] => [
    ...new Set(
      rows
        .filter((r) => r.subjectType === type && r.subjectId !== null && UUID.test(r.subjectId))
        .map((r) => r.subjectId as string),
    ),
  ]

  // subject type → (subject id → company id)
  const viaSubject = new Map<string, Map<string, string>>()
  const put = (type: string, pairs: readonly { id: string; companyId: string | null }[]): void => {
    const m = new Map<string, string>()
    for (const p of pairs) if (p.companyId) m.set(p.id, p.companyId)
    viaSubject.set(type, m)
  }

  const deals = idsOf('deal')
  const contacts = idsOf('contact')
  const touches = idsOf('touch')
  const meetings = idsOf('meeting')
  const proposals = idsOf('proposal')

  await Promise.all([
    deals.length
      ? db
          .select({ id: schema.deals.id, companyId: schema.deals.companyId })
          .from(schema.deals)
          .where(and(eq(schema.deals.orgId, orgId), inArray(schema.deals.id, deals)))
          .then((r) => put('deal', r))
      : null,
    contacts.length
      ? db
          .select({ id: schema.contacts.id, companyId: schema.contacts.companyId })
          .from(schema.contacts)
          .where(and(eq(schema.contacts.orgId, orgId), inArray(schema.contacts.id, contacts)))
          .then((r) => put('contact', r))
      : null,
    touches.length
      ? db
          .select({
            id: schema.touches.id,
            // A touch's company is nullable (SET NULL); its contact's is not.
            companyId: sql<string | null>`COALESCE(${schema.touches.companyId}, ${schema.contacts.companyId})`,
          })
          .from(schema.touches)
          .leftJoin(
            schema.contacts,
            and(eq(schema.contacts.id, schema.touches.contactId), eq(schema.contacts.orgId, orgId)),
          )
          .where(and(eq(schema.touches.orgId, orgId), inArray(schema.touches.id, touches)))
          .then((r) => put('touch', r))
      : null,
    meetings.length
      ? db
          .select({ id: schema.meetings.id, companyId: schema.meetings.companyId })
          .from(schema.meetings)
          .where(and(eq(schema.meetings.orgId, orgId), inArray(schema.meetings.id, meetings)))
          .then((r) => put('meeting', r))
      : null,
    proposals.length
      ? db
          .select({ id: schema.proposals.id, companyId: schema.proposals.companyId })
          .from(schema.proposals)
          .where(and(eq(schema.proposals.orgId, orgId), inArray(schema.proposals.id, proposals)))
          .then((r) => put('proposal', r))
      : null,
  ])

  const companyIdFor = new Map<string, string>()
  for (const r of rows) {
    let companyId: string | undefined
    if (r.subjectType && r.subjectId && COMPANY_SUBJECTS.has(r.subjectType)) {
      companyId = r.subjectType === 'company' ? r.subjectId : viaSubject.get(r.subjectType)?.get(r.subjectId)
    }
    if (!companyId) {
      const fromDetail = (r.detail as Record<string, unknown> | null)?.['companyId']
      if (typeof fromDetail === 'string' && UUID.test(fromDetail)) companyId = fromDetail
    }
    if (companyId) companyIdFor.set(r.id, companyId)
  }

  const companyIds = [...new Set(companyIdFor.values())]
  const out = new Map<string, AuditCompany>()
  if (companyIds.length === 0) return out

  const companies = new Map(
    (
      await db
        .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
        .from(schema.companies)
        .where(and(eq(schema.companies.orgId, orgId), inArray(schema.companies.id, companyIds)))
    ).map((c) => [c.id, c] as const),
  )
  for (const [auditId, companyId] of companyIdFor) {
    const c = companies.get(companyId)
    if (c) out.set(auditId, c)
  }
  return out
}

export interface AuditActor {
  readonly email: string | null
  readonly name: string | null
  /** 0018: offboarding is a role change, not a deletion. They did this while they had access. */
  readonly revoked: boolean
}

/**
 * Who each uuid-shaped actor is, inside the org.
 *
 * The literals (`agent`, `system`, …) are not looked up — they are not
 * users. A uuid missing from the answer is somebody no longer on the team;
 * the page says "a former teammate" rather than showing a raw id or nothing.
 */
export async function auditResolveActors(
  db: AgencyDb,
  orgId: string,
  actors: readonly string[],
): Promise<Map<string, AuditActor>> {
  const ids = [...new Set(actors.filter((a) => UUID.test(a)))]
  const out = new Map<string, AuditActor>()
  if (ids.length === 0) return out
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      revokedAt: schema.users.revokedAt,
    })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, ids)))
  for (const u of rows) out.set(u.id, { email: u.email, name: u.name, revoked: u.revokedAt !== null })
  return out
}
