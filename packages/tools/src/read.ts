/**
 * The first read tools: the ICP, the company list, and one company's findings.
 *
 * All three are classified `low` in `AGENCY_TOOL_RISK`, like every read tool
 * in the other modules, because §5.4 puts reads there in so many words. That
 * makes the §2.2 discipline in this file the only thing standing between a
 * stale or unobserved finding and the model's context — nobody is going to be
 * asked to approve a read.
 */
import { z } from 'zod'
import {
  INFORMATIONAL_SIGNALS, countryCode, countryName, icpTargeting, informationalStatus, isStale, orderedSignals,
  parseIcpDefinition, staleAfterDaysOf, type IcpDefinition,
} from '@agency/core'
import {
  activeIcpProfile, companyList, findCompanyByDomain, latestScanWithFindings,
  type AgencyDb, type CompanyListRow,
} from '@agency/db'
import { normaliseDomain } from '@agency/scanner'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

/** The ICP, or an explanation of why there is none. Used by several tools. */
async function loadIcp(db: AgencyDb, orgId: string): Promise<IcpDefinition | null> {
  const row = await activeIcpProfile(db, orgId)
  if (!row) return null
  try {
    return parseIcpDefinition(row.definition)
  } catch {
    return null
  }
}

/**
 * The profile's re-verification window through `staleAfterDaysOf` — never the
 * raw value, which `isStale` throws on unless it is a positive number, and
 * which `get_icp` would otherwise repeat to the model as the rule.
 */
function staleDays(icp: IcpDefinition | null): number {
  return staleAfterDaysOf(icp)
}

// ---------------------------------------------------------------------------
// get_icp
// ---------------------------------------------------------------------------

export const getIcp: AgencyToolSpec<Record<string, never>> = {
  name: 'get_icp',
  description:
    'Read the agency\'s active ideal-customer profile: the qualifying threshold, the tier ' +
    'boundaries, the weighted signals a company is scored on, and the disqualifiers. Call this ' +
    'before reasoning about whether a company is a good fit, so the answer uses the agency\'s ' +
    'actual weighting rather than an invented one.',
  shape: {},
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    const icp = await loadIcp(ctx.db, ctx.orgId)
    if (!icp) return fail('not_found', 'No active ICP profile. Run the seed, or create one in settings.')
    await ctx.audit('agent.get_icp', {})

    // orderedSignals, not Object.entries: `definition` is jsonb and jsonb does
    // not preserve key order, so walking the object hands the model a
    // different weighting order than the one the scorer uses.
    const signals = orderedSignals(icp).map(([key, s]) => ({ key, weight: s.weight, why: s.why }))
    const t = icpTargeting(icp)
    const size =
      t.headcountMin !== null && t.headcountMax !== null
        ? `${t.headcountMin}–${t.headcountMax} staff`
        : t.headcountMax !== null
          ? `up to ${t.headcountMax} staff`
          : t.headcountMin !== null
            ? `${t.headcountMin}+ staff`
            : 'any size'
    return ok(
      {
        label: icp.label,
        qualifyAt: icp.scoring.qualify_at,
        tiers: icp.scoring.tiers,
        signals,
        disqualifiers: icp.disqualifiers,
        staleAfterDays: staleDays(icp),
        targeting: t,
      },
      bounded([
        `ICP: ${icp.label}`,
        `Targets: markets ${t.geos.length ? t.geos.map(countryName).join(', ') : 'every market'}; ${size}` +
          `${t.stages.length ? `; stages ${t.stages.join(', ')}` : ''}. The signals below read the same in every ` +
          'market; size and market count in a score only through the firmographic disqualifiers (enterprise_scale, ' +
          'too_small, outside_geos) when the company’s headcount or country is recorded.',
        'Other profiles, or a new one for another market or size band: list_icps, create_icp.',
        `Qualifies at ${icp.scoring.qualify_at}/100. Findings older than ${staleDays(icp)} days must be re-verified.`,
        `Tiers: ${icp.scoring.tiers.map((t) => `${t.name} at ${t.floor}+`).join(', ')}`,
        'Signals, heaviest first:',
        ...signals.map((s) => `  ${String(s.weight).padStart(2)}  ${s.key} — ${s.why}`),
        'Disqualifiers:',
        ...Object.entries(icp.disqualifiers).map(([k, v]) => `  ${k} — ${v}`),
      ]),
    )
  },
}

