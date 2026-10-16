/**
 * At a glance (2026-10-16): one card at the top of the company page that
 * says, in a dozen lines, what the cards below it say at length.
 *
 * Nothing here is a new reading. The posture is `postureFrom` — the rule
 * the meeting brief applies, shared rather than copied; the needs are
 * `needsOf`'s and the services `servicesFor`'s, handed in as read; the deal
 * is `dealHealth`'s, in `get_pipeline`'s words; and whether the scan is
 * current is `isStale` on its `ran_at`, never `findings.stale`. The one
 * thing decided here is the order of the evidence states, and that is
 * `needsOf`'s order — a scan past its deadline is stale before it is a
 * failure — so the card and the needs card below it never disagree about
 * the same scan.
 *
 * §2.2 holds as everywhere: a gap is named only from a scan that reached
 * the site and is inside its deadline, in the ICP's `why`; what is in place
 * is said by signal KEY, never by `why`, which is written as the gap; and a
 * scan that did not reach the site claims no posture at all — though the
 * dated `site_down` need `needsOf` reads from it stands, because that is
 * what was observed. A stale or missing scan speaks for the SCAN only: a
 * PageSpeed audit is its own measurement, dated and current on its own
 * clock, so the card never says nothing about the site is current above a
 * need that audit shows. A placeholder (`.inbound`, `.nosite.invalid`) is
 * never told to scan: the scanner refuses both, and a company's domain
 * cannot be changed (the company route answers 400), so the one remedy
 * named is adding the real domain as a company of its own. And a business
 * filed with no website is worded from `needsOf`'s reading of its listing,
 * never from the placeholder alone: "Google Maps lists no website" only
 * beside the dated need that says so, because the placeholder is also kept
 * when nobody read a listing, when the one on record is too old to quote,
 * and when a listing names a site of its own — one the filing could not
 * use, or one added to Google since and refreshed by place id.
 *
 * Derived, never stored, never printed by a tool and never read by anything
 * outbound: the card's own note says so, and a quote comes from the current
 * scan's cards, never from here. Pure: no clock but `now`, and the same
 * facts give the same card.
 */
import { postureFrom, type BriefFinding } from './brief.js'
import type { DealHealth, DealHealthLevel } from './deal-health.js'
import { isStale } from './freshness.js'
import { isNoSiteDomain, type NeedKey, type NeedSource, type NeedsReading } from './opportunity.js'

export interface CompanySummaryFacts {
  /** `companies.domain` — never printed: an `.inbound` placeholder is named after a person. */
  readonly domain: string
  readonly name: string | null
  /** What the CRM records about it (0021): research, never an observation. No description — it is unbounded, and on the edit card. */
  readonly recorded: {
    readonly industry: string | null
    readonly city: string | null
    readonly country: string | null
    readonly stage: string | null
    readonly headcount: number | null
    readonly headcountSource: string | null
  }
  /** The active ICP's signals; {} when there is none or it does not parse. */
  readonly signals: Readonly<Record<string, { readonly why: string }>>
  /** The latest scan, ok or not, with its findings — the SAME row `needs` was read from. */
  readonly scan: { readonly id: string; readonly ranAt: Date; readonly ok: boolean; readonly findings: readonly BriefFinding[] } | null
  /** The score computed FROM that scan, never the newest score row. */
  readonly score: {
    readonly score: number
    readonly tier: string | null
    readonly qualified: boolean
    readonly disqualifiedReason: string | null
  } | null
  /** `staleAfterDaysOf`'s answer, so `isStale` cannot throw on a hand-edited 0. */
  readonly staleAfterDays: number
  /** `needsOf` over the SAME scan row. */
  readonly needs: NeedsReading
  readonly services: readonly { readonly name: string; readonly suggested: boolean }[]
  /** The open deal; `health` is null when its facts could not be read. */
  readonly deal: { readonly stage: string; readonly health: DealHealth | null } | null
  /** Null means the read failed, never zero. */
  readonly researchCount: number | null
}

export type SummaryEvidence = 'current' | 'stale' | 'unreachable' | 'never_scanned' | 'no_site' | 'inbound'

export type SummaryLineKind =
  | 'evidence' | 'gaps' | 'in_place' | 'needs' | 'services' | 'deal' | 'recorded' | 'research' | 'not_assessed'

export interface CompanySummary {
  readonly evidence: SummaryEvidence
  readonly scanId: string | null
  readonly headline: string
  readonly lines: readonly { readonly kind: SummaryLineKind; readonly text: string }[]
}

/** Under the card, every time: what it is, and where a quote comes from instead. */
export const COMPANY_SUMMARY_NOTE =
  "Derived from the records on this page as they are now — never evidence. Only a current scan's findings are quoted to anybody, from the cards below."

/** Code points, as a person counts them; every line and the headline are cut to it. */
export const SUMMARY_LINE_MAX = 240

/** At most this many gaps are named; the rest are counted. */
const GAPS_SHOWN = 5
/** At most this many not-assessed sentences. */
const NOT_ASSESSED_SHOWN = 3

