/**
 * At a glance (2026-10-16): the company page's card, from facts the page
 * already reads.
 *
 * The edges worth pinning are where a summary goes wrong by saying more
 * than its sources: a stale or failed scan's gaps repeated as current, a
 * strength worded as the gap it is not, an informational row read as a
 * finding, a placeholder told to scan (or to have its domain set, which
 * nothing can do), a business called website-less on its placeholder alone,
 * a stale scan speaking for a current PageSpeed audit, a research count that
 * could not be read shown as 0 — and the card drifting from the cards it summarises,
 * which is why the posture is `meetingBrief`'s own rule and the needs are
 * `needsOf`'s, run here for real.
 */
import { describe, it, expect } from 'vitest'
import {
  COMPANY_SUMMARY_NOTE, SUMMARY_LINE_MAX, companySummary, meetingBrief, needsOf, noSiteDomain,
  type BriefFinding, type CompanySummaryFacts, type OpportunityFacts, type SummaryLineKind,
} from '../src/index.js'

const DAY = 86_400_000
const NOW = new Date('2026-10-16T09:00:00.000Z')
const RAN = new Date('2026-10-10T08:00:00.000Z')
const OLD = new Date(NOW.getTime() - 20 * DAY)

const signals = {
  csp: { why: 'No Content-Security-Policy' },
  trust_page: { why: 'No /security or /trust page' },
  compliance_claim: { why: 'No SOC 2 / ISO 27001 claim' },
  security_txt: { why: 'No security.txt' },
  hsts: { why: 'No Strict-Transport-Security' },
  outdated_js: { why: 'Known-outdated JS library' },
  frame_protection: { why: 'No X-Frame-Options' },
  tls: { why: 'TLS configuration problem' },
  server_banner: { why: 'Server header discloses its version' },
}

const gap = (signalKey: string, weight: number): BriefFinding => ({ signalKey, observed: true, gap: true, weight, detail: `${signalKey} absent`, scored: true })
const clear = (signalKey: string, weight: number): BriefFinding => ({ signalKey, observed: true, gap: false, weight, detail: null, scored: true })

const FINDINGS: readonly BriefFinding[] = [
  gap('csp', 15), gap('hsts', 10), clear('tls', 8), clear('server_banner', 7),
  // An informational row: observed, a "gap", never a finding of the score.
  { signalKey: 'cross_origin_policies', observed: true, gap: true, weight: 0, detail: 'none sent', scored: false },
  // Not observed: never a gap or a strength.
  { signalKey: 'security_txt', observed: false, gap: null, weight: 12, detail: 'timed out', scored: true },
]

/** `needsOf` itself, over the same scan the card is handed. */
function reading(domain: string, scan: CompanySummaryFacts['scan'], extra: Partial<OpportunityFacts> = {}) {
  return needsOf(
    {
      domain,
      listing: null,
      scan: scan ? { ranAt: scan.ranAt, ok: scan.ok, findings: scan.findings.map((f) => ({ key: f.signalKey, observed: f.observed, gap: f.gap, detail: f.detail })) } : null,
      audit: null,
      staleAfterDays: 14,
      ...extra,
    },
    NOW,
  )
}

function facts(over: Partial<CompanySummaryFacts> = {}): CompanySummaryFacts {
  const domain = over.domain ?? 'rentman.io'
  const scan = over.scan === undefined ? { id: 'scan-1', ranAt: RAN, ok: true, findings: FINDINGS } : over.scan
  return {
    domain,
    name: 'Rentman',
    recorded: { industry: null, city: null, country: null, stage: null, headcount: null, headcountSource: null },
    signals,
    scan,
    score: { score: 72, tier: 'A — call first', qualified: true, disqualifiedReason: null },
    staleAfterDays: 14,
    needs: reading(domain, scan),
    services: [],
    deal: null,
    researchCount: null,
    ...over,
  }
}

/** A PageSpeed audit measured yesterday: current on its own clock, whatever the scan's. */
const AUDIT: NonNullable<OpportunityFacts['audit']> = {
  ranAt: new Date(NOW.getTime() - DAY), ok: true, strategy: 'mobile', error: null, performance: 22, seo: 95, accessibility: 95, lcpMs: 7400,
}

const kinds = (s: ReturnType<typeof companySummary>, kind: SummaryLineKind): string[] =>
  s.lines.filter((l) => l.kind === kind).map((l) => l.text)
