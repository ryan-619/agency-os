/**
 * Today's top actions (2026-10-08): the few things most worth a person's next
 * hour, at the top of the dashboard — each one a link to where it is done.
 *
 * Read from what is already recorded, and nothing guessed:
 *   - a call or visit task that is due — a business that just read the link it
 *     was sent raises one due that minute (`shareLinkCountView`), so the
 *     freshest comes first, while they are still reading;
 *   - replies nobody has handled, and drafts waiting for a person;
 *   - a quote whose validity ends within two days, and one sent three days
 *     ago or more that nobody has answered;
 *   - any other task that is due.
 * Ordered by that list, and cut at `TODAY_ACTIONS_MAX`. Tasks shown are the
 * person's own and nobody's — a teammate's call is theirs to make.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { formatMoney, quoteDayIn } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export const TODAY_ACTIONS_MAX = 8
/** A sent quote nobody has answered this long is worth a nudge. */
export const QUOTE_FOLLOW_UP_DAYS = 3
/** A sent quote this close to its last valid day is worth a word before it lapses. */
export const QUOTE_LAPSING_DAYS = 2
/** A task due within this much of now counts as today's. */
const DUE_SOON_MS = 12 * 3_600_000

export type TodayActionKind = 'call' | 'replies' | 'quote_lapsing' | 'quote_follow_up' | 'drafts' | 'visit' | 'task'

export interface TodayAction {
  readonly id: string
  readonly kind: TodayActionKind
  readonly title: string
  readonly detail: string | null
  readonly href: string
  /** When it fell due, arrived or was sent; null for a count. */
  readonly at: Date | null
}

const RANK: Readonly<Record<TodayActionKind, number>> = {
  call: 0, replies: 1, quote_lapsing: 2, quote_follow_up: 3, drafts: 4, visit: 5, task: 6,
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

export async function todayActions(
  db: AgencyDb,
  args: { readonly orgId: string; readonly userId: string; readonly now: Date },
): Promise<TodayAction[]> {
  const { orgId, userId, now } = args
  const today = quoteDayIn(now)
  const lapsingBy = new Date(`${today}T00:00:00Z`)
  lapsingBy.setUTCDate(lapsingBy.getUTCDate() + QUOTE_LAPSING_DAYS)
  const lapsingByDay = lapsingBy.toISOString().slice(0, 10)

  const [tasks, replies, drafts, quotes] = await Promise.all([
    db
      .select({
        id: schema.tasks.id, kind: schema.tasks.kind, title: schema.tasks.title, detail: schema.tasks.detail,
        dueAt: schema.tasks.dueAt, domain: schema.companies.domain,
      })
      .from(schema.tasks)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.tasks.companyId))
      .where(and(
        eq(schema.tasks.orgId, orgId),
        isNull(schema.tasks.doneAt),
        inArray(schema.tasks.kind, ['call', 'visit', 'todo']),
        or(eq(schema.tasks.assigneeUserId, userId), isNull(schema.tasks.assigneeUserId)),
        isNotNull(schema.tasks.dueAt),
        lte(schema.tasks.dueAt, new Date(now.getTime() + DUE_SOON_MS)),
      ))
      // Calls first, the freshest first: the one raised a minute ago by a business reading its link beats last week's.
      .orderBy(sql`(${schema.tasks.kind} = 'call') DESC`, desc(schema.tasks.dueAt))
      .limit(TODAY_ACTIONS_MAX),
    db
      .select({ n: sql<number>`count(*)::int`, newest: sql<Date | null>`max(${schema.touches.createdAt})` })
      .from(schema.touches)
      .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.direction, 'in'), isNull(schema.touches.handledAt))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.touches)
      .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.direction, 'out'), eq(schema.touches.status, 'awaiting_approval'))),
    db
      .select({
        id: schema.quotes.id, number: schema.quotes.number, total: schema.quotes.total, currency: schema.quotes.currency,
        validUntil: schema.quotes.validUntil, sentAt: schema.quotes.sentAt, name: schema.companies.name, domain: schema.companies.domain,
      })
      .from(schema.quotes)
      .innerJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
      .where(and(eq(schema.quotes.orgId, orgId), eq(schema.quotes.status, 'sent'), gte(schema.quotes.validUntil, today)))
      .orderBy(asc(schema.quotes.validUntil), asc(schema.quotes.sentAt))
      .limit(TODAY_ACTIONS_MAX),
  ])

  const out: TodayAction[] = []
  for (const t of tasks) {
    const kind: TodayActionKind = t.kind === 'call' ? 'call' : t.kind === 'visit' ? 'visit' : 'task'
    out.push({
      id: `task:${t.id}`,
      kind,
      title: t.title,
      detail: t.detail ? t.detail.slice(0, 200) : null,
      href: '/tasks',
      at: t.dueAt,
    })
  }
  const r = replies[0]
  if (r && r.n > 0) {
    out.push({
      id: 'replies',
      kind: 'replies',
      title: r.n === 1 ? 'Answer the reply waiting in the inbox' : `Answer the ${r.n} replies waiting in the inbox`,
      detail: 'Somebody wrote back; until a person handles it, the reply waits.',
      href: '/inbox',
      at: r.newest ? new Date(r.newest) : null,
    })
  }
  for (const q of quotes) {
    const name = q.name || q.domain
    const left = daysBetween(today, q.validUntil)
    if (q.validUntil <= lapsingByDay) {
      out.push({
        id: `quote:${q.id}`,
        kind: 'quote_lapsing',
        title: `${q.number} for ${name} lapses ${left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`}`,
        detail: `${formatMoney(q.total, q.currency)}, valid until ${q.validUntil}. A word now, or extend it on the quote’s page.`,
        href: `/quotes/${q.id}`,
        at: q.sentAt,
      })
      continue
    }
    if (q.sentAt && now.getTime() - q.sentAt.getTime() >= QUOTE_FOLLOW_UP_DAYS * 86_400_000) {
      const days = Math.floor((now.getTime() - q.sentAt.getTime()) / 86_400_000)
      out.push({
        id: `quote:${q.id}`,
        kind: 'quote_follow_up',
        title: `Follow up on ${q.number} for ${name} — sent ${days} days ago, no answer yet`,
        detail: `${formatMoney(q.total, q.currency)}, valid until ${q.validUntil}.`,
        href: `/quotes/${q.id}`,
        at: q.sentAt,
      })
    }
  }
  const d = drafts[0]
  if (d && d.n > 0) {
    out.push({
      id: 'drafts',
      kind: 'drafts',
      title: d.n === 1 ? 'Approve or deny the draft waiting' : `Approve or deny the ${d.n} drafts waiting`,
      detail: 'Nothing goes out until a person approves it.',
      href: '/approvals',
      at: null,
    })
  }
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => RANK[x.a.kind] - RANK[y.a.kind] || x.i - y.i)
    .slice(0, TODAY_ACTIONS_MAX)
    .map(({ a }) => a)
}
