/**
 * The org's ICP profiles (§2.2): read for /settings/icp and the agent's
 * `list_icps`, derived into new rows by `create_icp`, and activated (0021).
 *
 * There is no update of a DEFINITION here and there is not going to be one.
 * Every stored score names the profile it was computed from
 * (`scores.icp_profile_id`, RESTRICT) and every finding carries the weight
 * that profile gave it (`recordScan` copies it from the definition). Editing
 * a definition IN PLACE changes what every one of those numbers means without
 * changing a single number: a stored 62 that qualified at 45 is silently a
 * different claim once `qualify_at` is 65. If editing is ever built it is a
 * NEW row — a new id, the old one kept for the scores that name it — and a
 * re-scan, never an UPDATE of `definition`.
 *
 * So a new market or size band is exactly that NEW row: `createIcpProfile`
 * derives one from an existing profile through core's `deriveIcp` and stores
 * it INACTIVE. The one UPDATE this file makes is of `active`, never of
 * `definition`: `activateIcpProfile` swaps the active profile in one
 * transaction. That changes how every LATER scan is judged, and a proposal
 * refuses a scan scored under another profile (`rescore`), so each company is
 * re-scanned before its next proposal — which is why the agent's
 * `activate_icp` raises a card.
 *
 * All rows are returned, not just the active one. Until 0021 `active` had no
 * partial-unique index, and `activeIcpProfile` takes `.limit(1)` with no
 * ORDER BY — so two active rows meant the scanner scored against whichever one
 * Postgres returned first. 0021 adds `icp_profiles_one_active_per_org`; the
 * page still renders every row, and still says so if more than one is active.
 */
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { deriveIcp, icpTargeting, parseIcpDefinition, type IcpChanges, type IcpDefinition } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { isUniqueViolation } from './pg-errors.js'

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

export type CreateIcpResult =
  | { readonly ok: true; readonly id: string; readonly name: string; readonly basedOn: string; readonly definition: IcpDefinition }
  | { readonly ok: false; readonly reason: 'no_base' | 'invalid' | 'name_taken'; readonly message: string }

/**
 * Derive a new profile from `basedOn` (a profile's name; the active one when
 * absent) and store it INACTIVE, with an `icp.created` audit row in the same
 * transaction. Its name is its label.
 */
export async function createIcpProfile(
  db: AgencyDb,
  args: { readonly orgId: string; readonly actor: string; readonly basedOn?: string; readonly changes: IcpChanges },
): Promise<CreateIcpResult> {
  const profiles = await icpProfilesList(db, args.orgId)
  const wanted = args.basedOn?.trim().toLowerCase()
  const base = wanted ? profiles.find((p) => p.name.toLowerCase() === wanted) : profiles.find((p) => p.active)
  if (!base) {
    return {
      ok: false,
      reason: 'no_base',
      message: args.basedOn
        ? `There is no profile named "${args.basedOn.slice(0, 80)}" to start from.`
        : 'There is no active profile to start from.',
    }
  }
  let baseDefinition: IcpDefinition
  try {
    baseDefinition = parseIcpDefinition(base.definition)
  } catch {
    return { ok: false, reason: 'no_base', message: `The profile "${base.name}" does not parse, so nothing can be derived from it.` }
  }
  const derived = deriveIcp(baseDefinition, args.changes)
  if (!derived.ok) return { ok: false, reason: 'invalid', message: derived.message }
  const name = derived.definition.label

  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.icpProfiles)
        .values({ orgId: args.orgId, name, definition: derived.definition, active: false })
        .returning({ id: schema.icpProfiles.id })
      if (!row) throw new Error('icp profile insert returned no row')
      const t = icpTargeting(derived.definition)
      await appendAudit(tx as unknown as AgencyDb, {
        orgId: args.orgId,
        actor: args.actor,
        action: 'icp.created',
        subjectType: 'icp_profile',
        subjectId: row.id,
        detail: { name, basedOn: base.name, geos: t.geos, headcountMin: t.headcountMin, headcountMax: t.headcountMax },
      })
      return row.id
    })
    return { ok: true, id, name, basedOn: base.name, definition: derived.definition }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: 'name_taken', message: `A profile named "${name}" already exists. Give the new one another label.` }
    }
    throw err
  }
}

export type ActivateIcpResult =
  | { readonly ok: true; readonly changed: boolean; readonly name: string; readonly previous: string | null }
  | { readonly ok: false; readonly reason: 'not_found' | 'invalid'; readonly message: string }

/**
 * Make one profile the active one, and every other inactive, in one
 * transaction with its `icp.activated` audit row. The others are switched off
 * FIRST: 0021's index allows one active row per org at every moment.
 */
export async function activateIcpProfile(
  db: AgencyDb,
  args: { readonly orgId: string; readonly actor: string; readonly name: string },
): Promise<ActivateIcpResult> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    const rows = await t
      .select()
      .from(schema.icpProfiles)
      .where(eq(schema.icpProfiles.orgId, args.orgId))
      .for('update')
    const wanted = args.name.trim().toLowerCase()
    const target = rows.find((r) => r.name.toLowerCase() === wanted)
    if (!target) return { ok: false, reason: 'not_found', message: `There is no profile named "${args.name.slice(0, 80)}".` }
    try {
      parseIcpDefinition(target.definition)
    } catch {
      return { ok: false, reason: 'invalid', message: `The profile "${target.name}" does not parse, so it cannot be made active.` }
    }
    if (target.active) return { ok: true, changed: false, name: target.name, previous: null }
    const previous = rows.find((r) => r.active)?.name ?? null

    await t
      .update(schema.icpProfiles)
      .set({ active: false })
      .where(and(eq(schema.icpProfiles.orgId, args.orgId), eq(schema.icpProfiles.active, true), ne(schema.icpProfiles.id, target.id)))
    await t
      .update(schema.icpProfiles)
      .set({ active: true })
      .where(and(eq(schema.icpProfiles.orgId, args.orgId), eq(schema.icpProfiles.id, target.id)))
    await appendAudit(t, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'icp.activated',
      subjectType: 'icp_profile',
      subjectId: target.id,
      detail: { name: target.name, previous },
    })
    return { ok: true, changed: true, name: target.name, previous }
  })
}
