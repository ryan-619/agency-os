/**
 * The query behind the sidebar box and `GET /api/search`: companies, people,
 * deals, meetings, proposals, campaigns and messages by text, within one org
 * and within what the caller may see.
 *
 * Three rules shape every line of it.
 *
 * **The needle is literal.** `%` and `_` are LIKE wildcards and `\` is the
 * escape character, so a search for "50%_off" left as-is also matches
 * "50x_off" — and a search for "%" matches every row in the org. Every
 * pattern is built by `containsPattern`, and a source test
 * (`apps/web/test/search-source.test.ts`) asserts every `ilike(` here takes a
 * variable named `pattern` and never the raw query.
 *
 * **Every branch is org-scoped, joins included.** Each select starts its
 * WHERE with the table's own `org_id`, and every join to `companies`
 * re-checks `companies.org_id` — the foreign keys to `companies` are by `id`
 * alone, so a row pointing across orgs would otherwise print another
 * agency's domain in this one's results.
 *
 * **Some things are never searchable (§2.3), and the file does not name
 * them.** Connectors and their config, stored credentials, agent prompts,
 * chat titles (a title IS the first prompt) and messages, approval payloads,
 * audit detail, raw scan headers, findings, the roster and a touch's
 * provider id. The source test fails if any of those tables or columns is
 * referenced here at all — an exclusion kept by absence cannot be widened
 * by a filter somebody forgets. A hit carries a label, one line of context
 * and a link; the result list is not the record.
 *
 * `ILIKE '%x%'` is a sequential scan within the org. That is acceptable at a
 * few hundred companies and is the reason both caps exist; trigram indexes
 * are a separate migration with an engine dependency, not part of this one.
 */
