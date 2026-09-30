/**
 * The evidence tools: a company's scan history, what changed between its two
 * most recent successful scans, and which companies' evidence can no longer
 * be quoted.
 *
 * All three are READS (`low` in `AGENCY_TOOL_RISK`), so nobody is asked to
 * approve them — which makes the §2.2 discipline below the only guard on what
 * reaches the model's context, exactly as it is in read.ts:
 *
 *  - A scan that never reached the site is "unreachable", never a score.
 *    `recordScan` stores a 0 for it and `scanHistory` already withholds that
 *    0; nothing here puts it back, and `get_stale_companies` does not read
 *    the score `companyList` pairs with such a scan either. A timeout on a
 *    chart beside real measurements reads as the company getting worse.
 *  - A signal a scan could not observe is "not assessed", never "fixed".
 *    `diffFindings` decides the change and this file only words it — and the
 *    summary states the rule in so many words, because the model repeats
 *    summaries to people. Nor is a signal whose subject went away (a CSP
 *    removed, an HSTS header dropped): that is "no longer applicable".
 *  - Freshness is derived from the scan's `ran_at` by `isStale`, never read
 *    from the cached `findings.stale`, which is current only as of the last
 *    time anybody ran a scan.
 *
 * Only `summary` reaches the model (the adapter sends nothing else), but the
 * data is held to the same rule: an unobserved side of a comparison carries no
 * detail and no evidence, because there is none.
 */
import { z } from 'zod'
import {
  isNotApplicable, isStale, staleAfterDaysOf, type DiffInput, type FindingDiffRow,
  type SignalChange,
} from '@agency/core'
import {
  activeIcpProfile, companyList, findCompanyByDomain, latestEvidenceChanges, scanHistory, type AgencyDb,
} from '@agency/db'
import { normaliseDomain } from '@agency/scanner'
import {
  TOOL_TEXT_BUDGET, bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome,
} from './spec.js'

/**
 * Room for `bounded`'s own "… N more rows omitted" line, so a truncated
 * result is still inside the budget rather than one line past it.
 */
const BUDGET = TOOL_TEXT_BUDGET - 100

/**
 * The ICP's re-verification window, through `staleAfterDaysOf`: no ICP, one
 * that does not parse, or a value `isStale` would throw on is the default
 * window — never "fresh forever", and never a thrown tool call.
 */
async function staleAfterDays(db: AgencyDb, orgId: string): Promise<number> {
  return staleAfterDaysOf((await activeIcpProfile(db, orgId))?.definition)
}

type Lookup =
  | { readonly ok: true; readonly domain: string; readonly id: string; readonly name: string | null }
  | { readonly ok: false; readonly outcome: ToolOutcome<never> }

/** The company, by the SAME normalisation get_company uses, so a pasted URL finds it. */
async function lookUp(ctx: ToolContext, raw: string): Promise<Lookup> {
  const domain = normaliseDomain(raw)
  if (!domain) return { ok: false, outcome: fail('not_found', `"${raw}" is not a domain.`) }
  const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
  if (!company) return { ok: false, outcome: fail('not_found', `No company with domain "${domain}" is in the CRM.`) }
  return { ok: true, domain, id: company.id, name: company.name }
}

