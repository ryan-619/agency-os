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
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import * as schema from './schema.js'
import { appendAudit } from './approvals.js'
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
 *
 * Every creation and every advance writes its OWN audit row — `deal.created`
 * or `deal.advanced`, `{ companyId, from, to }` — because the pipeline's
 * history is the audit log and this is the function that moves deals on its
 * own. Before it did, an automatic move was recorded only inside whatever
 * caused it (`send.sent`, `contact.replied`, `meeting.booked`,
 * `proposal.generated`), none of which says the stage the deal LEFT, so
 * /pipeline/analytics could not count a conversion it did not see. The row
 * is written with the caller's `db`, so inside a caller's transaction it
 * commits or rolls back with the move. `actor` defaults to `'system'`: the
 * caller that knows the person writes its own row beside this one.
 */
export async function advanceDeal(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly to: DealStage
    readonly nextAction?: string | null
    /** Who the audit row names. A users.id, 'agent', or 'system' (the default). */
    readonly actor?: string
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
    if (deal) {
      await recordMove(db, args.actor, 'deal.created', deal, null)
      return { deal, outcome: 'created' }
    }
    const winner = await openDealFor(db, args.orgId, args.companyId)
    if (!winner) throw new Error('deal insert conflicted but no open deal was found')
    return advanceDeal(db, args)
  }

  if (RANK[args.to] <= RANK[existing.stage as DealStage]) {
    return { deal: existing, outcome: 'unchanged' }
  }

  // The read above decided only that a move is worth trying. Under READ
  // COMMITTED another session can commit between it and this write — a
  // booking taking the deal to meeting, a person closing it lost — so both
  // rules are in the statement itself: the row is locked only while it is
  // still open and still behind `to`, and `before_stage` is the stage the
  // UPDATE actually replaced, read under that lock rather than remembered
  // from the read. Review round 3, finding [11].
  const behind = DEAL_STAGES.filter((s) => RANK[s] < RANK[args.to])
  const stillBehind = and(
    eq(schema.deals.orgId, args.orgId),
    isNull(schema.deals.closedAt),
    inArray(schema.deals.stage, behind),
  )
  const prior = db.$with('prior').as(
    db
      .select({ id: schema.deals.id, beforeStage: sql<string>`${schema.deals.stage}`.as('before_stage') })
      .from(schema.deals)
      .where(and(eq(schema.deals.id, existing.id), stillBehind))
      .for('update'),
  )
  const rows = await db
    .with(prior)
    .update(schema.deals)
    .set({
      stage: args.to,
      ...(args.nextAction !== undefined ? { nextAction: args.nextAction } : {}),
    })
    .from(prior)
    .where(and(eq(schema.deals.id, prior.id), stillBehind))
    .returning({ ...getTableColumns(schema.deals), beforeStage: prior.beforeStage })
  const moved = rows[0]
  if (!moved) {
    // Somebody else moved it first. Ask again from the top: a deal now at or
    // past `to` is `unchanged`, and one closed meanwhile is no longer this
    // company's open deal — the event opens a new one, exactly what the two
    // would have done one after the other. Nothing is audited for a move
    // that did not happen.
    return advanceDeal(db, args)
  }
  const { beforeStage, ...deal } = moved
  await recordMove(db, args.actor, 'deal.advanced', deal, beforeStage)
  return { deal, outcome: 'advanced' }
}

/**
 * The audit row for an automatic move. Swallowed on failure like every other
 * audit write on the send path: the move is the fact, and a deal that moved
 * must not be reported as not having moved because its log line failed.
 */
async function recordMove(
  db: AgencyDb,
  actor: string | undefined,
  action: 'deal.created' | 'deal.advanced',
  deal: DealRow,
  from: string | null,
): Promise<void> {
  await appendAudit(db, {
    orgId: deal.orgId,
    actor: actor ?? 'system',
    action,
    subjectType: 'deal',
    subjectId: deal.id,
    detail: { companyId: deal.companyId, from, to: deal.stage },
  }).catch(() => {})
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
  return boardRows(db, eq(schema.deals.orgId, orgId), [
    desc(schema.deals.updatedAt),
    desc(schema.deals.createdAt),
  ])
}