import { and, asc, desc, eq, ilike, or, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { can, type Principal } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

/** Rows per section. One more is read to know whether there were more. */
export const SEARCH_PER_SECTION = 10
/** Hits in one answer, across every section. */
export const SEARCH_TOTAL = 50
/** One character on `%x%` matches nearly every row of every table. */
export const SEARCH_MIN_CHARS = 2
export const SEARCH_MAX_CHARS = 100

export type SearchKind = 'company' | 'contact' | 'deal' | 'meeting' | 'proposal' | 'campaign' | 'touch'

export interface SearchHit {
  readonly kind: SearchKind
  readonly id: string
  /** What the row is called. Never a message body. */
  readonly label: string
  /** One line of context — the company, a stage, a status. */
  readonly sub: string | null
  /** The page that shows it. Contacts, deals and touches have no page of
   *  their own and point at their company's. */
  readonly href: string
}

/**
 * Which sections the caller may see. The route fills this from `can()` via
 * `searchSectionsFor`; a false section is never queried, so a row it would
 * have matched cannot reach the answer even by accident.
 */
export interface SearchSections {
  readonly companies: boolean
  readonly contacts: boolean
  readonly deals: boolean
  readonly campaigns: boolean
  readonly meetings: boolean
  readonly proposals: boolean
  /** Subject and recipient of every message, and the body of a REPLY. */
  readonly touches: boolean
  /**
   * The body of an OUTBOUND message. A draft body is the thing a person
   * approves, so it is found only by somebody who may approve it — and a
   * sent message was a draft first.
   */
  readonly draftBodies: boolean
}

export interface SearchResult {
  readonly hits: SearchHit[]
  /** A section had more than it returned, or the total cap cut the list. */
  readonly truncated: boolean
}

/**
 * A LIKE/ILIKE pattern that matches the needle LITERALLY.
 *
 * Postgres's default LIKE escape is backslash and drizzle binds the value as
 * a parameter (no string-literal backslash processing, and
 * `standard_conforming_strings` is on), so one backslash before each
 * metacharacter is exactly right on PGlite, PG16 and Neon — measured, not
 * assumed. Backslash is escaped too: a lone `\` would escape whatever the
 * needle put after it.
 */
export function escapeLike(needle: string): string {
  return needle.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** `%needle%` with the needle made literal. */
export function containsPattern(needle: string): string {
  return `%${escapeLike(needle)}%`
}

/**
 * The query as the box sent it, made into the query that is run: trimmed,
 * internal whitespace collapsed to one space, and bounded. Below the
 * minimum is a refusal rather than an empty answer, so the caller can say
 * why nothing came back.
 */
export function searchQueryFrom(
  input: string | null | undefined,
): { ok: true; q: string } | { ok: false; error: string } {
  const q = (input ?? '').replace(/\s+/g, ' ').trim()
  if (q.length < SEARCH_MIN_CHARS) return { ok: false, error: `q must be at least ${SEARCH_MIN_CHARS} characters` }
  if (q.length > SEARCH_MAX_CHARS) return { ok: false, error: `q must be at most ${SEARCH_MAX_CHARS} characters` }
  return { ok: true, q }
}

/**
 * The sections a principal may search, from the capabilities that already
 * gate each table's own page. There is no `search` capability: a search box
 * is another way of reading the same rows, so it asks the same questions.
 *
 * With today's two roles every section is open to everyone, and that is not
 * a reason to skip the check — a third role would otherwise silently widen.
 * `null` means the principal may read none of it; the route answers 403.
 */
export function searchSectionsFor(principal: Principal | null | undefined): SearchSections | null {
  const deals = can(principal, 'deals:read')
  const touches = can(principal, 'campaigns:read')
  const sections: SearchSections = {
    companies: can(principal, 'companies:read'),
    contacts: can(principal, 'contacts:read'),
    deals,
    meetings: deals,
    proposals: deals,
    campaigns: touches,
    touches,
    // Only meaningful alongside the touches section: a body is matched in
    // the same branch as the subject.
    draftBodies: touches && can(principal, 'approvals:decide'),
  }
  const any = sections.companies || sections.contacts || sections.deals || sections.campaigns
    || sections.meetings || sections.proposals || sections.touches
  return any ? sections : null
}

/**
 * Search one org. `q` is normalised again here, so a caller that skipped
 * `searchQueryFrom` gets an empty answer below the minimum rather than every
 * row in the org.
 *
 * The sections run in parallel (on a one-connection pool they serialise,
 * which is fine) and merge in a fixed order — companies, people, deals,
 * meetings, proposals, campaigns, messages — so the same query gives the
 * same list.
 */
export async function searchOrg(
  db: AgencyDb,
  orgId: string,
  q: string,
  sections: SearchSections,
): Promise<SearchResult> {
  const parsed = searchQueryFrom(q)
  if (!parsed.ok) return { hits: [], truncated: false }
  const pattern = containsPattern(parsed.q)
  const stage = parsed.q.toLowerCase()

  const none = async (): Promise<SearchHit[]> => []
  const parts = await Promise.all([
    sections.companies ? searchCompanies(db, orgId, pattern) : none(),
    sections.contacts ? searchContacts(db, orgId, pattern) : none(),
    sections.deals ? searchDeals(db, orgId, pattern, stage) : none(),
    sections.meetings ? searchMeetings(db, orgId, pattern) : none(),
    sections.proposals ? searchProposals(db, orgId, pattern) : none(),
    sections.campaigns ? searchCampaigns(db, orgId, pattern) : none(),
    sections.touches ? searchTouches(db, orgId, pattern, sections.draftBodies) : none(),
  ])

  let truncated = false
  const hits: SearchHit[] = []
  for (const part of parts) {
    if (part.length > SEARCH_PER_SECTION) truncated = true
    hits.push(...part.slice(0, SEARCH_PER_SECTION))
  }
  if (hits.length > SEARCH_TOTAL) truncated = true
  return { hits: hits.slice(0, SEARCH_TOTAL), truncated }
}

// ---------------------------------------------------------------------------
// The sections. Each reads SEARCH_PER_SECTION + 1 rows so the merge can tell
// "exactly ten" from "ten of more".
// ---------------------------------------------------------------------------

const READ = SEARCH_PER_SECTION + 1

function companyHref(domain: string): string {
  return `/companies/${encodeURIComponent(domain)}`
}

function companyWord(domain: string | null, name: string | null): string | null {
  return name ?? domain
}

function joined(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  return kept.length > 0 ? kept.join(' · ') : null
}

function fullName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' ')
  return name === '' ? null : name
}

