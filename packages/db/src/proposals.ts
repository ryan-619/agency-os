/**
 * Proposals generated from findings (PROMPT.md §8.6).
 *
 * The generator is `proposalFromFindings` in `packages/core`, pure and tested
 * against the §2.2 edges — stale scans, unobserved signals, nothing to
 * propose. This gathers what it needs and stores what it produced, tied to
 * the scan it was generated from (0012, the discipline `scores.scan_id` set).
 *
 * A proposal's status is its own life: drafted, sent, and what the buyer
 * said. SENDING one is the send path's job (§8.4), never this module's; the
 * `sent` status records that it happened.
 */
import { and, desc, eq } from 'drizzle-orm'
import {
  isStale, parseIcpDefinition, proposalFromFindings, staleAfterDaysOf,
  type Proposal, type ProposalOutcome,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { activeIcpProfile, latestScanWithFindings } from './repository.js'
import { appendAudit } from './approvals.js'
import { advanceDeal, openDealFor, setDealStage } from './deals.js'

export type ProposalRow = typeof schema.proposals.$inferSelect
export type ProposalStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'withdrawn'

/**
 * Generate and store a proposal for a company, from its latest scan.
 *
 * Refuses, with the generator's own words, when there is nothing honest to
 * propose from: no scan, an unreachable site, a stale scan, a scan scored
 * under a different ICP profile (`rescore`), no gaps. A stale scan is the
 * important one — a proposal is the most outbound draft there is, and §2.2
 * says stale findings are re-verified before appearing in one.
 */
export async function generateProposal(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly createdBy?: string | null
    readonly actor: string
    readonly dayRate?: number | null
    readonly currency?: string
    readonly now?: Date
  },
): Promise<{ ok: true; proposal: ProposalRow; document: Proposal } | Extract<ProposalOutcome, { ok: false }>> {
  const now = args.now ?? new Date()

  const [org] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, args.orgId)).limit(1)
  const companyRows = await db
    .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
    .limit(1)
  const company = companyRows[0]
  if (!org || !company) {
    return { ok: false, reason: 'no_scan', message: 'That company is not in the CRM.' }
  }

  const icpRow = await activeIcpProfile(db, args.orgId)
  if (!icpRow) return { ok: false, reason: 'no_scan', message: 'There is no active ICP profile to write scope from.' }
  const icp = parseIcpDefinition(icpRow.definition)
  // Never the raw value: `isStale` throws on one that is not a positive number.
  const staleAfter = staleAfterDaysOf(icp)

  const found = await latestScanWithFindings(db, args.orgId, args.companyId)
  if (!found) {
    return { ok: false, reason: 'no_scan', message: `${company.domain} has not been scanned, so there are no findings to write from.` }
  }

  const outcome = proposalFromFindings({
    company: { domain: company.domain, name: company.name },
    agency: { name: org.name },
    icp,
    // EVERY row, informational ones included, each with its `scored` flag.
    // The generator leaves the unscored ones out of the scope and the
    // buyer's "of N signals observed" itself — and it needs to see them: a
    // row for a key the ACTIVE ICP scores that this scan recorded unscored is
    // a scan from before a promotion, which it refuses as `rescore` rather
    // than calling the signal not assessed.
    findings: found.findings.map((f) => ({
      signalKey: f.signalKey,
      observed: f.observed,
      gap: f.gap,
      weight: f.weight,
      detail: f.detail,
      evidence: (f.evidence ?? {}) as Record<string, unknown>,
      scored: f.scored,
    })),
    scan: { ranAt: found.scan.ranAt, ok: found.scan.ok, stale: isStale(found.scan.ranAt, staleAfter, now) },
    score: found.score ? { score: found.score.score, tier: found.score.tier } : null,
    profiles: { activeProfileId: icpRow.id, scoreProfileId: found.score?.icpProfileId ?? null },
    dayRate: args.dayRate ?? null,
    currency: args.currency ?? 'USD',
    generatedAt: now,
  })
  if (!outcome.ok) return outcome

  const deal = await openDealFor(db, args.orgId, args.companyId)
  const rows = await db
    .insert(schema.proposals)
    .values({
      orgId: args.orgId,
      companyId: args.companyId,
      dealId: deal?.id ?? null,
      scanId: found.scan.id,
      status: 'draft',
      title: outcome.proposal.title,
      document: outcome.proposal,
      currency: outcome.proposal.pricing.currency,
      totalLow: outcome.proposal.pricing.total?.low ?? null,
      totalHigh: outcome.proposal.pricing.total?.high ?? null,
      generatedAt: now,
      createdBy: args.createdBy ?? null,
    })
    .returning()
  const proposal = rows[0]
  if (!proposal) throw new Error('proposal insert returned no row')

  // Writing a proposal is the deal reaching `proposal` — forward only.
  await advanceDeal(db, {
    orgId: args.orgId,
    companyId: args.companyId,
    to: 'proposal',
    nextAction: 'Review the generated proposal and send it',
  }).catch(() => null)

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'proposal.generated',
    subjectType: 'proposal',
    subjectId: proposal.id,
    detail: {
      companyId: args.companyId,
      scanId: found.scan.id,
      workstreams: outcome.proposal.workstreams.length,
      scopeItems: outcome.proposal.workstreams.reduce((n, w) => n + w.items.length, 0),
      notAssessed: outcome.proposal.notAssessed.length,
    },
  }).catch(() => {})

  return { ok: true, proposal, document: outcome.proposal }
}

