/**
 * Deals — the one row per company that says where the conversation is.
 *
 * Phase 4 needs exactly one thing from this table: §8.4's "an inbound reply
 * flips the deal to `replied`". Phase 5 builds the pipeline on top (kanban,
 * next actions, proposals), and the stage vocabulary is 0003's:
 *
 *     new → contacted → replied → meeting → proposal → won | lost
 *
 * A deal is created the first time something happens to a company, not when
 * the company is imported. An imported company with no deal is a company
 * nobody has done anything about, which is a true and useful state; a deal in
 * `new` for every imported row would make the pipeline a copy of the CRM.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type DealRow = typeof schema.deals.$inferSelect
export type DealStage = 'new' | 'contacted' | 'replied' | 'meeting' | 'proposal' | 'won' | 'lost'

/** The stages in pipeline order, so "forward" and "back" mean something. */
export const DEAL_STAGES: readonly DealStage[] = [
  'new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost',
]

const RANK: Record<DealStage, number> = {
  new: 0, contacted: 1, replied: 2, meeting: 3, proposal: 4, won: 5, lost: 5,
}

/** The open deal for a company, or null. A won or lost deal is closed. */
export async function openDealFor(
  db: AgencyDb,
  orgId: string,
  companyId: string,
): Promise<DealRow | null> {
  const rows = await db
    .select()
    .from(schema.deals)
    .where(
      and(
        eq(schema.deals.orgId, orgId),
        eq(schema.deals.companyId, companyId),
        sql`${schema.deals.closedAt} IS NULL`,
      ),
    )
    .orderBy(desc(schema.deals.createdAt))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Move a company's deal FORWARD to a stage, creating the deal if there is none.
 *
 * Forward only. A reply arriving after a meeting was booked must not knock the
 * deal back to `replied` — the later stage is the truer one, and the reply is
 * still recorded as a touch. Moving a deal backwards is a person's decision
 * (Phase 5's board), and it goes through `setDealStage` below with a reason.
 *
 * Returns what happened, because the caller usually wants to say it: "moved
 * to replied" and "already at meeting" are different sentences.
 */
export async function advanceDeal(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly to: DealStage
    readonly nextAction?: string | null
  },
): Promise<{ deal: DealRow; outcome: 'created' | 'advanced' | 'unchanged' }> {
  const existing = await openDealFor(db, args.orgId, args.companyId)

  if (!existing) {
    // `deals_one_open_per_company` (0012) arbitrates two callers that both
    // found nothing: one insert wins, the other re-reads the winner's row and
    // proceeds as an advance. Without it a send and a reply landing together
    // left the company with two open deals.
    const rows = await db
      .insert(schema.deals)
      .values({
        orgId: args.orgId,
        companyId: args.companyId,
        stage: args.to,
        nextAction: args.nextAction ?? null,
      })
      .onConflictDoNothing({
        target: [schema.deals.orgId, schema.deals.companyId],
        where: sql`closed_at IS NULL`,
      })
      .returning()
    const deal = rows[0]
    if (deal) return { deal, outcome: 'created' }
    const winner = await openDealFor(db, args.orgId, args.companyId)
    if (!winner) throw new Error('deal insert conflicted but no open deal was found')
    return advanceDeal(db, args)
  }

  if (RANK[args.to] <= RANK[existing.stage as DealStage]) {
    return { deal: existing, outcome: 'unchanged' }
  }

  const rows = await db
    .update(schema.deals)
    .set({
      stage: args.to,
      ...(args.nextAction !== undefined ? { nextAction: args.nextAction } : {}),
    })
    .where(eq(schema.deals.id, existing.id))
    .returning()
  return { deal: rows[0] ?? existing, outcome: 'advanced' }
}

/**
 * Set a deal's stage, in either direction, because a person said so.
 *
 * `won` and `lost` close the deal; `lost` needs a reason, which is the only
 * thing anyone learns from a lost deal.
 */
export async function setDealStage(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly dealId: string
    readonly stage: DealStage
    readonly lostReason?: string | null
    readonly now?: Date
  },
): Promise<DealRow | null> {
  const closes = args.stage === 'won' || args.stage === 'lost'
  if (args.stage === 'lost' && !args.lostReason?.trim()) {
    throw new Error('A lost deal needs a reason — it is the only thing anyone learns from one.')
  }
  const rows = await db
    .update(schema.deals)
    .set({
      stage: args.stage,
      closedAt: closes ? (args.now ?? new Date()) : null,
      lostReason: args.stage === 'lost' ? (args.lostReason ?? null) : null,
    })
    .where(and(eq(schema.deals.orgId, args.orgId), eq(schema.deals.id, args.dealId)))
    .returning()
  return rows[0] ?? null
}

