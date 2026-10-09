/**
 * The facts `dealHealth` (core) reads, gathered for a whole board in four
 * queries (2026-10-09): unhandled replies and awaiting drafts per company,
 * the last message sent, the newest sent quote, and the next meeting. Keyed
 * by company, because every one of them is about the company the deal is
 * with; the deal's own columns come from the board row.
 */
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export interface CompanyHealthFacts {
  readonly unhandledReplies: number
  readonly awaitingDrafts: number
  readonly lastSentAt: Date | null
  readonly sentQuote: { readonly sentAt: Date | null; readonly validUntil: string } | null
  readonly nextMeetingAt: Date | null
}

const NONE: CompanyHealthFacts = { unhandledReplies: 0, awaitingDrafts: 0, lastSentAt: null, sentQuote: null, nextMeetingAt: null }

export async function dealHealthFacts(
  db: AgencyDb,
  args: { readonly orgId: string; readonly companyIds: readonly string[]; readonly now: Date },
): Promise<Map<string, CompanyHealthFacts>> {
  const out = new Map<string, CompanyHealthFacts>()
  const ids = [...new Set(args.companyIds)]
  if (ids.length === 0) return out
  const [touches, quotes, meetings] = await Promise.all([
    db
      .select({
        companyId: schema.touches.companyId,
        unhandled: sql<number>`count(*) filter (where ${schema.touches.direction} = 'in' and ${schema.touches.handledAt} is null)::int`,
        awaiting: sql<number>`count(*) filter (where ${schema.touches.direction} = 'out' and ${schema.touches.status} = 'awaiting_approval')::int`,
        lastSentAt: sql<Date | null>`max(${schema.touches.sentAt}) filter (where ${schema.touches.direction} = 'out' and ${schema.touches.status} = 'sent')`,
      })
      .from(schema.touches)
      .where(and(eq(schema.touches.orgId, args.orgId), inArray(schema.touches.companyId, ids)))
      .groupBy(schema.touches.companyId),
    db
      .select({ companyId: schema.quotes.companyId, sentAt: schema.quotes.sentAt, validUntil: schema.quotes.validUntil })
      .from(schema.quotes)
      .where(and(eq(schema.quotes.orgId, args.orgId), inArray(schema.quotes.companyId, ids), eq(schema.quotes.status, 'sent')))
      .orderBy(sql`${schema.quotes.sentAt} desc nulls last`),
    db
      .select({ companyId: schema.meetings.companyId, startsAt: schema.meetings.startsAt })
      .from(schema.meetings)
      .where(and(
        eq(schema.meetings.orgId, args.orgId), inArray(schema.meetings.companyId, ids), isNull(schema.meetings.cancelledAt),
        gt(schema.meetings.startsAt, args.now),
      ))
      .orderBy(schema.meetings.startsAt),
  ])
  for (const id of ids) out.set(id, NONE)
  for (const t of touches) {
    if (!t.companyId) continue
    const lastSentAt = t.lastSentAt instanceof Date ? t.lastSentAt : t.lastSentAt ? new Date(String(t.lastSentAt)) : null
    out.set(t.companyId, { ...out.get(t.companyId)!, unhandledReplies: t.unhandled, awaitingDrafts: t.awaiting, lastSentAt })
  }
  for (const q of quotes) {
    const cur = out.get(q.companyId)!
    if (cur.sentQuote) continue
    out.set(q.companyId, { ...cur, sentQuote: { sentAt: q.sentAt, validUntil: String(q.validUntil) } })
  }
  for (const m of meetings) {
    const cur = out.get(m.companyId)!
    if (cur.nextMeetingAt) continue
    out.set(m.companyId, { ...cur, nextMeetingAt: m.startsAt })
  }
  return out
}