const allText = (s: ReturnType<typeof companySummary>): string => [s.headline, ...s.lines.map((l) => l.text)].join('\n')

describe('a current scan', () => {
  it('says the scan, its date and its score, and names the gaps in the ICP’s words, heaviest first', () => {
    const s = companySummary(facts(), NOW)
    expect(s.evidence).toBe('current')
    expect(s.scanId).toBe('scan-1')
    expect(kinds(s, 'evidence')).toEqual(['Scan of 2026-10-10, current: 72/100, tier A — call first, qualified.'])
    expect(kinds(s, 'gaps')).toEqual([
      'Gap observed 2026-10-10: No Content-Security-Policy',
      'Gap observed 2026-10-10: No Strict-Transport-Security',
    ])
    // csp and hsts are security gaps, so `needsOf` reads one need from the same scan.
    expect(s.headline).toBe('72/100 on a current scan, 2 gaps observed; 1 need read from evidence; no open deal.')
  })

  it('says what is in place by signal KEY, never by `why`, which is written as the gap', () => {
    const s = companySummary(facts(), NOW)
    expect(kinds(s, 'in_place')).toEqual(['In place (scan of 2026-10-10): tls, server_banner'])
    expect(allText(s)).not.toContain('TLS configuration problem')
    expect(allText(s)).not.toContain('Server header discloses')
  })

  it('never reads an informational, unscored or unobserved row as a gap or a strength', () => {
    const t = allText(companySummary(facts(), NOW))
    expect(t).not.toContain('cross_origin_policies')
    expect(t).not.toContain('none sent')
    expect(t).not.toContain('No security.txt')
    expect(t).not.toContain('security_txt')
  })

  it('names at most five gaps, then counts the rest', () => {
    const many = [gap('csp', 15), gap('trust_page', 14), gap('compliance_claim', 12), gap('security_txt', 12), gap('hsts', 10), gap('outdated_js', 10), gap('frame_protection', 8)]
    const s = companySummary(facts({ scan: { id: 's', ranAt: RAN, ok: true, findings: many } }), NOW)
    const lines = kinds(s, 'gaps')
    expect(lines).toHaveLength(6)
    expect(lines.slice(0, 5).map((l) => l.replace('Gap observed 2026-10-10: ', ''))).toEqual([
      'No Content-Security-Policy', 'No /security or /trust page', 'No SOC 2 / ISO 27001 claim', 'No security.txt', 'No Strict-Transport-Security',
    ])
    expect(lines[5]).toBe('+2 more gaps — listed under “What was observed from the outside” below.')
    expect(s.headline).toMatch(/7 gaps observed/)
  })

  it('names a gap by its key when there is no ICP to word it', () => {
    const s = companySummary(facts({ signals: {} }), NOW)
    expect(kinds(s, 'gaps')).toEqual(['Gap observed 2026-10-10: csp', 'Gap observed 2026-10-10: hsts'])
  })

  it('reads a key named __proto__ as its own key and touches no prototype', () => {
    const proto: BriefFinding = { signalKey: '__proto__', observed: true, gap: true, weight: 20, detail: 'x', scored: true }
    // With an ICP that does not name it, it is not a talking point at all.
    const withIcp = companySummary(facts({ scan: { id: 's', ranAt: RAN, ok: true, findings: [...FINDINGS, proto] } }), NOW)
    expect(allText(withIcp)).not.toContain('__proto__')
    // With none, it is named by its key — and Object.prototype's own members never answer for it.
    const without = companySummary(facts({ signals: {}, scan: { id: 's', ranAt: RAN, ok: true, findings: [proto] } }), NOW)
    expect(kinds(without, 'gaps')).toEqual(['Gap observed 2026-10-10: __proto__'])
    expect(({} as Record<string, unknown>).why).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'why')).toBe(false)
  })

  it('shows a disqualifier with its reason', () => {
    const s = companySummary(facts({ score: { score: 0, tier: null, qualified: false, disqualifiedReason: 'is_security_vendor' } }), NOW)
    expect(kinds(s, 'evidence')).toEqual(['Scan of 2026-10-10, current: disqualified — is_security_vendor.'])
    expect(s.headline).toMatch(/^Disqualified on a current scan, 2 gaps observed/)
  })

  it('says when no score was computed from the scan, and when one is below every tier', () => {
    expect(kinds(companySummary(facts({ score: null }), NOW), 'evidence')).toEqual(['Scan of 2026-10-10, current; no score was computed from it.'])
    expect(kinds(companySummary(facts({ score: { score: 30, tier: null, qualified: false, disqualifiedReason: null } }), NOW), 'evidence'))
      .toEqual(['Scan of 2026-10-10, current: 30/100, below the qualifying threshold.'])
  })
})