const SOURCE_WORDS: Readonly<Record<NeedSource, string>> = { listing: 'Google listing', scan: 'scan', audit: 'PageSpeed' }

/** `get_pipeline`'s words for a deal's level, so the card and the chat read a deal alike. */
const LEVEL_WORDS: Readonly<Record<DealHealthLevel, string>> = { act: 'needs a person', watch: 'drifting', ok: 'on track' }
const LEVEL_HEADLINE: Readonly<Record<DealHealthLevel, string>> = {
  act: 'the deal needs a person',
  watch: 'the deal is drifting',
  ok: 'the deal is on track',
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function clip(text: string, max: number = SUMMARY_LINE_MAX): string {
  const points = [...text]
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`

/**
 * Which state the evidence is in — `needsOf`'s order: a placeholder first,
 * then no scan, then a scan past its deadline (failed or not), then one that
 * did not reach the site.
 */
function evidenceOf(facts: CompanySummaryFacts, now: Date): SummaryEvidence {
  if (facts.domain.toLowerCase().endsWith('.inbound')) return 'inbound'
  if (isNoSiteDomain(facts.domain)) return 'no_site'
  if (!facts.scan) return 'never_scanned'
  if (isStale(facts.scan.ranAt, facts.staleAfterDays, now)) return 'stale'
  if (!facts.scan.ok) return 'unreachable'
  return 'current'
}

/** The needs a listing raises about what it names as the website — the only ones that say whether there is one. */
const LISTED_WEBSITE_NEEDS: readonly NeedKey[] = ['no_website', 'website_is_a_profile', 'free_builder_site']

/**
 * A business filed under the no-website placeholder, in the words its
 * listing's reading allows. "No website" is said only beside `needsOf`'s
 * dated `no_website` need — a current listing that names none. A listing
 * that names a site of its own (refreshed by place id since the filing, or
 * a host the filing could not use) is said as such, with the remedy that
 * exists; a profile or a builder address is named as the listing names it;
 * and with no listing, or one too old to quote (whose own not-assessed line
 * says so), nothing about a website is established.
 */
function noSiteWords(needs: NeedsReading): { readonly state: string; readonly line: string } {
  const listed = needs.needs.find((n) => n.source === 'listing' && LISTED_WEBSITE_NEEDS.includes(n.key))
  const w = needs.website
  if (listed?.key === 'no_website') {
    return { state: 'Google Maps lists no website for them', line: `Google Maps lists no website for them (read ${day(listed.asOf)}).` }
  }
  if (listed) {
    return {
      state: `Its Google listing's website is ${w.label}`,
      line: `Filed without a website of its own: its Google listing's website is ${w.label} (${w.host ? `${w.host}, ` : ''}read ${day(listed.asOf)}).`,
    }
  }
  if (w.kind === 'own' && w.host) {
    return {
      state: `Filed without a website, but its Google listing names one (${w.host})`,
      line:
        `Filed without a website, but its Google listing names one (${w.host}) — a company's domain cannot be changed, ` +
        'so add that domain as a company of its own to scan it.',
    }
  }
  return {
    state: 'Filed without a website; whether they have one is not established',
    line: 'Filed without a website; whether they have one is not established.',
  }
}

function evidenceLine(evidence: SummaryEvidence, facts: CompanySummaryFacts): string {
  const scan = facts.scan
  switch (evidence) {
    case 'inbound':
      return "An inbound lead filed under a placeholder — no company website is on record; once you know their business domain, add it as a company of its own (a company's domain cannot be changed)."
    case 'no_site':
      return noSiteWords(facts.needs).line
    case 'never_scanned':
      return 'Never scanned — nothing a scan would observe is claimed.'
    case 'stale':
      return `The scan of ${day(scan!.ranAt)} is past its ${facts.staleAfterDays}-day deadline — none of its findings is current; re-scan before quoting anything that scan observed.`
    case 'unreachable':
      return `The latest scan (${day(scan!.ranAt)}) did not reach the site — nothing about its posture is claimed.`
    case 'current': {
      const on = `Scan of ${day(scan!.ranAt)}, current`
      const s = facts.score
      if (!s) return `${on}; no score was computed from it.`
      if (s.disqualifiedReason) return `${on}: disqualified — ${s.disqualifiedReason}.`
      return `${on}: ${s.score}/100${s.tier ? `, tier ${s.tier}` : ''}, ${s.qualified ? 'qualified' : 'below the qualifying threshold'}.`
    }
  }
}

function headlineOf(
  evidence: SummaryEvidence,
  facts: CompanySummaryFacts,
  gaps: number,
): string {
  const state = ((): string => {
    switch (evidence) {
      case 'inbound':
        return 'An inbound lead with no company website on record yet'
      case 'no_site':
        return noSiteWords(facts.needs).state
      case 'never_scanned':
        return 'Never scanned'
      case 'stale':
        return 'The latest scan is past its deadline, so none of its findings is current'
      case 'unreachable':
        return 'The latest scan did not reach the site'
      case 'current': {
        const s = facts.score
        const lead = !s
          ? 'A current scan with no score'
          : s.disqualifiedReason
            ? 'Disqualified on a current scan'
            : `${s.score}/100 on a current scan`
        return `${lead}, ${plural(gaps, 'gap')} observed`
      }
    }
  })()
  const parts = [state]
  if (evidence !== 'inbound') {
    const n = facts.needs.needs.length
    parts.push(n > 0 ? `${plural(n, 'need')} read from evidence` : 'no need read from evidence')
  }
  const deal = facts.deal
  parts.push(!deal ? 'no open deal' : deal.health ? LEVEL_HEADLINE[deal.health.level] : `the deal is at ${deal.stage}`)
  return `${parts.join('; ')}.`
}

