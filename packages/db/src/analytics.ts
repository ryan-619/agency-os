/**
 * The recorded moves behind /pipeline/analytics.
 *
 * There is no stage-history table: the pipeline's history is the audit log
 * (CLAUDE.md §2, "The pipeline"), so this reads it. Three actions carry a
 * move, and they are the three that are actually written:
 *
 *   - `deal.moved` — `PATCH /api/deals/[id]`, a person on the board, with
 *     `{ companyId, from, to }`;
 *   - `deal.created` and `deal.advanced` — `advanceDeal` itself, for every
 *     automatic move (a send, a reply, a booking, a proposal generated),
 *     with `{ companyId, from, to }`.
 *
 * `POST /api/deals` ALSO writes `deal.created` / `deal.advanced`, beside the
 * row `advanceDeal` wrote for the same move, shaped `{ companyId, stage }`.
 * Those are the same move said twice, so they are excluded in the query by
 * the missing `to` rather than read and counted as unreadable — an
 * "unreadable" figure inflated by a known duplicate would send somebody
 * looking for corruption that is not there.
 *
 * Moves that are STILL not recorded as a deal row, and that the page's note
 * names: a stage set by the agent's `update_deal` (it writes
 * `agent.update_deal`, which does not say the stage it left), a proposal
 * accepted as won (`proposal.accepted`), and every automatic move made
 * before `advanceDeal` wrote its own rows. So every count built from this is
 * a lower bound, and `pipelineMetrics` says so.
 *
 * `detail` is jsonb that nothing validates on the way in, so it is parsed
 * defensively: a row whose shape is not a move is skipped and COUNTED, and
 * the count travels with the moves so a page can say how many it could not
 * read rather than quietly computing from fewer.
 */
import { and, asc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import type { Transition } from '@agency/core'
import * as schema from './schema.js'
import { DEAL_STAGES } from './deals.js'
import type { AgencyDb } from './repository.js'

/** The audit actions that carry a deal's move. */
export const ANALYTICS_MOVE_ACTIONS = ['deal.moved', 'deal.created', 'deal.advanced'] as const

/**
 * The moves, with how many rows were read and could not be understood.
 *
 * An array, so a caller that only wants the moves passes it straight to
 * `pipelineMetrics`; with the count ON it, so the count cannot be dropped on
 * the way.
 */
export type AnalyticsTransitions = Transition[] & { readonly skipped: number }

const MAX_SINCE_DAYS = 3650

/**
 * Every recorded move of this org's deals, oldest first.
 *
 * `sinceDays` bounds the window by when the move was recorded; omitted, it
 * is all of it. Only this org's rows are read — `audit_log.org_id` is the
 * boundary, and it is in the WHERE, not trusted to the deal ids.
 */
export async function analyticsTransitions(
  db: AgencyDb,
  orgId: string,
  opts: { readonly sinceDays?: number; readonly now?: Date } = {},
): Promise<AnalyticsTransitions> {
  let since: Date | null = null
  if (opts.sinceDays !== undefined) {
    if (!Number.isInteger(opts.sinceDays) || opts.sinceDays < 1 || opts.sinceDays > MAX_SINCE_DAYS) {
      throw new RangeError(`sinceDays must be a whole number of days from 1 to ${MAX_SINCE_DAYS}.`)
    }
    since = new Date((opts.now ?? new Date()).getTime() - opts.sinceDays * 86_400_000)
  }

  const rows = await db
    .select({
      action: schema.auditLog.action,
      subjectId: schema.auditLog.subjectId,
      detail: schema.auditLog.detail,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        inArray(schema.auditLog.action, [...ANALYTICS_MOVE_ACTIONS]),
        // The route's companion rows (`{ companyId, stage }`) repeat a move
        // `advanceDeal` already recorded; see the header.
        or(
          eq(schema.auditLog.action, 'deal.moved'),
          sql`(${schema.auditLog.detail} -> 'to') IS NOT NULL`,
        ),
        ...(since ? [gte(schema.auditLog.createdAt, since)] : []),
      ),
    )
    .orderBy(asc(schema.auditLog.createdAt), asc(schema.auditLog.id))

  const transitions: Transition[] = []
  let skipped = 0
  for (const row of rows) {
    const move = readMove(row)
    if (move) transitions.push(move)
    else skipped++
  }
  return Object.assign(transitions, { skipped })
}

function readMove(row: {
  readonly action: string
  readonly subjectId: string | null
  readonly detail: unknown
  readonly createdAt: Date
}): Transition | null {
  if (!row.subjectId || !Number.isFinite(row.createdAt.getTime())) return null
  const detail = row.detail
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null
  const { from, to } = detail as { from?: unknown; to?: unknown }
  if (!isStage(to)) return null
  // A creation came from nothing. Anything else must name a stage it left,
  // and the board's route always does; `null` there is not a stage.
  let left: string | null
  if (from === undefined || from === null) {
    if (row.action === 'deal.moved') return null
    left = null
  } else if (isStage(from)) {
    left = from
  } else {
    return null
  }
  return { dealId: row.subjectId, from: left, to, at: row.createdAt }
}

function isStage(value: unknown): value is string {
  return typeof value === 'string' && (DEAL_STAGES as readonly string[]).includes(value)
}
