/**
 * Model spend for /settings/spend, summed in SQL from `chat_messages.cost_usd`
 * — per day, per person, and a run rate. The same numbers tools/spend.sh
 * prints, scoped to one org.
 *
 * `cost_usd` is drizzle `numeric` with no mode, so it arrives in JavaScript as
 * a STRING and "0.01" + "0.02" is "0.010.02" — which stores fine and reads as
 * a number to nobody. So no total is ever formed here: every sum, every
 * division and every projection is Postgres arithmetic on `numeric`, and each
 * comes back as the database's own text. The page formats it; nothing adds it.
 *
 * The figure is the SDK's own (`result.total_cost_usd`, converted to a
 * per-turn delta by the worker), not an estimate. A "turn" here is what
 * tools/spend.sh counts: a message row carrying a positive cost, which the
 * worker writes once per turn on the turn's final result.
 *
 * Days are UTC calendar days. The org is checked on every table a query
 * touches — `chat_messages.org_id`, and on the person query
 * `chat_sessions.org_id` and `users.org_id` as well.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

/** The default window for the per-day and per-person tables. */
export const SPEND_WINDOW_DAYS = 30

/**
 * Weeks in an average month, as tools/spend.sh has it (30.45 days), so the
 * page and the script project the same month from the same week.
 */
export const SPEND_WEEKS_PER_MONTH = '4.35'

export interface SpendDay {
  /** `YYYY-MM-DD`, a UTC calendar day. */
  readonly day: string
  /** Postgres `numeric` as text, six decimal places. */
  readonly usd: string
  readonly turns: number
}

export interface SpendPerson {
  readonly userId: string
  readonly email: string
  readonly name: string | null
  /** The person's access was revoked; their costs are theirs all the same. */
  readonly revoked: boolean
  readonly usd: string
  readonly turns: number
}

export interface SpendRunRate {
  /** Summed over the last seven days, rolling — not calendar days. */
  readonly last7Usd: string
  readonly perDayUsd: string
  /** `last7Usd × 4.35`, the month tools/spend.sh projects. */
  readonly projectedMonthUsd: string
}

export interface SpendTotal {
  readonly usd: string
  readonly turns: number
}

/**
 * A whole number of days between 1 and 366. The value is interpolated into
 * `make_interval` as a bound parameter either way; this keeps "-5" or NaN
 * from producing a window that quietly means something else.
 */
function windowDays(days: number): number {
  if (!Number.isFinite(days)) return SPEND_WINDOW_DAYS
  return Math.min(366, Math.max(1, Math.floor(days)))
}

/**
 * The start of the window: midnight UTC `days - 1` days ago, so the window
 * is exactly `days` whole calendar days ending today and a per-day table has
 * at most that many rows.
 */
function windowStart(days: number): SQL {
  return sql`((date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${windowDays(days) - 1}::int)) AT TIME ZONE 'UTC')`
}

/** The sum, as the database's text, zero when nothing matched. */
const SUM = sql<string>`coalesce(sum(${schema.chatMessages.costUsd}), 0)::numeric(14, 6)::text`
/** Turns, as tools/spend.sh counts them. */
const TURNS = sql<string>`count(*) FILTER (WHERE ${schema.chatMessages.costUsd} > 0)::text`

/**
 * Spend per UTC day over the last `days` days, newest first. A day with no
 * priced message has no row — the page says so rather than listing zeros.
 */
export async function spendByDay(db: AgencyDb, orgId: string, days: number = SPEND_WINDOW_DAYS): Promise<SpendDay[]> {
  const bucket = sql<string>`to_char(${schema.chatMessages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
  const rows = await db
    .select({ day: bucket, usd: SUM, turns: TURNS })
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.orgId, orgId),
        sql`${schema.chatMessages.costUsd} IS NOT NULL`,
        sql`${schema.chatMessages.createdAt} >= ${windowStart(days)}`,
      ),
    )
    .groupBy(bucket)
    .orderBy(desc(bucket))
  return rows.map((r) => ({ day: r.day, usd: r.usd, turns: Number(r.turns) }))
}

/**
 * Spend per person over the last `days` days, highest first. `chat_messages`
 * carries no user id, so the person comes through the thread; the org is
 * checked on all three tables.
 *
 * On a shared prepaid balance "who is spending it" is the question the
 * account actually raises, which is why tools/spend.sh has this table too.
 */
export async function spendByPerson(
  db: AgencyDb,
  orgId: string,
  days: number = SPEND_WINDOW_DAYS,
): Promise<SpendPerson[]> {
  const rows = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      revokedAt: schema.users.revokedAt,
      usd: SUM,
      turns: TURNS,
    })
    .from(schema.chatMessages)
    .innerJoin(schema.chatSessions, eq(schema.chatSessions.id, schema.chatMessages.sessionId))
    .innerJoin(schema.users, eq(schema.users.id, schema.chatSessions.userId))
    .where(
      and(
        eq(schema.chatMessages.orgId, orgId),
        eq(schema.chatSessions.orgId, orgId),
        eq(schema.users.orgId, orgId),
        sql`${schema.chatMessages.costUsd} IS NOT NULL`,
        sql`${schema.chatMessages.createdAt} >= ${windowStart(days)}`,
      ),
    )
    .groupBy(schema.users.id, schema.users.email, schema.users.name, schema.users.revokedAt)
    // Ordered by the numeric sum, never its text: as text '9.5' sorts above '10.0'.
    .orderBy(sql`coalesce(sum(${schema.chatMessages.costUsd}), 0) DESC`, schema.users.email)
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    revoked: r.revokedAt !== null,
    usd: r.usd,
    turns: Number(r.turns),
  }))
}

/**
 * The last seven days, rolling, and what they project to: per day and per
 * month (× 4.35 weeks, as tools/spend.sh). All three are formed in one
 * statement, so the per-day and monthly figures are exactly the week's
 * arithmetic and never a rounding of a rounding. Zeros, not nulls, when
 * nothing was spent.
 */
export async function spendRunRate(db: AgencyDb, orgId: string): Promise<SpendRunRate> {
  const week = sql`coalesce(sum(${schema.chatMessages.costUsd}), 0)`
  const rows = await db
    .select({
      last7Usd: sql<string>`${week}::numeric(14, 6)::text`,
      perDayUsd: sql<string>`round(${week} / 7, 6)::text`,
      projectedMonthUsd: sql<string>`round(${week} * ${SPEND_WEEKS_PER_MONTH}::numeric, 6)::text`,
    })
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.orgId, orgId),
        sql`${schema.chatMessages.createdAt} > now() - interval '7 days'`,
      ),
    )
  const r = rows[0]
  return {
    last7Usd: r?.last7Usd ?? '0.000000',
    perDayUsd: r?.perDayUsd ?? '0.000000',
    projectedMonthUsd: r?.projectedMonthUsd ?? '0.000000',
  }
}

/** Everything this org has ever spent, and over how many turns. */
export async function spendTotal(db: AgencyDb, orgId: string): Promise<SpendTotal> {
  const rows = await db
    .select({ usd: SUM, turns: TURNS })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.orgId, orgId))
  const r = rows[0]
  return { usd: r?.usd ?? '0.000000', turns: Number(r?.turns ?? 0) }
}