function recordedLine(r: CompanySummaryFacts['recorded']): string | null {
  const parts = [
    r.industry ? `industry ${r.industry}` : null,
    r.city || r.country ? `in ${[r.city, r.country].filter(Boolean).join(', ')}` : null,
    r.stage ? `stage ${r.stage}` : null,
    r.headcount !== null
      ? `~${r.headcount} staff${r.headcountSource ? ` (per ${[...r.headcountSource].slice(0, 120).join('')})` : ''}`
      : null,
  ].filter((p): p is string => p !== null)
  return parts.length === 0 ? null : `Recorded from research, not observed: ${parts.join('; ')}.`
}

function servicesLine(services: CompanySummaryFacts['services']): string | null {
  if (services.length === 0) return null
  const own = services.filter((s) => !s.suggested).map((s) => s.name)
  const suggested = services.filter((s) => s.suggested).map((s) => s.name)
  const parts = [
    ...(own.length > 0 ? [own.join(', ')] : []),
    ...(suggested.length > 0 ? [`${suggested.join(', ')} (suggested — no catalogue yet)`] : []),
  ]
  return `Services that answer them: ${parts.join('; ')}.`
}

function dealLine(deal: CompanySummaryFacts['deal']): string {
  if (!deal) return 'No open deal.'
  const h = deal.health
  if (!h) return `Deal: ${deal.stage}.`
  return h.reasons.length > 0
    ? `Deal: ${deal.stage} — ${LEVEL_WORDS[h.level]}: ${h.reasons.join('; ')}.`
    : `Deal: ${deal.stage} — ${LEVEL_WORDS[h.level]}.`
}

export function companySummary(facts: CompanySummaryFacts, now: Date): CompanySummary {
  const evidence = evidenceOf(facts, now)
  const scan = facts.scan
  // Posture only for a site of its own that was scanned; `fresh` inside
  // keeps a stale or failed scan's gaps AND its strengths out.
  const posture =
    scan && evidence !== 'inbound' && evidence !== 'no_site'
      ? postureFrom({ signals: facts.signals, findings: scan.findings, scan: { ranAt: scan.ranAt, ok: scan.ok, stale: evidence === 'stale' } })
      : null

  const lines: { kind: SummaryLineKind; text: string }[] = [{ kind: 'evidence', text: evidenceLine(evidence, facts) }]

  if (posture?.fresh && scan) {
    const on = day(scan.ranAt)
    for (const g of posture.gaps.slice(0, GAPS_SHOWN)) lines.push({ kind: 'gaps', text: `Gap observed ${on}: ${g.why}` })
    const more = posture.gaps.length - GAPS_SHOWN
    if (more > 0) {
      lines.push({ kind: 'gaps', text: `+${more} more ${more === 1 ? 'gap' : 'gaps'} — listed under “What was observed from the outside” below.` })
    }
    if (posture.strengths.length > 0) lines.push({ kind: 'in_place', text: `In place (scan of ${on}): ${posture.strengths.join(', ')}` })
  }

  if (evidence !== 'inbound') {
    for (const n of facts.needs.needs) {
      lines.push({ kind: 'needs', text: `Need: ${n.label} (${SOURCE_WORDS[n.source]}, ${day(n.asOf)})` })
    }
    const services = servicesLine(facts.services)
    if (services) lines.push({ kind: 'services', text: services })
  }

  lines.push({ kind: 'deal', text: dealLine(facts.deal) })

  const recorded = recordedLine(facts.recorded)
  if (recorded) lines.push({ kind: 'recorded', text: recorded })

  const research = facts.researchCount
  if (research !== null && research > 0) {
    lines.push({ kind: 'research', text: `${plural(research, 'research claim')} on file — research, never evidence.` })
  }

  if (evidence !== 'inbound') {
    const unknown = facts.needs.notAssessed
    for (const sentence of unknown.slice(0, NOT_ASSESSED_SHOWN)) lines.push({ kind: 'not_assessed', text: `Not assessed: ${sentence}` })
    const more = unknown.length - NOT_ASSESSED_SHOWN
    if (more > 0) lines.push({ kind: 'not_assessed', text: `+${more} more not assessed — under “What this business needs” below.` })
  }

  return {
    evidence,
    scanId: scan?.id ?? null,
    headline: clip(headlineOf(evidence, facts, posture?.gaps.length ?? 0)),
    lines: lines.map((l) => ({ kind: l.kind, text: clip(l.text) })),
  }
}
