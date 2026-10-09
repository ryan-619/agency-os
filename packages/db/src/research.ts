/**
 * Research about a company, with its sources (0028).
 *
 * `researchRecord` stores claims with the page each came from, for a
 * company in this org, skipping one already on file (the same claim from
 * the same page) and refusing a claim or a source `packages/core` refuses;
 * one audit row per call, `research.recorded { companyId, recorded,
 * skipped }` — counts, never the claims. `researchFor` reads them newest
 * first with who recorded each; `researchDelete` is the author's or an
 * owner's, as a note's is. Nothing here is evidence, and nothing here is
 * read by the send path, the proposal or the brief.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { RESEARCH_PER_CALL, RESEARCH_TITLE_MAX, researchClaimProblem, researchSourceProblem } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'

export type ResearchRow = typeof schema.companyResearch.$inferSelect

export interface ResearchFact {
  readonly claim: string
  readonly sourceUrl: string
  readonly sourceTitle?: string | null
}

export type ResearchRecordResult =
  | { readonly ok: true; readonly recorded: number; readonly skipped: number; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: 'not_found' | 'invalid' | 'too_many'; readonly message: string }

export async function researchRecord(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly facts: readonly ResearchFact[]
    /** The person recording it, or null for the agent. */
    readonly recordedBy: string | null
    readonly actor: string
  },
): Promise<ResearchRecordResult> {
  if (args.facts.length === 0) return { ok: false, reason: 'invalid', message: 'Nothing to record: give at least one claim with its source.' }
  if (args.facts.length > RESEARCH_PER_CALL) return { ok: false, reason: 'too_many', message: `At most ${RESEARCH_PER_CALL} claims a call.` }
  for (const [i, f] of args.facts.entries()) {
    const problem = researchClaimProblem(f.claim) ?? researchSourceProblem(f.sourceUrl)
    if (problem) return { ok: false, reason: 'invalid', message: `Claim ${i + 1}: ${problem}` }
    if (f.sourceTitle && [...f.sourceTitle].length > RESEARCH_TITLE_MAX) {
      return { ok: false, reason: 'invalid', message: `Claim ${i + 1}: a source title is at most ${RESEARCH_TITLE_MAX} characters.` }
    }
  }
  const [company] = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
    .limit(1)
  if (!company) return { ok: false, reason: 'not_found', message: 'That company is not in the CRM.' }

  const ids: string[] = []
  let skipped = 0
  for (const f of args.facts) {
    const inserted = await db
      .insert(schema.companyResearch)
      .values({
        orgId: args.orgId, companyId: args.companyId, claim: f.claim.trim(), sourceUrl: f.sourceUrl.trim(),
        sourceTitle: f.sourceTitle?.trim() || null, recordedBy: args.recordedBy,
      })
      .onConflictDoNothing()
      .returning({ id: schema.companyResearch.id })
    if (inserted[0]) ids.push(inserted[0].id)
    else skipped++
  }
  await appendAudit(db, {
    orgId: args.orgId, actor: args.actor, action: 'research.recorded', subjectType: 'company', subjectId: args.companyId,
    detail: { companyId: args.companyId, recorded: ids.length, skipped, recordedBy: args.recordedBy },
  }).catch(() => {})
  return { ok: true, recorded: ids.length, skipped, ids }
}

export interface ResearchView extends ResearchRow {
  readonly recordedByName: string | null
  readonly recordedByEmail: string | null
}

/** A company's research, newest first, with who recorded each (null for the agent). */
export async function researchFor(db: AgencyDb, orgId: string, companyId: string, limit = 100): Promise<ResearchView[]> {
  const rows = await db
    .select({ row: schema.companyResearch, recordedByName: schema.users.name, recordedByEmail: schema.users.email })
    .from(schema.companyResearch)
    .leftJoin(schema.users, eq(schema.users.id, schema.companyResearch.recordedBy))
    .where(and(eq(schema.companyResearch.orgId, orgId), eq(schema.companyResearch.companyId, companyId)))
    .orderBy(desc(schema.companyResearch.createdAt), desc(schema.companyResearch.id))
    .limit(Math.max(1, Math.min(limit, 500)))
  return rows.map((r) => ({ ...r.row, recordedByName: r.recordedByName, recordedByEmail: r.recordedByEmail }))
}

export async function researchCount(db: AgencyDb, orgId: string, companyId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.companyResearch)
    .where(and(eq(schema.companyResearch.orgId, orgId), eq(schema.companyResearch.companyId, companyId)))
  return r?.n ?? 0
}

/** The author's, an owner's — or anybody's when the agent recorded it, because then nobody owns it. */
export async function researchDelete(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly byUserId: string; readonly isOwner: boolean },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_permitted'; message: string }> {
  const mayDelete = args.isOwner
    ? sql`true`
    : sql`(${schema.companyResearch.recordedBy} IS NULL OR ${schema.companyResearch.recordedBy} = ${args.byUserId}::uuid)`
  const rows = await db
    .delete(schema.companyResearch)
    .where(and(eq(schema.companyResearch.orgId, args.orgId), eq(schema.companyResearch.id, args.id), mayDelete))
    .returning({ id: schema.companyResearch.id, companyId: schema.companyResearch.companyId })
  const gone = rows[0]
  if (!gone) {
    const exists = await db
      .select({ id: schema.companyResearch.id })
      .from(schema.companyResearch)
      .where(and(eq(schema.companyResearch.orgId, args.orgId), eq(schema.companyResearch.id, args.id)))
      .limit(1)
    return exists.length === 0
      ? { ok: false, reason: 'not_found', message: 'No such research claim.' }
      : { ok: false, reason: 'not_permitted', message: 'Only the person who recorded a claim, or an owner, can delete it.' }
  }
  await appendAudit(db, {
    orgId: args.orgId, actor: args.byUserId, action: 'research.deleted', subjectType: 'company', subjectId: gone.companyId,
    detail: { companyId: gone.companyId, researchId: gone.id },
  }).catch(() => {})
  return { ok: true }
}