describe('evidence that cannot be quoted (§2.2)', () => {
  it('a stale scan: no gap, no `why`, nothing in place — and the deadline and the date named', () => {
    const scan = { id: 'old', ranAt: OLD, ok: true, findings: FINDINGS }
    const s = companySummary(facts({ scan, needs: reading('rentman.io', scan) }), NOW)
    expect(s.evidence).toBe('stale')
    expect(kinds(s, 'gaps')).toEqual([])
    expect(kinds(s, 'in_place')).toEqual([])
    for (const w of Object.values(signals)) expect(allText(s)).not.toContain(w.why)
    expect(kinds(s, 'evidence')).toEqual([
      'The scan of 2026-09-26 is past its 14-day deadline — none of its findings is current; re-scan before quoting anything that scan observed.',
    ])
    expect(s.headline).toBe('The latest scan is past its deadline, so none of its findings is current; no need read from evidence; no open deal.')
    // The score of a stale scan is not repeated as current.
    expect(allText(s)).not.toContain('72/100')
  })

  it('a stale scan that also failed reads as stale — needsOf’s order', () => {
    const scan = { id: 'old', ranAt: OLD, ok: false, findings: [] }
    const s = companySummary(facts({ scan, needs: reading('rentman.io', scan) }), NOW)
    expect(s.evidence).toBe('stale')
    expect(kinds(s, 'needs')).toEqual([])
  })

  it('a scan that did not reach the site claims no posture, even with findings handed in — and keeps the dated site_down need', () => {
    const scan = { id: 'failed', ranAt: RAN, ok: false, findings: FINDINGS }
    const s = companySummary(facts({ scan, needs: reading('rentman.io', scan) }), NOW)
    expect(s.evidence).toBe('unreachable')
    expect(kinds(s, 'evidence')).toEqual(['The latest scan (2026-10-10) did not reach the site — nothing about its posture is claimed.'])
    expect(kinds(s, 'gaps')).toEqual([])
    expect(kinds(s, 'in_place')).toEqual([])
    expect(kinds(s, 'needs')).toEqual(['Need: Site did not load (scan, 2026-10-10)'])
  })

  it('never scanned: nothing a scan would observe is claimed, and the not-assessed line says so', () => {
    const s = companySummary(facts({ scan: null, score: null }), NOW)
    expect(s.evidence).toBe('never_scanned')
    expect(s.scanId).toBeNull()
    expect(kinds(s, 'evidence')).toEqual(['Never scanned — nothing a scan would observe is claimed.'])
    expect(kinds(s, 'gaps')).toEqual([])
    expect(kinds(s, 'in_place')).toEqual([])
    expect(kinds(s, 'not_assessed').join(' ')).toMatch(/never been scanned/)
    expect(s.headline).toMatch(/^Never scanned;/)
  })

  // A PageSpeed audit is its own measurement, current on its own clock: a
  // stale or missing scan speaks for the scan, never for the site.
  it.each([
    ['a stale scan', { id: 'old', ranAt: OLD, ok: true, findings: FINDINGS }, 'stale'],
    ['no scan', null, 'never_scanned'],
  ] as const)('%s beside a current PageSpeed audit: the audit’s need is listed, and no line says nothing about the site is current or claimed', (_label, scan, state) => {
    const needs = reading('rentman.io', scan, { audit: AUDIT })
    expect(needs.needs.map((n) => n.key)).toEqual(['slow_site'])
    const s = companySummary(facts({ scan, score: scan ? facts().score : null, needs }), NOW)
    expect(s.evidence).toBe(state)
    expect(kinds(s, 'needs')).toEqual(['Need: Slow on phones (PageSpeed, 2026-10-15)'])
    expect(s.headline).toMatch(/; 1 need read from evidence; /)
    expect(allText(s)).not.toMatch(/nothing about the site/i)
    expect(allText(s)).not.toMatch(/before saying anything about the site/i)
    // Still nothing the scan observed.
    expect(kinds(s, 'gaps')).toEqual([])
    expect(kinds(s, 'in_place')).toEqual([])
  })
})