/** Whitespace folded, cut by CODE POINTS so a cut never leaves half a character. */
function clip(text: string | null, max: number): string {
  const chars = Array.from((text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

const day = (d: Date): string => d.toISOString().slice(0, 10)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------
// get_scan_history
// ---------------------------------------------------------------------------

const scanHistoryShape = {
  domain: z.string().min(1).max(253).describe('The company.'),
  limit: z.number().int().min(1).max(20).optional().describe('How many scans, newest first. Default 10.'),
}

export const getScanHistory: AgencyToolSpec<typeof scanHistoryShape> = {
  name: 'get_scan_history',
  description:
    'Read every scan of a company, newest first, with the score that was computed from each one and ' +
    'whether the scan reached the site. Use it to see how a company’s posture has moved over time; ' +
    'use get_company for the current findings. A read; nothing is sent.',
  shape: scanHistoryShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const found = await lookUp(ctx, input.domain)
    if (!found.ok) return found.outcome
    const { domain, name } = found
    const label = `${domain}${name ? ` (${name})` : ''}`

    const limit = input.limit ?? 10
    const history = await scanHistory(ctx.db, ctx.orgId, found.id, limit)
    const days = await staleAfterDays(ctx.db, ctx.orgId)
    const now = ctx.now()
    await ctx.audit('agent.get_scan_history', { companyId: found.id, returned: history.length })

    const scans = history.map((h) => ({
      scanId: h.scan.id,
      ranAt: h.scan.ranAt.toISOString(),
      reachedTheSite: h.scan.ok,
      /** Why it did not, when it did not. */
      error: h.scan.ok ? null : clip(h.scan.error, 120) || null,
      // `scanHistory` hands back no score for a scan that did not reach the
      // site, whatever `scores` holds for it. Null here, never 0.
      score: h.score?.score ?? null,
      tier: h.score?.tier ?? null,
      qualified: h.score?.qualified ?? null,
      disqualifiedReason: h.score?.disqualifiedReason ?? null,
      /** Derived from `ran_at`; the `findings.stale` column is never read. */
      stale: isStale(h.scan.ranAt, days, now),
    }))

    if (scans.length === 0) {
      return ok(
        { domain, name, scans },
        `${label} has never been scanned, so it has no history and nothing has been observed about it.`,
      )
    }

    const newestReached = history.find((h) => h.scan.ok)
    const lines = scans.map((s) => {
      const when = s.ranAt.slice(0, 10)
      if (!s.reachedTheSite) return `  ${when} · not reached · unreachable (${s.error ?? 'no response'})`
      if (s.score === null) return `  ${when} · reached · not scored`
      const standing = s.disqualifiedReason
        ? `disqualified — ${clip(s.disqualifiedReason, 100)}`
        : s.tier || 'below threshold'
      return `  ${when} · reached · ${s.score}/100 · ${standing}`
    })

    return ok(
      { domain, name, staleAfterDays: days, scans },
      bounded(
        [
          `${label} — ${plural(scans.length, 'scan')}, newest first` +
            (scans.length === limit ? ` (the ${limit} most recent; there may be older ones).` : '.'),
          newestReached
            ? isStale(newestReached.scan.ranAt, days, now)
              ? `The newest scan that reached the site is from ${day(newestReached.scan.ranAt)}, older than ` +
                `${days} days: its evidence must be re-verified before it is quoted to anyone.`
              : `The newest scan that reached the site is from ${day(newestReached.scan.ranAt)} and is current.`
            : 'No scan has ever reached the site, so nothing has been observed about it.',
          ...(scans.some((s) => !s.reachedTheSite)
            ? [
                'A scan that did not reach the site observed nothing. It has no score — it is not a 0 — and ' +
                  'the absence of findings on it is not evidence of anything.',
              ]
            : []),
          ...lines,
        ],
        BUDGET,
      ),
    )
  },
}

// ---------------------------------------------------------------------------
// get_evidence_changes
// ---------------------------------------------------------------------------

const evidenceChangesShape = {
  domain: z.string().min(1).max(253).describe('The company.'),
}

/** One side of a comparison. Unobserved carries nothing: there was nothing to carry. */
function side(d: DiffInput) {
  return d.observed && d.gap !== null
    ? { observed: true as const, gap: d.gap, notApplicable: isNotApplicable(d), detail: d.detail, evidence: d.evidence }
    : { observed: false as const }
}

/**
 * How one observed side reads, in words the model can repeat. A side with
 * nothing to judge is "not applicable" in the scanner's own words, and an
 * informational side that raised nothing is "observed" — the company page's
 * words for both. Neither is "in place".
 */
function reads(d: DiffInput): string {
  if (!d.observed || d.gap === null) return 'not observed'
  const detail = clip(d.detail, 100)
  if (isNotApplicable(d)) return detail || 'not applicable'
  const word = d.gap ? 'a gap' : d.scored === false ? 'observed' : 'in place'
  return `${word}${detail ? ` (${detail})` : ''}`
}

/** A change as the context line words it: never the enum, never a fix it was not. */
const CHANGE_PHRASE: Readonly<Record<SignalChange, string>> = {
  fixed: 'fixed',
  regressed: 'regressed',
  not_assessed_this_time: 'not assessed this time',
  now_observed: 'observed this time',
  no_longer_applicable: 'no longer applicable (nothing to judge now; not a fix)',
  now_applicable: 'now applicable (a first reading; not a regression)',
  new_signal: 'new',
  unchanged: 'unchanged',
}

const weighted = (r: FindingDiffRow): string => `  ${String(r.weight).padStart(2)}  ${r.signalKey}`

export const getEvidenceChanges: AgencyToolSpec<typeof evidenceChangesShape> = {
  name: 'get_evidence_changes',
  description:
    'Compare the two most recent SUCCESSFUL scans of a company signal by signal: what was fixed, what ' +
    'appeared, and what could not be observed on one of them and so is not compared. Only what the ' +
    'scanner actually saw is reported (§2.2). A read; nothing is sent.',
  shape: evidenceChangesShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const found = await lookUp(ctx, input.domain)
    if (!found.ok) return found.outcome
    const { domain, name } = found
    const label = `${domain}${name ? ` (${name})` : ''}`

    const changes = await latestEvidenceChanges(ctx.db, ctx.orgId, found.id)
    if (!changes) {
      return fail(
        'not_found',
        `${label} does not have two scans that reached the site, so there is nothing to compare. That is ` +
          'not the same as nothing having changed. A scan that did not reach the site observed nothing and ' +
          'is never compared; get_scan_history shows every scan.',
      )
    }

    const { newer, older, diff } = changes
    const days = await staleAfterDays(ctx.db, ctx.orgId)
    const stale = isStale(newer.ranAt, days, ctx.now())
    await ctx.audit('agent.get_evidence_changes', {
      companyId: found.id,
      newerScanId: newer.id,
      olderScanId: older.id,
      ...diff.summary,
    })

    // An informational signal is not in the score, so it is never "fixed" or
    // "regressed" as a finding — it is reported apart, as context, the way
    // get_company lists it apart.
    const scored = diff.rows.filter((r) => r.scored)
    const informational = diff.rows.filter((r) => !r.scored && r.change !== 'unchanged')
    const of = (c: SignalChange) => scored.filter((r) => r.change === c)
    const fixed = of('fixed')
    const regressed = of('regressed')
    const nowObserved = of('now_observed')
    const notAssessed = of('not_assessed_this_time')
    const noLonger = of('no_longer_applicable')
    const nowApplicable = of('now_applicable')
    const added = of('new_signal')
    const unchanged = of('unchanged')

    const section = (rows: readonly FindingDiffRow[], heading: string, line: (r: FindingDiffRow) => string) =>
      rows.length === 0 ? [] : [heading, ...rows.map(line)]

    const lines = [
      `${label}: the scan of ${day(newer.ranAt)} compared with the scan of ${day(older.ranAt)}; both reached the site.`,
      stale
        ? `The newer scan is older than ${days} days. Nothing below may be quoted to anyone until it is re-verified.`
        : 'The newer scan is current.',
      ...section(fixed, `Fixed (${fixed.length}) — a gap on the older scan, observed in place on the newer one:`, (r) =>
        `${weighted(r)} — was ${reads(r.older!)}; now ${reads(r.newer)}`),
      ...section(regressed, `Regressed (${regressed.length}) — in place on the older scan, observed as a gap on the newer one:`, (r) =>
        `${weighted(r)} — now ${reads(r.newer)}`),
      ...section(
        nowObserved,
        `Now observed (${nowObserved.length}) — the older scan could not see these, so this is a first ` +
          'observation, not a change:',
        (r) => `${weighted(r)} — ${reads(r.newer)}`,
      ),
      ...section(
        notAssessed,
        `Not assessed this time (${notAssessed.length}) — the newer scan could not observe these. Not assessed ` +
          'is not fixed: say nothing about them either way.',
        (r) => `  ${r.signalKey}`,
      ),
      ...section(
        noLonger,
        `No longer applicable (${noLonger.length}) — judged on the older scan; on the newer one there is ` +
          'nothing to judge (the header or policy is gone). Not a fix:',
        (r) => `${weighted(r)} — was ${reads(r.older!)}; now ${reads(r.newer)}`,
      ),
      ...section(
        nowApplicable,
        `Now applicable (${nowApplicable.length}) — nothing to judge on the older scan, so this is a first ` +
          'reading, not a regression:',
        (r) => `${weighted(r)} — ${reads(r.newer)}`,
      ),
      ...section(
        added,
        `New signals (${added.length}) — not on the older scan at all, so there is nothing to compare:`,
        (r) => `${weighted(r)} — ${reads(r.newer)}`,
      ),
      ...(fixed.length + regressed.length + noLonger.length + nowApplicable.length === 0
        ? ['Nothing observed on both scans changed.']
        : []),
      ...(unchanged.length > 0
        ? [`Unchanged, observed on both (${unchanged.length}): ${unchanged.map((r) => r.signalKey).join(', ')}`]
        : []),
      ...(informational.length > 0
        ? [
            `Also changed, not scored (${informational.length}) — context only, never a finding to quote: ` +
              informational.map((r) => `${r.signalKey} ${CHANGE_PHRASE[r.change]}`).join(', '),
          ]
        : []),
    ]

    return ok(
      {
        domain,
        name,
        newer: { scanId: newer.id, ranAt: newer.ranAt.toISOString(), stale },
        older: { scanId: older.id, ranAt: older.ranAt.toISOString() },
        quotable: !stale,
        counts: diff.summary,
        changes: diff.rows.map((r) => ({
          signal: r.signalKey,
          change: r.change,
          scored: r.scored,
          weight: r.weight,
          older: r.older ? side(r.older) : null,
          newer: side(r.newer),
        })),
      },
      bounded(lines, BUDGET),
    )
  },
}

// ---------------------------------------------------------------------------
// get_stale_companies
// ---------------------------------------------------------------------------

const staleCompaniesShape = {
  limit: z.number().int().min(1).max(100).optional().describe('How many companies. Default 25.'),
}

type WhyNotQuotable = 'stale' | 'unreachable' | 'no_scan'

/** Stale first — those have evidence someone may be about to repeat — then the two with none at all. */
const WHY_RANK: Record<WhyNotQuotable, number> = { stale: 0, unreachable: 1, no_scan: 2 }

export const getStaleCompanies: AgencyToolSpec<typeof staleCompaniesShape> = {
  name: 'get_stale_companies',
  description:
    'List the companies whose evidence may not be quoted — stale by the ICP’s freshness window, ' +
    'unreachable on the last scan, or never scanned — and why, so a re-scan can be asked for before ' +
    'anything is drafted from them. A read; it scans nothing and sends nothing.',
  shape: staleCompaniesShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const days = await staleAfterDays(ctx.db, ctx.orgId)
    const now = ctx.now()
    const all = await companyList(ctx.db, ctx.orgId)

    const listed = all.flatMap((c) => {
      // `lastScanOk` is the LATEST scan's: a company whose newest scan timed
      // out has nothing current to quote, whatever an earlier scan saw.
      const why: WhyNotQuotable | null =
        c.lastScanAt === null
          ? 'no_scan'
          : c.lastScanOk === false
            ? 'unreachable'
            : isStale(c.lastScanAt, days, now)
              ? 'stale'
              : null
      if (why === null) return []
      return [{
        domain: c.domain,
        name: c.name,
        why,
        lastScanAt: c.lastScanAt ? c.lastScanAt.toISOString() : null,
        // The score of a stale scan is still what that scan measured. An
        // unreachable scan's stored 0 is not a measurement, so it is not read.
        lastScore: why === 'stale' ? c.score : null,
        tier: why === 'stale' ? c.tier : null,
      }]
    })

    listed.sort(
      (a, b) =>
        WHY_RANK[a.why] - WHY_RANK[b.why] ||
        (b.lastScore ?? -1) - (a.lastScore ?? -1) ||
        a.domain.localeCompare(b.domain),
    )
    const page = listed.slice(0, input.limit ?? 25)
    const count = (w: WhyNotQuotable) => listed.filter((r) => r.why === w).length
    await ctx.audit('agent.get_stale_companies', { matched: listed.length, returned: page.length })

    if (listed.length === 0) {
      return ok(
        { staleAfterDays: days, total: 0, returned: 0, companies: [] },
        all.length === 0
          ? 'There are no companies in the CRM.'
          : `Every company's evidence is current: each was scanned within the last ${days} days and the ` +
            'scan reached the site. Nothing was scanned by this call.',
      )
    }

    const lines = page.map((r) => {
      const label = `${r.domain}${r.name ? ` (${clip(r.name, 60)})` : ''}`
      if (r.why === 'no_scan') return `  no_scan      ${label} — never scanned; nothing has been observed`
      const when = r.lastScanAt!.slice(0, 10)
      if (r.why === 'unreachable') {
        return `  unreachable  ${label} — the last scan (${when}) did not reach the site; nothing was observed`
      }
      const ago = Math.floor((now.getTime() - new Date(r.lastScanAt!).getTime()) / 86_400_000)
      return `  stale        ${label} — last observed ${when}, ${plural(ago, 'day')} ago` +
        (r.lastScore !== null ? `; scored ${r.lastScore} then` : '')
    })

    return ok(
      { staleAfterDays: days, total: listed.length, returned: page.length, companies: page },
      bounded(
        [
          `${listed.length} of ${plural(all.length, 'company', 'companies')} have evidence that may not be quoted ` +
            `(findings older than ${days} days must be re-verified): ${count('stale')} stale, ` +
            `${count('unreachable')} unreachable on the last scan, ${count('no_scan')} never scanned. ` +
            `Showing ${page.length}.`,
          'score_company re-scans one before you rely on it. Nothing was scanned by this call.',
          ...lines,
        ],
        BUDGET,
      ),
    )
  },
}