/**
 * The open deals that are due by `before`, soonest (most overdue) first.
 *
 * A closed deal is never due — an outcome has no next step — and a deal with
 * no `next_action_at` is not due either: "nobody set a date" is a different
 * fact from "the date has come", and the board shows the first as its own
 * thing. The caller picks `before`; the pipeline page passes now + 24 hours,
 * which is the end of today in every zone for a date set from the board.
 */
export async function dealsDue(db: AgencyDb, orgId: string, before: Date): Promise<BoardDeal[]> {
  return boardRows(
    db,
    and(
      eq(schema.deals.orgId, orgId),
      isNull(schema.deals.closedAt),
      isNotNull(schema.deals.nextActionAt),
      lte(schema.deals.nextActionAt, before),
    ),
    [asc(schema.deals.nextActionAt), asc(schema.deals.createdAt)],
  )
}

async function boardRows(
  db: AgencyDb,
  where: ReturnType<typeof and>,
  order: ReturnType<typeof asc>[],
): Promise<BoardDeal[]> {
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
    .where(where)
    .orderBy(...order)
  return rows.map((r) => ({
    ...r.deal,
    companyDomain: r.companyDomain,
    companyName: r.companyName,
    ownerEmail: r.ownerEmail,
    ownerName: r.ownerName,
  }))
}

export type DealsSetNextActionAtResult =
  | { readonly ok: true; readonly deal: DealRow; readonly from: Date | null }
  | { readonly ok: false; readonly reason: 'not_found' | 'closed' | 'invalid_date'; readonly message: string }

/**
 * Set or clear the date a deal's next action is due.
 *
 * `deals.next_action_at` has existed since 0003 and nothing wrote it —
 * `update_deal` writes the `next_action` TEXT only — so a column nobody
 * could set sat on every row, teaching whoever read the schema a shape the
 * product did not have. This is its writer, and the only one.
 *
 * One UPDATE, which also reads the value it replaced (a self-join sees the
 * row as it was before the statement), and one audit row naming both —
 * `deal.next_action_set { companyId, from, to }` — in one transaction, so a
 * due date never changes without its record. Clearing (`null`) is always
 * allowed; setting a date on a closed deal is refused, because an outcome
 * has no next step and `dealsDue` would never show it. Note what it touches:
 * `deals_set_updated_at` fires on this UPDATE too, so setting a date counts
 * as touching the deal — which is what "untouched for N days" means.
 */
export async function dealsSetNextActionAt(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly dealId: string
    readonly at: Date | null
    /** A users.id, or 'agent'. */
    readonly actor: string
  },
): Promise<DealsSetNextActionAtResult> {
  if (args.at !== null && !Number.isFinite(args.at.getTime())) {
    return { ok: false, reason: 'invalid_date', message: 'That is not a date.' }
  }
  const before = alias(schema.deals, 'before')
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.deals)
      .set({ nextActionAt: args.at })
      .from(before)
      .where(
        and(
          eq(before.id, schema.deals.id),
          eq(schema.deals.orgId, args.orgId),
          eq(schema.deals.id, args.dealId),
          ...(args.at !== null ? [isNull(schema.deals.closedAt)] : []),
        ),
      )
      .returning({ id: schema.deals.id, from: before.nextActionAt })
    const updated = rows[0]
    if (!updated) {
      const [exists] = await tx
        .select({ closedAt: schema.deals.closedAt })
        .from(schema.deals)
        .where(and(eq(schema.deals.orgId, args.orgId), eq(schema.deals.id, args.dealId)))
        .limit(1)
      // Another org's deal is answered exactly like a deal that does not
      // exist: the id is the only thing that crossed the boundary.
      if (!exists) return { ok: false, reason: 'not_found', message: 'No such deal.' } as const
      return {
        ok: false,
        reason: 'closed',
        message: 'This deal is closed. An outcome has no next step, so it cannot be due.',
      } as const
    }
    const [deal] = await tx.select().from(schema.deals).where(eq(schema.deals.id, updated.id)).limit(1)
    if (!deal) throw new Error('an updated deal could not be read back')
    await appendAudit(tx as unknown as AgencyDb, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'deal.next_action_set',
      subjectType: 'deal',
      subjectId: deal.id,
      detail: {
        companyId: deal.companyId,
        from: updated.from ? updated.from.toISOString() : null,
        to: args.at ? args.at.toISOString() : null,
      },
    })
    return { ok: true, deal, from: updated.from } as const
  })
}
