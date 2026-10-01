/**
 * Reading ICP profiles for /settings/icp (§2.2). READ ONLY, on purpose.
 *
 * There is no update here and there is not going to be one in this shape.
 * Every stored score names the profile it was computed from
 * (`scores.icp_profile_id`, RESTRICT) and every finding carries the weight
 * that profile gave it (`recordScan` copies it from the definition). Editing
 * a definition IN PLACE changes what every one of those numbers means without
 * changing a single number: a stored 62 that qualified at 45 is silently a
 * different claim once `qualify_at` is 65. If editing is ever built it is a
 * NEW row — a new id, the old one kept for the scores that name it — and a
 * re-scan, never an UPDATE of `definition`.
 *
 * All rows are returned, not just the active one. `active` has no
 * partial-unique index (0002 has only `(org_id, name)`), and
 * `activeIcpProfile` takes `.limit(1)` with no ORDER BY — so two active rows
 * mean the scanner scores against whichever one Postgres happens to return
 * first. Hiding the second row would hide that ambiguity; the page renders
 * every row and says so when more than one is active.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export interface IcpProfileRow {
  readonly id: string
  readonly name: string
  /** The raw jsonb. Parse it with `parseIcpDefinition` — it is data a person could have written. */
  readonly definition: unknown
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date | null
  /**
   * How many stored scores name this profile. Each is a number computed
   * against THIS definition, which is the reason there is no edit control.
   */
  readonly scores: number
}

/** Every profile this org has, active first, then by name. */
export async function icpProfilesList(db: AgencyDb, orgId: string): Promise<IcpProfileRow[]> {
  const rows = await db
    .select({
      id: schema.icpProfiles.id,
      name: schema.icpProfiles.name,
      definition: schema.icpProfiles.definition,
      active: schema.icpProfiles.active,
      createdAt: schema.icpProfiles.createdAt,
      updatedAt: schema.icpProfiles.updatedAt,
      scores: sql<string>`count(${schema.scores.id})::text`,
    })
    .from(schema.icpProfiles)
    // A LEFT JOIN rather than a correlated subquery: in a single-table select
    // drizzle renders a column unqualified, and `id` inside a subquery on
    // `scores` binds to scores.id. Org-scoped on both sides — a score row
    // carries its own org_id, and a count that could include another org's
    // rows is not this org's fact.
    .leftJoin(
      schema.scores,
      and(eq(schema.scores.icpProfileId, schema.icpProfiles.id), eq(schema.scores.orgId, orgId)),
    )
    .where(eq(schema.icpProfiles.orgId, orgId))
    // Grouping by the primary key lets Postgres select the row's other columns.
    .groupBy(schema.icpProfiles.id)
    .orderBy(desc(schema.icpProfiles.active), asc(schema.icpProfiles.name))
  return rows.map((r) => ({ ...r, scores: Number(r.scores) }))
}