// ---------------------------------------------------------------------------
// search_companies
// ---------------------------------------------------------------------------

const searchShape = {
  query: z.string().max(200).optional().describe('Substring match on domain or company name.'),
  minScore: z.number().int().min(0).max(100).optional(),
  tier: z.string().max(40).optional().describe('Exact tier name, e.g. "A — call first".'),
  qualifiedOnly: z.boolean().optional(),
  neverScanned: z.boolean().optional().describe('Only companies with no scan at all.'),
  staleOnly: z.boolean().optional().describe('Only companies whose newest scan has aged out.'),
  country: z.string().max(60).optional().describe('Only companies recorded in this country — a name or a two-letter code, e.g. "India" or "IN".'),
  industry: z.string().max(80).optional().describe('Only companies whose recorded industry contains this, e.g. "fintech".'),
  headcountMin: z.number().int().min(1).optional().describe('Only companies with a recorded headcount of at least this.'),
  headcountMax: z.number().int().min(1).optional().describe('Only companies with a recorded headcount of at most this.'),
  sort: z.enum(['score_desc', 'domain']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}

export const searchCompanies: AgencyToolSpec<typeof searchShape> = {
  name: 'search_companies',
  description:
    'List companies already in the CRM with the score from their most recent scan. This is how ' +
    'you read "the pipeline": the agency sources companies here and qualifies them by scanning ' +
    'their public surface. Use sort="score_desc" with a small limit to answer "the best fit". ' +
    'Returns whether each company\'s evidence has gone stale and needs re-verifying.',
  shape: searchShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const icp = await loadIcp(ctx.db, ctx.orgId)
    const days = staleDays(icp)
    const now = ctx.now()

    const all = await companyList(ctx.db, ctx.orgId)
    const q = input.query?.trim().toLowerCase()

    const decorated = all.map((c: CompanyListRow) => ({
      domain: c.domain,
      name: c.name,
      country: c.country,
      countryCode: countryCode(c.country),
      headcount: c.headcount,
      industry: c.industry,
      city: c.city,
      score: c.score,
      tier: c.tier,
      qualified: c.qualified,
      disqualifiedReason: c.disqualifiedReason,
      lastScanAt: c.lastScanAt ? c.lastScanAt.toISOString() : null,
      lastScanReachedTheSite: c.lastScanOk,
      /** Derived from the scan's time, never read from findings.stale. */
      stale: c.lastScanAt === null ? true : isStale(c.lastScanAt, days, now),
      neverScanned: c.lastScanAt === null,
    }))

    let rows = decorated
    if (q) rows = rows.filter((r) => r.domain.includes(q) || (r.name ?? '').toLowerCase().includes(q))
    if (input.minScore !== undefined) rows = rows.filter((r) => (r.score ?? -1) >= input.minScore!)
    if (input.tier) rows = rows.filter((r) => r.tier === input.tier)
    if (input.qualifiedOnly) rows = rows.filter((r) => r.qualified)
    if (input.neverScanned) rows = rows.filter((r) => r.neverScanned)
    if (input.staleOnly) rows = rows.filter((r) => r.stale && !r.neverScanned)
    if (input.country !== undefined) {
      const code = countryCode(input.country)
      if (!code) return fail('invalid_state', `"${input.country.slice(0, 60)}" is not a country this system can read. Use a name or a two-letter code.`)
      rows = rows.filter((r) => r.countryCode === code)
    }
    if (input.industry) {
      const want = input.industry.trim().toLowerCase()
      rows = rows.filter((r) => (r.industry ?? '').toLowerCase().includes(want))
    }
    if (input.headcountMin !== undefined) rows = rows.filter((r) => r.headcount !== null && r.headcount >= input.headcountMin!)
    if (input.headcountMax !== undefined) rows = rows.filter((r) => r.headcount !== null && r.headcount <= input.headcountMax!)

    rows =
      input.sort === 'domain'
        ? [...rows].sort((a, b) => a.domain.localeCompare(b.domain))
        : [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.domain.localeCompare(b.domain))

    const limit = input.limit ?? 25
    const page = rows.slice(0, limit)
    await ctx.audit('agent.search_companies', { matched: rows.length, returned: page.length })

    const lines = page.map((r) => {
      const score = r.score === null ? '  -' : String(r.score).padStart(3)
      const label = r.disqualifiedReason
        ? `disqualified — ${r.disqualifiedReason}`
        : r.tier || (r.neverScanned ? 'never scanned' : 'below threshold')
      const facts = [r.countryCode, r.headcount !== null ? `~${r.headcount} staff` : null, r.industry]
        .filter((f): f is string => Boolean(f))
        .join(' · ')
      return (
        `${score}  ${r.domain.padEnd(28)} ${label}${r.stale && !r.neverScanned ? '  [stale]' : ''}` +
        (facts ? `  [${facts}]` : '')
      )
    })

    return ok(
      { total: rows.length, returned: page.length, companies: page },
      bounded([
        `${rows.length} companies matched; showing ${page.length}.` +
          (icp ? ` Qualifying score is ${icp.scoring.qualify_at}.` : ''),
        ...lines,
      ]),
    )
  },
}