/**
 * Assign a deal to somebody, or clear it.
 *
 * `deals.owner_user_id` has existed since 0003 and nothing wrote it — the
 * column was added and then left, because a two-person agency closes deals
 * by talking to each other. At three or four that stops being true: the
 * board cannot say whose deal is whose, and "I thought you had it" is how a
 * replied lead goes cold.
 *
 * The org check is the part that matters and it lives HERE rather than in
 * the route. `owner_user_id` is a plain FK to `users`, which is global —
 * nothing in the schema says the assignee belongs to the same agency as the
 * deal. So a guessed uuid from another org would be a perfectly valid row,
 * and that row would put a stranger's name on a customer's pipeline. One
 * statement does both: the UPDATE only matches when the deal is this org's,
 * and the owner is resolved against this org's users first.
 */
export async function setDealOwner(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly dealId: string
    /** null unassigns. A deal nobody owns is a real state, not a missing one. */
    readonly ownerUserId: string | null
  },
): Promise<{ ok: true; deal: DealRow } | { ok: false; message: string }> {
  if (args.ownerUserId !== null) {
    const member = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, args.ownerUserId), eq(schema.users.orgId, args.orgId)))
      .limit(1)
    if (member.length === 0) {
      // Answered the same way as a deal that does not exist: the id is the
      // only thing that crossed the boundary, so this is not a way to learn
      // that a user belongs to somebody else.
      return { ok: false, message: 'That person is not on this team.' }
    }
  }

  const rows = await db
    .update(schema.deals)
    .set({ ownerUserId: args.ownerUserId })
    .where(and(eq(schema.deals.orgId, args.orgId), eq(schema.deals.id, args.dealId)))
    .returning()
  const deal = rows[0]
  if (!deal) return { ok: false, message: 'No such deal.' }
  return { ok: true, deal }
}

/** Every open deal in an org, for the board. */
export async function listDeals(db: AgencyDb, orgId: string): Promise<DealRow[]> {
  return db
    .select()
    .from(schema.deals)
    .where(eq(schema.deals.orgId, orgId))
    .orderBy(desc(schema.deals.updatedAt), desc(schema.deals.createdAt))
}

export interface BoardDeal extends DealRow {
  readonly companyDomain: string
  readonly companyName: string | null
  /** Who owns it, resolved for display. Null when nobody has taken it. */
  readonly ownerEmail: string | null
  readonly ownerName: string | null
}

/**
 * Every deal in an org with the company it is about, for the board.
 *
 * Closed deals are included: `won` and `lost` are columns, and a board that
 * hid its outcomes would be a to-do list. The page decides how far back to
 * show them.
 */
export async function listDealsForBoard(db: AgencyDb, orgId: string): Promise<BoardDeal[]> {
  const rows = await db
    .select({
      deal: schema.deals,
      companyDomain: schema.companies.domain,
      companyName: schema.companies.name,
      ownerEmail: schema.users.email,
      ownerName: schema.users.name,
    })
    .from(schema.deals)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.deals.companyId))
    // LEFT, not inner: an unowned deal is the common case on a fresh board
    // and an inner join would hide every one of them.
    .leftJoin(schema.users, eq(schema.users.id, schema.deals.ownerUserId))
    .where(eq(schema.deals.orgId, orgId))
    .orderBy(desc(schema.deals.updatedAt), desc(schema.deals.createdAt))
  return rows.map((r) => ({
    ...r.deal,
    companyDomain: r.companyDomain,
    companyName: r.companyName,
    ownerEmail: r.ownerEmail,
    ownerName: r.ownerName,
  }))
}