/**
 * Every join to `companies`, with the org re-checked: the foreign keys are
 * by `id` alone, so the join is where another org's row would get in.
 */
function companyOf(companyId: AnyPgColumn, orgId: string): SQL | undefined {
  return and(eq(schema.companies.id, companyId), eq(schema.companies.orgId, orgId))
}

async function searchCompanies(db: AgencyDb, orgId: string, pattern: string): Promise<SearchHit[]> {
  const rows = await db
    .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
    .from(schema.companies)
    .where(and(
      eq(schema.companies.orgId, orgId),
      or(
        ilike(schema.companies.domain, pattern),
        ilike(schema.companies.name, pattern),
        ilike(schema.companies.country, pattern),
        ilike(schema.companies.stage, pattern),
        ilike(schema.companies.title, pattern),
      ),
    ))
    .orderBy(asc(schema.companies.domain))
    .limit(READ)
  return rows.map((r) => ({
    kind: 'company' as const,
    id: r.id,
    label: r.name ?? r.domain,
    sub: r.name ? r.domain : null,
    href: companyHref(r.domain),
  }))
}

async function searchContacts(db: AgencyDb, orgId: string, pattern: string): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: schema.contacts.id,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      title: schema.contacts.title,
      domain: schema.companies.domain,
      companyName: schema.companies.name,
    })
    .from(schema.contacts)
    .innerJoin(schema.companies, companyOf(schema.contacts.companyId, orgId))
    .where(and(
      eq(schema.contacts.orgId, orgId),
      or(
        ilike(schema.contacts.firstName, pattern),
        ilike(schema.contacts.lastName, pattern),
        ilike(schema.contacts.email, pattern),
        ilike(schema.contacts.phone, pattern),
        ilike(schema.contacts.linkedinUrl, pattern),
        ilike(schema.contacts.title, pattern),
      ),
    ))
    .orderBy(asc(schema.contacts.lastName), asc(schema.contacts.firstName), asc(schema.contacts.id))
    .limit(READ)
  return rows.map((r) => {
    const name = fullName(r.firstName, r.lastName)
    return {
      kind: 'contact' as const,
      id: r.id,
      label: name ?? r.email ?? r.phone ?? 'Unnamed contact',
      sub: joined(name ? r.email : null, r.title, companyWord(r.domain, r.companyName)),
      href: companyHref(r.domain),
    }
  })
}

async function searchDeals(db: AgencyDb, orgId: string, pattern: string, stage: string): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: schema.deals.id,
      stage: schema.deals.stage,
      nextAction: schema.deals.nextAction,
      lostReason: schema.deals.lostReason,
      domain: schema.companies.domain,
      companyName: schema.companies.name,
    })
    .from(schema.deals)
    .innerJoin(schema.companies, companyOf(schema.deals.companyId, orgId))
    .where(and(
      eq(schema.deals.orgId, orgId),
      or(
        ilike(schema.deals.nextAction, pattern),
        ilike(schema.deals.lostReason, pattern),
        // A stage is a word from a fixed list, so "meeting" means that stage
        // and not every deal whose next action mentions one.
        eq(schema.deals.stage, stage),
      ),
    ))
    .orderBy(desc(schema.deals.createdAt), asc(schema.deals.id))
    .limit(READ)
  return rows.map((r) => ({
    kind: 'deal' as const,
    id: r.id,
    label: r.companyName ?? r.domain,
    sub: joined(r.stage, r.stage === 'lost' ? r.lostReason : r.nextAction),
    href: companyHref(r.domain),
  }))
}

