/**
 * The facts the company page's "At a glance" card reads (2026-10-16), for
 * `companySummary` in packages/core.
 *
 * The latest scan is read ONCE, and that one row feeds both the posture
 * (`postureFrom`, through the core function) and the needs (`needsOf`,
 * through `opportunityFactsFrom`): two reads of "the latest scan" in one
 * `Promise.all` can straddle a scan recorded between them, and the card
 * would then set one scan's gaps beside another scan's needs — the pairing
 * `latestScanWithFindings` exists to prevent for a score and its findings.
 *
 * The rest is read the way the card below it reads it: the ICP as
 * `get_company` loads it (a profile that does not parse is no profile), the
 * threshold through `staleAfterDaysOf`, the services through
 * `servicesMatched`, and the deal's health as `get_pipeline` computes it. A
 * read that fails costs its own line, never the card: a research count that
 * could not be read is null, never 0, and a deal whose health could not be
 * read is shown by its stage. Reads only — nothing is written or audited,
 * and every query is scoped to the org.
 */
import { and, eq } from 'drizzle-orm'
import {
  dealHealth, needsOf, parseIcpDefinition, rottingState, staleAfterDaysOf,
  type CompanySummaryFacts, type DealHealth,
} from '@agency/core'
import * as schema from './schema.js'
import { activeIcpProfile, latestScanWithFindings, type AgencyDb } from './repository.js'
import { latestSiteAudit, opportunityFactsFrom, servicesList, servicesMatched } from './opportunities.js'
import { openDealFor } from './deals.js'
import { dealHealthFacts } from './deal-health.js'
import { researchCount } from './research.js'

/** Null when the company is not in this org. */
export async function companySummaryFacts(
  db: AgencyDb,
  args: { readonly orgId: string; readonly companyId: string; readonly now: Date },
): Promise<CompanySummaryFacts | null> {
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
    .limit(1)
  if (!company) return null

  const [latest, audit, icpRow, catalogue, deal, research] = await Promise.all([
    latestScanWithFindings(db, args.orgId, company.id),
    latestSiteAudit(db, args.orgId, company.id),
    activeIcpProfile(db, args.orgId),
    servicesList(db, args.orgId, { activeOnly: true }),
    openDealFor(db, args.orgId, company.id),
    researchCount(db, args.orgId, company.id).catch(() => null),
  ])

  let signals: CompanySummaryFacts['signals'] = {}
  try {
    signals = icpRow ? parseIcpDefinition(icpRow.definition).signals : {}
  } catch {
    signals = {}
  }
  const staleAfterDays = staleAfterDaysOf(icpRow?.definition)

  // The one scan row, for both readings.
  const scan = latest
    ? {
        id: latest.scan.id,
        ranAt: latest.scan.ranAt,
        ok: latest.scan.ok,
        findings: latest.findings.map((f) => ({
          signalKey: f.signalKey, observed: f.observed, gap: f.gap, weight: f.weight, detail: f.detail, scored: f.scored,
        })),
      }
    : null
  const needs = needsOf(opportunityFactsFrom(company, scan, audit, staleAfterDays), args.now)
  const services = servicesMatched(needs, catalogue).map((s) => ({ name: s.name, suggested: s.suggested }))

  let dealFacts: CompanySummaryFacts['deal'] = null
  if (deal) {
    // `get_pipeline`'s reading of one deal, from the same facts the board gathers.
    let health: DealHealth | null = null
    try {
      const f = (await dealHealthFacts(db, { orgId: args.orgId, companyIds: [company.id], now: args.now })).get(company.id)
      if (f) {
        const rot = rottingState(deal.stage, deal.updatedAt ?? deal.createdAt, args.now)
        health = dealHealth(
          {
            stage: deal.stage, closed: false, untouched: rot ? { days: rot.days, rotten: rot.rotten } : null,
            nextActionAt: deal.nextActionAt, nextAction: deal.nextAction, ...f,
          },
          args.now,
        )
      }
    } catch {
      health = null
    }
    dealFacts = { stage: deal.stage, health }
  }

  const s = latest?.score ?? null
  return {
    domain: company.domain,
    name: company.name,
    recorded: {
      industry: company.industry,
      city: company.city,
      country: company.country,
      stage: company.stage,
      headcount: company.headcount,
      headcountSource: company.headcountSource,
    },
    signals,
    scan,
    score: s ? { score: s.score, tier: s.tier, qualified: s.qualified, disqualifiedReason: s.disqualifiedReason } : null,
    staleAfterDays,
    needs,
    services,
    deal: dealFacts,
    researchCount: research,
  }
}