// ---------------------------------------------------------------------------
// get_company
// ---------------------------------------------------------------------------

const getCompanyShape = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe('The company domain. A full URL is fine — it is reduced to the host.'),
}

export const getCompany: AgencyToolSpec<typeof getCompanyShape> = {
  name: 'get_company',
  description:
    'Read one company in full: its latest score and the individual findings that scan actually ' +
    'observed, each with the evidence behind it. Use this before saying anything specific about ' +
    'a company. Findings the scan could NOT observe are not returned at all — if something is ' +
    'absent here, it was not seen, and you must not claim it either way. Signals under ' +
    '`informational` were observed but are NOT scored: context, never a gap to quote to anyone.',
  shape: getCompanyShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The SAME normalisation the three write tools use, not a lowercase and a
    // trim. The model pastes what it was given, which is often a URL — and
    // `https://www.rentman.io/` used to be looked up verbatim and reported as
    // "not in the CRM" by this tool while `scan_company` handled it fine. The
    // model then believes the company is absent and says so.
    const domain = normaliseDomain(input.domain)
    if (!domain) return fail('not_found', `"${input.domain}" is not a domain.`)
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)

    const found = await latestScanWithFindings(ctx.db, ctx.orgId, company.id)
    await ctx.audit('agent.get_company', { domain })
    // What the CRM records about it (0021): research, never an observation.
    const recorded = {
      country: company.country,
      city: company.city,
      industry: company.industry,
      stage: company.stage,
      headcount: company.headcount,
      headcountSource: company.headcountSource,
      description: company.description,
    }
    const recordedLine = (() => {
      const parts = [
        company.industry ? `industry ${company.industry}` : null,
        company.city || company.country ? `in ${[company.city, company.country].filter(Boolean).join(', ')}` : null,
        company.stage ? `stage ${company.stage}` : null,
        company.headcount !== null
          ? `~${company.headcount} staff${company.headcountSource ? ` (per ${company.headcountSource.slice(0, 120)})` : ''}`
          : null,
      ].filter((p): p is string => p !== null)
      const what = company.description ? ` What it does: ${company.description.slice(0, 300)}` : ''
      return parts.length === 0 && !what
        ? 'Recorded about it: nothing beyond its domain — update_company records its industry, size and city.'
        : `Recorded about it (research, not scan evidence): ${parts.join('; ') || '—'}.${what}`
    })()

    if (!found) {
      return ok(
        { domain, name: company.name, recorded, scanned: false, findings: [] },
        `${domain} has never been scanned, so nothing has been observed about it. ${recordedLine}`,
      )
    }
    if (!found.scan.ok) {
      return ok(
        { domain, name: company.name, recorded, scanned: true, reachedTheSite: false, error: found.scan.error, findings: [] },
        `The last scan of ${domain} never reached the site (${found.scan.error ?? 'no response'}). ` +
          `Nothing was observed, so nothing can be claimed about their posture. ${recordedLine}`,
      )
    }

    const icp = await loadIcp(ctx.db, ctx.orgId)
    const days = staleDays(icp)
    const stale = isStale(found.scan.ranAt, days, ctx.now())

    // Scored and informational rows part company first. An informational
    // signal is not in the score, so it is never a gap or a strength here:
    // it goes under `informational`, labelled as unscored, where a model
    // cannot mistake it for something to lead an email with.
    const scored = found.findings.filter((f) => f.scored)
    // §2.2 and §12: drop everything the scan did not observe, BEFORE it is
    // serialised. The model's context is a rendering like any other.
    const observed = scored.filter((f) => f.observed)
    const gaps = observed.filter((f) => f.gap === true)
    const inPlace = observed.filter((f) => f.gap === false)
    const informational = found.findings
      .filter((f) => !f.scored && f.observed)
      .map((f) => ({
        key: f.signalKey,
        label: INFORMATIONAL_SIGNALS[f.signalKey]?.label ?? f.signalKey,
        why: INFORMATIONAL_SIGNALS[f.signalKey]?.why ?? null,
        observed: f.observed,
        gap: f.gap,
        status: informationalStatus(f),
        detail: f.detail,
      }))

    const payload = {
      domain,
      name: company.name,
      recorded,
      scanned: true,
      reachedTheSite: true,
      scanRanAt: found.scan.ranAt.toISOString(),
      stale,
      quotable: !stale,
      score: found.score?.score ?? null,
      tier: found.score?.tier ?? null,
      qualified: found.score?.qualified ?? false,
      disqualifiedReason: found.score?.disqualifiedReason ?? null,
      gaps: gaps.map((f) => ({
        signal: f.signalKey,
        weight: f.weight,
        detail: f.detail,
        evidence: f.evidence,
        quotable: !stale,
      })),
      strengths: inPlace.map((f) => ({ signal: f.signalKey, detail: f.detail })),
      notObservedCount: scored.length - observed.length,
      informational,
    }

    return ok(
      payload,
      bounded([
        `${domain}${company.name ? ` (${company.name})` : ''} — ${payload.score ?? '-'}/100` +
          `${payload.tier ? `, ${payload.tier}` : ''}` +
          `${payload.disqualifiedReason ? ` — disqualified: ${payload.disqualifiedReason}` : ''}`,
        recordedLine,
        `Scanned ${payload.scanRanAt}.` +
          (stale
            ? ` This evidence is older than ${days} days and MUST be re-verified before it is quoted to anyone.`
            : ' This evidence is current.'),
        payload.notObservedCount > 0
          ? `${payload.notObservedCount} signal(s) could not be observed and are therefore not listed. Do not claim anything about them.`
          : 'Every signal was observed.',
        'Gaps observed:',
        ...gaps.map((f) => `  ${String(f.weight).padStart(2)}  ${f.signalKey} — ${f.detail || 'absent'}`),
        'Already in place:',
        `  ${inPlace.map((f) => f.signalKey).join(', ') || 'none'}`,
        ...(informational.length > 0
          ? [
              `Also observed, not scored (${informational.length}) — context only; not part of the score, ` +
                'and never to be presented as a finding or quoted in outreach:',
              ...informational.map((i) => `  ${i.key} [${i.status}] — ${i.detail || i.label}`),
            ]
          : []),
      ]),
    )
  },
}