/** "3 Oct 2026, 15:00 (Europe/London)" — in the meeting's zone, not the server's. */
function meetingWhen(startsAt: Date, zone: string): string {
  try {
    const at = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(startsAt)
    return `${at} (${zone})`
  } catch {
    // A zone the runtime does not know: the instant, labelled as what it is.
    return `${startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
}

async function searchMeetings(db: AgencyDb, orgId: string, pattern: string): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: schema.meetings.id,
      title: schema.meetings.title,
      startsAt: schema.meetings.startsAt,
      timeZone: schema.meetings.timeZone,
      cancelledAt: schema.meetings.cancelledAt,
      domain: schema.companies.domain,
      companyName: schema.companies.name,
    })
    .from(schema.meetings)
    .innerJoin(schema.companies, companyOf(schema.meetings.companyId, orgId))
    .where(and(
      eq(schema.meetings.orgId, orgId),
      or(ilike(schema.meetings.title, pattern), ilike(schema.meetings.notes, pattern)),
    ))
    .orderBy(desc(schema.meetings.startsAt), asc(schema.meetings.id))
    .limit(READ)
  return rows.map((r) => ({
    kind: 'meeting' as const,
    id: r.id,
    label: r.title ?? `Meeting with ${companyWord(r.domain, r.companyName)}`,
    sub: joined(meetingWhen(r.startsAt, r.timeZone), r.cancelledAt ? 'cancelled' : null, companyWord(r.domain, r.companyName)),
    href: `/meetings/${r.id}`,
  }))
}

async function searchProposals(db: AgencyDb, orgId: string, pattern: string): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: schema.proposals.id,
      title: schema.proposals.title,
      status: schema.proposals.status,
      domain: schema.companies.domain,
      companyName: schema.companies.name,
    })
    .from(schema.proposals)
    .innerJoin(schema.companies, companyOf(schema.proposals.companyId, orgId))
    .where(and(eq(schema.proposals.orgId, orgId), ilike(schema.proposals.title, pattern)))
    .orderBy(desc(schema.proposals.createdAt), asc(schema.proposals.id))
    .limit(READ)
  return rows.map((r) => ({
    kind: 'proposal' as const,
    id: r.id,
    label: r.title,
    sub: joined(r.status, companyWord(r.domain, r.companyName)),
    href: `/proposals/${r.id}`,
  }))
}

async function searchCampaigns(db: AgencyDb, orgId: string, pattern: string): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      channel: schema.campaigns.channel,
      status: schema.campaigns.status,
    })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, orgId), ilike(schema.campaigns.name, pattern)))
    .orderBy(asc(schema.campaigns.name))
    .limit(READ)
  return rows.map((r) => ({
    kind: 'campaign' as const,
    id: r.id,
    label: r.name,
    sub: joined(r.channel, r.status),
    href: '/campaigns',
  }))
}

/**
 * The page a message is read on. The thread lives on the company page; a
 * message whose company was deleted (the log outlives it) goes to the list
 * it would still appear in.
 */
function touchHref(domain: string | null, direction: string, status: string): string {
  if (domain) return companyHref(domain)
  if (direction === 'in') return '/inbox'
  if (status === 'awaiting_approval') return '/approvals'
  return '/campaigns'
}

async function searchTouches(db: AgencyDb, orgId: string, pattern: string, draftBodies: boolean): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: schema.touches.id,
      channel: schema.touches.channel,
      direction: schema.touches.direction,
      status: schema.touches.status,
      subject: schema.touches.subject,
      domain: schema.companies.domain,
      companyName: schema.companies.name,
    })
    .from(schema.touches)
    .leftJoin(schema.companies, companyOf(schema.touches.companyId, orgId))
    .where(and(
      eq(schema.touches.orgId, orgId),
      or(
        ilike(schema.touches.subject, pattern),
        ilike(schema.touches.recipient, pattern),
        // A reply is the contact's own words, and "who said 'interested'"
        // is what somebody searches for.
        and(eq(schema.touches.direction, 'in'), ilike(schema.touches.body, pattern)),
        // An outbound body only for somebody who may approve one (§2.3).
        draftBodies ? and(eq(schema.touches.direction, 'out'), ilike(schema.touches.body, pattern)) : undefined,
      ),
    ))
    .orderBy(desc(schema.touches.createdAt), asc(schema.touches.id))
    .limit(READ)
  return rows.map((r) => ({
    kind: 'touch' as const,
    id: r.id,
    label: r.subject ?? (r.direction === 'in' ? 'Reply with no subject' : 'Message with no subject'),
    sub: joined(
      `${r.channel} ${r.direction === 'in' ? 'reply' : r.status.replace(/_/g, ' ')}`,
      companyWord(r.domain, r.companyName),
    ),
    href: touchHref(r.domain, r.direction, r.status),
  }))
}