describe('placeholders', () => {
  it('an .inbound lead is never told to scan, and shows no needs, services or not-assessed lines — nor its domain', () => {
    const domain = 'jane-doe-gmail-com.inbound'
    const s = companySummary(
      facts({ domain, name: 'Jane Doe', scan: null, score: null, services: [{ name: 'New website', suggested: true }] }),
      NOW,
    )
    expect(s.evidence).toBe('inbound')
    // A company's domain cannot be changed (the company route answers 400), so
    // the only remedy is the real domain filed as a company of its own.
    expect(kinds(s, 'evidence')).toEqual([
      "An inbound lead filed under a placeholder — no company website is on record; once you know their business domain, add it as a company of its own (a company's domain cannot be changed).",
    ])
    expect(allText(s)).not.toMatch(/set the (real )?domain|change the domain/i)
    expect(allText(s)).not.toMatch(/scan it/i)
    expect(kinds(s, 'needs')).toEqual([])
    expect(kinds(s, 'services')).toEqual([])
    expect(kinds(s, 'not_assessed')).toEqual([])
    // The placeholder is named after a person.
    expect(allText(s)).not.toContain('jane-doe')
  })

  it('a business with no website shows the listing’s needs, dated by the listing', () => {
    const domain = noSiteDomain('Kumar Dental', 'ChIJkumar')
    const listing = { checkedAt: new Date(NOW.getTime() - 2 * DAY), website: null, rating: 4.6, reviews: 12, category: 'dentist' }
    const s = companySummary(facts({ domain, scan: null, score: null, needs: reading(domain, null, { listing }) }), NOW)
    expect(s.evidence).toBe('no_site')
    // "No website" only beside the dated need that says so.
    expect(kinds(s, 'evidence')).toEqual(['Google Maps lists no website for them (read 2026-10-14).'])
    expect(s.headline).toBe('Google Maps lists no website for them; 2 needs read from evidence; no open deal.')
    expect(kinds(s, 'needs')).toEqual(['Need: No website (Google listing, 2026-10-14)', 'Need: Few Google reviews (Google listing, 2026-10-14)'])
    expect(kinds(s, 'not_assessed')).toEqual([])
    expect(allText(s)).not.toMatch(/scan it/i)
  })

  // Chat's no-Google route (`add_company` with website "none", 0029) files
  // under the placeholder with no listing at all.
  it('a business filed without a website and no listing read: the headline does not say it has none', () => {
    const domain = noSiteDomain('Yummy Bites', 'name:yummy bites|delhi|')
    const s = companySummary(facts({ domain, scan: null, score: null, needs: reading(domain, null) }), NOW)
    expect(s.evidence).toBe('no_site')
    expect(s.headline).toBe('Filed without a website; whether they have one is not established; no need read from evidence; no open deal.')
    expect(kinds(s, 'evidence')).toEqual(['Filed without a website; whether they have one is not established.'])
    expect(kinds(s, 'needs')).toEqual([])
    expect(kinds(s, 'not_assessed')).toEqual([
      'Not assessed: No website is on record for them, and no listing was read — whether they have a website was not established.',
    ])
    expect(allText(s)).not.toMatch(/no website of its own|lists no website/i)
  })

  it('a listing too old to quote that named none establishes nothing either, and says why below', () => {
    const domain = noSiteDomain('Kumar Dental', 'ChIJkumar')
    const listing = { checkedAt: new Date(NOW.getTime() - 120 * DAY), website: null, rating: 4.6, reviews: 12, category: 'dentist' }
    const s = companySummary(facts({ domain, scan: null, score: null, needs: reading(domain, null, { listing }) }), NOW)
    expect(kinds(s, 'evidence')).toEqual(['Filed without a website; whether they have one is not established.'])
    expect(kinds(s, 'needs')).toEqual([])
    expect(kinds(s, 'not_assessed')).toEqual([
      'Not assessed: The Google listing was read on 2026-06-18, more than 90 days ago — read it again before quoting it.',
    ])
    expect(allText(s)).not.toMatch(/no website of its own|lists no website/i)
  })

  // Filed under the placeholder when its listing named none (or a host the
  // filing could not use); the owner has since added a site to Google, and
  // the next search refreshed the listing by place id and kept the domain.
  it('a placeholder whose listing names a site of its own says so, with the one remedy that exists', () => {
    const domain = noSiteDomain('Sharma Optics', 'place:ChIJsharma')
    const listing = { checkedAt: new Date(NOW.getTime() - 2 * DAY), website: 'https://sharmaoptics.in/', rating: 4.5, reviews: 80, category: 'optician' }
    const needs = reading(domain, null, { listing })
    expect(needs.website).toMatchObject({ kind: 'own', host: 'sharmaoptics.in' })
    const s = companySummary(facts({ domain, scan: null, score: null, needs }), NOW)
    expect(s.evidence).toBe('no_site')
    expect(s.headline).toBe('Filed without a website, but its Google listing names one (sharmaoptics.in); no need read from evidence; no open deal.')
    expect(kinds(s, 'evidence')).toEqual([
      "Filed without a website, but its Google listing names one (sharmaoptics.in) — a company's domain cannot be changed, so add that domain as a company of its own to scan it.",
    ])
    expect(allText(s)).not.toMatch(/no website of its own|lists no website/i)
  })

  it('a placeholder whose listing names a Facebook page names it as the listing does, dated', () => {
    const domain = noSiteDomain('Kumar Dental', 'ChIJkumar')
    const listing = { checkedAt: new Date(NOW.getTime() - 2 * DAY), website: 'https://www.facebook.com/kumardental', rating: 4.6, reviews: 40, category: 'dentist' }
    const s = companySummary(facts({ domain, scan: null, score: null, needs: reading(domain, null, { listing }) }), NOW)
    expect(s.headline).toMatch(/^Its Google listing's website is a Facebook page; 1 need read from evidence;/)
    expect(kinds(s, 'evidence')).toEqual(["Filed without a website of its own: its Google listing's website is a Facebook page (facebook.com, read 2026-10-14)."])
    expect(kinds(s, 'needs')).toEqual(['Need: Website is only a profile or listing (Google listing, 2026-10-14)'])
  })
})

describe('the deal, in get_pipeline’s words', () => {
  it('act, watch and ok', () => {
    const line = (health: { level: 'act' | 'watch' | 'ok'; reasons: string[] }, stage = 'replied') =>
      kinds(companySummary(facts({ deal: { stage, health } }), NOW), 'deal')
    expect(line({ level: 'act', reasons: ['a reply is waiting unanswered', 'no next action set'] }))
      .toEqual(['Deal: replied — needs a person: a reply is waiting unanswered; no next action set.'])
    expect(line({ level: 'watch', reasons: ['untouched for 9 days'] }, 'contacted')).toEqual(['Deal: contacted — drifting: untouched for 9 days.'])
    expect(line({ level: 'ok', reasons: ['meeting in 3 days'] }, 'meeting')).toEqual(['Deal: meeting — on track: meeting in 3 days.'])
    expect(line({ level: 'ok', reasons: [] }, 'proposal')).toEqual(['Deal: proposal — on track.'])
    expect(companySummary(facts({ deal: { stage: 'replied', health: { level: 'act', reasons: ['x'] } } }), NOW).headline).toMatch(/the deal needs a person\.$/)
  })

  it('a deal whose health could not be read is its stage alone; no deal says so', () => {
    expect(kinds(companySummary(facts({ deal: { stage: 'contacted', health: null } }), NOW), 'deal')).toEqual(['Deal: contacted.'])
    expect(kinds(companySummary(facts({ deal: null }), NOW), 'deal')).toEqual(['No open deal.'])
  })
})

describe('research, recorded facts and services', () => {
  it('a research count that could not be read is no line, never 0; a count is counted', () => {
    expect(kinds(companySummary(facts({ researchCount: null }), NOW), 'research')).toEqual([])
    expect(kinds(companySummary(facts({ researchCount: 0 }), NOW), 'research')).toEqual([])
    expect(kinds(companySummary(facts({ researchCount: 1 }), NOW), 'research')).toEqual(['1 research claim on file — research, never evidence.'])
    expect(kinds(companySummary(facts({ researchCount: 3 }), NOW), 'research')).toEqual(['3 research claims on file — research, never evidence.'])
  })

  it('labels what is recorded as research, not observed — and never prints a description', () => {
    const recorded = {
      industry: 'SaaS', city: 'Bengaluru', country: 'IN', stage: 'seed', headcount: 40, headcountSource: 'LinkedIn company page',
      description: 'A DESCRIPTION NOBODY ASKED FOR',
    } as CompanySummaryFacts['recorded']
    const s = companySummary(facts({ recorded }), NOW)
    expect(kinds(s, 'recorded')).toEqual([
      'Recorded from research, not observed: industry SaaS; in Bengaluru, IN; stage seed; ~40 staff (per LinkedIn company page).',
    ])
    expect(allText(s)).not.toContain('DESCRIPTION')
    expect(kinds(companySummary(facts(), NOW), 'recorded')).toEqual([])
  })

  it('labels suggested services, and names a catalogue’s plainly', () => {
    expect(kinds(companySummary(facts({ services: [{ name: 'New website', suggested: true }, { name: 'Website redesign', suggested: true }] }), NOW), 'services'))
      .toEqual(['Services that answer them: New website, Website redesign (suggested — no catalogue yet).'])
    expect(kinds(companySummary(facts({ services: [{ name: 'Security hardening', suggested: false }] }), NOW), 'services'))
      .toEqual(['Services that answer them: Security hardening.'])
    expect(kinds(companySummary(facts({ services: [] }), NOW), 'services')).toEqual([])
  })
})

describe('bounds and output', () => {
  it('cuts every line and the headline to SUMMARY_LINE_MAX code points, never through a character', () => {
    const long = `No CSP ${'🔒'.repeat(400)}`
    const s = companySummary(
      facts({
        signals: { ...signals, csp: { why: long } },
        recorded: { industry: '🏥'.repeat(300), city: null, country: null, stage: null, headcount: null, headcountSource: null },
      }),
      NOW,
    )
    for (const text of [s.headline, ...s.lines.map((l) => l.text)]) {
      expect([...text].length).toBeLessThanOrEqual(SUMMARY_LINE_MAX)
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
    const csp = kinds(s, 'gaps')[0]!
    expect([...csp].length).toBe(SUMMARY_LINE_MAX)
    expect(csp.endsWith('…')).toBe(true)
  })

  it('is the same card for the same facts', () => {
    expect(companySummary(facts(), NOW)).toEqual(companySummary(facts(), NOW))
  })

  it('says, under the card, that it is never evidence', () => {
    expect(COMPANY_SUMMARY_NOTE).toMatch(/never evidence/)
    expect(COMPANY_SUMMARY_NOTE).toMatch(/current scan/)
  })
})

describe('agreement with the cards below it', () => {
  const brief = (scan: { ranAt: Date; ok: boolean; stale: boolean } | null, findings: readonly BriefFinding[]) =>
    meetingBrief({
      meeting: { startsAt: NOW, timeZone: 'Asia/Kolkata', title: null },
      company: { domain: 'rentman.io', name: 'Rentman', country: 'IN' },
      contacts: [], deal: null, signals, findings, scan, score: null, thread: [],
    })

  it.each([
    ['fresh', RAN, true],
    ['stale', OLD, true],
    ['failed', RAN, false],
  ] as const)('a %s scan: the card’s gaps are the brief’s', (_label, ranAt, ok) => {
    const scan = { id: 's', ranAt, ok, findings: FINDINGS }
    const s = companySummary(facts({ scan, needs: reading('rentman.io', scan) }), NOW)
    const b = brief({ ranAt, ok, stale: s.evidence === 'stale' }, FINDINGS)
    expect(kinds(s, 'gaps')).toEqual(b.posture.gaps.map((g) => `Gap observed ${ranAt.toISOString().slice(0, 10)}: ${g.why}`))
    expect(kinds(s, 'in_place')).toEqual(
      b.posture.strengths.length > 0 ? [`In place (scan of ${ranAt.toISOString().slice(0, 10)}): ${b.posture.strengths.join(', ')}`] : [],
    )
  })

  it('the card’s needs are needsOf’s, in its order, with their sources and dates', () => {
    const scan = {
      id: 's', ranAt: RAN, ok: true,
      findings: [
        ...FINDINGS,
        { signalKey: 'mobile_viewport', observed: true, gap: true, weight: 0, detail: 'no viewport tag', scored: false },
        { signalKey: 'whatsapp_chat', observed: true, gap: true, weight: 0, detail: 'no WhatsApp chat link', scored: false },
      ],
    }
    const needs = reading('rentman.io', scan)
    const s = companySummary(facts({ scan, needs }), NOW)
    expect(needs.needs.map((n) => n.key)).toEqual(['not_mobile_friendly', 'no_whatsapp', 'security_gaps'])
    expect(kinds(s, 'needs')).toEqual(needs.needs.map((n) => `Need: ${n.label} (scan, 2026-10-10)`))
    // A presence row is a need, never a gap: it is unscored.
    expect(allText(s)).not.toContain('mobile_viewport')
  })
})