export async function readProposal(db: AgencyDb, orgId: string, id: string): Promise<ProposalRow | null> {
  const rows = await db
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.orgId, orgId), eq(schema.proposals.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export async function proposalsForCompany(db: AgencyDb, orgId: string, companyId: string): Promise<ProposalRow[]> {
  return db
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.orgId, orgId), eq(schema.proposals.companyId, companyId)))
    .orderBy(desc(schema.proposals.createdAt))
}

export async function listProposals(db: AgencyDb, orgId: string, limit = 100): Promise<ProposalRow[]> {
  return db
    .select()
    .from(schema.proposals)
    .where(eq(schema.proposals.orgId, orgId))
    .orderBy(desc(schema.proposals.createdAt))
    .limit(limit)
}

/**
 * Record what happened to a proposal.
 *
 * `accepted` moves the deal to `won` and `declined` needs the reason the
 * board will show; both are a person's decision, recorded with a time by the
 * constraint (`proposals_decided_has_time`).
 *
 * `from` is the status the caller read and decided against. When it is
 * given, it is in the UPDATE's own WHERE, so a status that changed in
 * between is not overwritten: the team's route reads, checks the move, and
 * writes, and a buyer accepting through their link can commit between the
 * two — without the predicate a teammate's "Declined" turned an accepted
 * proposal declined while its deal stayed won. No match answers null, as an
 * unknown proposal does, and nothing is written or audited; the caller
 * re-reads to say which. Review round 3, finding [12].
 */
export async function setProposalStatus(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly id: string
    readonly status: ProposalStatus
    readonly actor: string
    readonly now?: Date
    /** The status the caller read. Omitted only by a caller that holds the row locked (`shareAccept`). */
    readonly from?: ProposalStatus
  },
): Promise<ProposalRow | null> {
  const now = args.now ?? new Date()
  const decided = args.status === 'accepted' || args.status === 'declined'
  const rows = await db
    .update(schema.proposals)
    .set({ status: args.status, decidedAt: decided ? now : null })
    .where(
      and(
        eq(schema.proposals.orgId, args.orgId),
        eq(schema.proposals.id, args.id),
        ...(args.from !== undefined ? [eq(schema.proposals.status, args.from)] : []),
      ),
    )
    .returning()
  const row = rows[0]
  if (!row) return null

  if (args.status === 'accepted') {
    // `won` CLOSES the deal, which is `setDealStage`'s job (it stamps
    // closed_at); `advanceDeal` only moves the stage. If no deal is open —
    // somebody accepted a proposal on a company whose deal was lost and
    // reopened nowhere — one is created and closed in the same breath.
    const open = await openDealFor(db, args.orgId, row.companyId)
    const deal = open ?? (await advanceDeal(db, { orgId: args.orgId, companyId: row.companyId, to: 'proposal' })).deal
    await setDealStage(db, { orgId: args.orgId, dealId: deal.id, stage: 'won', now }).catch(() => null)
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: `proposal.${args.status}`,
    subjectType: 'proposal',
    subjectId: row.id,
    detail: { companyId: row.companyId },
  }).catch(() => {})
  return row
}
