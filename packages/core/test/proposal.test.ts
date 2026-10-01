/**
 * Proposals written from findings (PROMPT.md §8.6, under §2.2).
 *
 * The scope is DERIVED from observed gaps, and the tests that matter are the
 * ones about what must never become scope: a signal the scanner could not
 * observe, a scan that has aged out, a site that was never reached. A
 * proposal that quietly omitted what it could not see would read as if it
 * had looked and found nothing — which is a claim, and §2.2 forbids it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PROPOSAL_RESCORE_SENTENCE, parseIcpDefinition, proposalFromFindings, proposalNeedsRescore, type ProposalFinding,
  type ProposalInput,
} from '../src/index.js'

const seed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../db/seed/icp-security-gap-saas.json', import.meta.url)), 'utf8'),
) as { signals: Record<string, { weight: number; order: number; why: string }> }
const icp = parseIcpDefinition(seed)
const ACTIVE = '11111111-1111-4111-8111-111111111111'
const EARLIER = '22222222-2222-4222-8222-222222222222'
const RAN = new Date('2026-09-10T08:00:00.000Z')
const NOW = new Date('2026-09-15T12:00:00.000Z')

/** Every signal observed; the listed ones are gaps, the rest in place. */
function findings(gaps: string[], over: Partial<ProposalFinding>[] = []): ProposalFinding[] {
  const base: ProposalFinding[] = Object.entries(icp.signals).map(([key, s]) => ({
    signalKey: key,
    observed: true,
    gap: gaps.includes(key),
    weight: s.weight,
    detail: gaps.includes(key) ? `${key} absent` : null,
    evidence: gaps.includes(key) ? { url: 'https://www.rentman.io/', seen: 'absent' } : { seen: 'present' },
  }))
  for (const o of over) {
    const i = base.findIndex((f) => f.signalKey === o.signalKey)
    if (i >= 0) base[i] = { ...base[i]!, ...o }
  }
  return base
}

const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  company: { domain: 'rentman.io', name: 'Rentman' },
  agency: { name: 'Agency' },
  icp,
  findings: findings(['csp', 'hsts', 'security_txt']),
  scan: { ranAt: RAN, stale: false, ok: true },
  score: { score: 71, tier: 'A' },
  profiles: { activeProfileId: ACTIVE, scoreProfileId: ACTIVE },
  dayRate: 1200,
  currency: 'USD',
  generatedAt: NOW,
  ...over,
})

describe('what becomes scope', () => {
  it('turns each observed gap into a scope item, and nothing else', () => {
    const out = proposalFromFindings(input())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const keys = out.proposal.workstreams.flatMap((w) => w.items.map((i) => i.signalKey)).sort()
    expect(keys).toEqual(['csp', 'hsts', 'security_txt'])
  })

  it('groups the headers into one workstream and disclosure into another', () => {
    const out = proposalFromFindings(input())
    if (!out.ok) throw new Error(out.message)
    expect(out.proposal.workstreams.map((w) => w.name)).toEqual([
      'Security headers baseline',
      'Trust and disclosure programme',
    ])
    expect(out.proposal.workstreams[0]!.items.map((i) => i.signalKey)).toEqual(['csp', 'hsts'])
  })

  it('leads with the heaviest gap’s workstream, in the ICP’s order', () => {
    const out = proposalFromFindings(input({ findings: findings(['security_txt', 'csp']) }))
    if (!out.ok) throw new Error(out.message)
    // csp (order 1) outranks security_txt, so headers come first even though
    // the gaps were listed the other way round.
    expect(out.proposal.workstreams[0]!.name).toBe('Security headers baseline')
  })

  it('attaches the finding’s own evidence to each item, and never invents any', () => {
    const out = proposalFromFindings(input())
    if (!out.ok) throw new Error(out.message)
    const csp = out.proposal.workstreams[0]!.items.find((i) => i.signalKey === 'csp')!
    expect(csp.evidence).toEqual(['csp absent', 'url: https://www.rentman.io/', 'seen: absent'])
    expect(csp.why).toBe(icp.signals['csp']!.why)
  })

  it('lists what is already in place, separately', () => {
    const out = proposalFromFindings(input())
    if (!out.ok) throw new Error(out.message)
    expect(out.proposal.alreadyInPlace.map((s) => s.signalKey)).toContain('tls')
    expect(out.proposal.alreadyInPlace.map((s) => s.signalKey)).not.toContain('csp')
  })

  /**
   * A signal the ICP has that the table does not know still produces scope —
   * an ICP is editable data, and dropping a signal the team added would be
   * wrong in the quiet way.
   */
  it('scopes a signal it has no workstream for under a generic one', () => {
    const custom = {
      ...icp,
      signals: { ...icp.signals, cookie_flags: { weight: 6, order: 99, why: 'Session cookie without Secure or HttpOnly' } },
    }
    const out = proposalFromFindings(
      input({
        icp: custom,
        findings: [
          ...findings(['csp']),
          { signalKey: 'cookie_flags', observed: true, gap: true, weight: 6, detail: null, evidence: {} },
        ],
      }),
    )
    if (!out.ok) throw new Error(out.message)
    const generic = out.proposal.workstreams.find((w) => w.name === 'Additional remediation')!
    expect(generic.items[0]).toMatchObject({ signalKey: 'cookie_flags', deliverable: 'Remediate: Session cookie without Secure or HttpOnly' })
  })
})

describe('§2.2 — what must never become scope', () => {
  /**
   * THE test. A signal the scanner could not observe is not a gap. It is
   * listed as not assessed, so the buyer can see what was NOT looked at —
   * and it is in the assumptions, in words.
   */
  it('lists an unobserved signal as not assessed, never as scope', () => {
    const out = proposalFromFindings(
      input({
        findings: findings(['csp'], [{ signalKey: 'trust_page', observed: false, gap: null, detail: null, evidence: {} }]),
      }),
    )
    if (!out.ok) throw new Error(out.message)
    const scoped = out.proposal.workstreams.flatMap((w) => w.items.map((i) => i.signalKey))
    expect(scoped).not.toContain('trust_page')
    expect(out.proposal.alreadyInPlace.map((s) => s.signalKey)).not.toContain('trust_page')
    expect(out.proposal.notAssessed.map((s) => s.signalKey)).toEqual(['trust_page'])
    expect(out.proposal.assumptions.some((a) => /not assessable from the outside/.test(a))).toBe(true)
  })

  it('treats a signal with no finding row at all as not assessed', () => {
    const out = proposalFromFindings(input({ findings: findings(['csp']).filter((f) => f.signalKey !== 'hsts') }))
    if (!out.ok) throw new Error(out.message)
    expect(out.proposal.notAssessed.map((s) => s.signalKey)).toContain('hsts')
  })

  it('refuses a stale scan, and says to re-scan', () => {
    const out = proposalFromFindings(input({ scan: { ranAt: RAN, stale: true, ok: true } }))
    expect(out).toMatchObject({ ok: false, reason: 'stale' })
    if (out.ok) return
    expect(out.message).toMatch(/Re-scan/)
    expect(out.message).toContain('2026-09-10')
  })

  it('refuses a scan that never reached the site', () => {
    const out = proposalFromFindings(input({ scan: { ranAt: RAN, stale: false, ok: false } }))
    expect(out).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('refuses when there are no findings at all', () => {
    expect(proposalFromFindings(input({ findings: [] }))).toMatchObject({ ok: false, reason: 'no_scan' })
  })

  it('refuses when nothing observed is a gap', () => {
    expect(proposalFromFindings(input({ findings: findings([]) }))).toMatchObject({ ok: false, reason: 'no_gaps' })
  })
})

describe('effort and pricing', () => {
  it('sums a workstream’s days and rounds to halves', () => {
    const out = proposalFromFindings(input({ findings: findings(['csp', 'hsts']) }))
    if (!out.ok) throw new Error(out.message)
    const headers = out.proposal.workstreams[0]!
    // csp 3 + hsts 0.5 = 3.5 low; high is ×1.6 = 5.6 → 5.5
    expect(headers.effortDays).toEqual({ low: 3.5, high: 5.5 })
  })

  it('prices from the day rate, and leaves a placeholder without one', () => {
    const priced = proposalFromFindings(input({ findings: findings(['csp']) }))
    if (!priced.ok) throw new Error(priced.message)
    expect(priced.proposal.pricing).toEqual({
      currency: 'USD',
      dayRate: 1200,
      effortDays: { low: 3, high: 5 },
      total: { low: 3600, high: 6000 },
    })
    const unpriced = proposalFromFindings(input({ findings: findings(['csp']), dayRate: null }))
    if (!unpriced.ok) throw new Error(unpriced.message)
    expect(unpriced.proposal.pricing.total).toBeNull()
  })
})

describe('what the document says about itself', () => {
  it('names the scan date and the score it was written from', () => {
    const out = proposalFromFindings(input())
    if (!out.ok) throw new Error(out.message)
    expect(out.proposal.basedOn).toEqual({ scanRanAt: RAN.toISOString(), score: 71, tier: 'A' })
    expect(out.proposal.summary).toContain('2026-09-10')
    expect(out.proposal.summary).toContain('nothing private was accessed')
  })

  it('is deterministic', () => {
    const a = proposalFromFindings(input())
    const b = proposalFromFindings(input())
    expect(a).toEqual(b)
  })

  /**
   * §2.2's copy rule: the scanner reads public pages only, and every piece of
   * copy describes it that way. A proposal is copy the buyer reads.
   */
  it('never describes the review as a test or a probe', () => {
    const out = proposalFromFindings(input())
    if (!out.ok) throw new Error(out.message)
    const text = JSON.stringify(out.proposal).toLowerCase()
    expect(text).not.toMatch(/penetration test|pentest|probed|scanned your network|vulnerability scan/)
  })
})

/**
 * A scan also records the informational signals: observed, unscored, weight
 * 0. The proposal is based on the SCORE, so none of them may become scope,
 * and none may swell the buyer-facing count — "Of 25 signals observed, 4
 * were gaps" about a review scored on twelve is a number nobody computed.
 */
describe('informational signals on the same scan', () => {
  const informational: ProposalFinding[] = [
    'csp_quality', 'cross_origin_policies', 'sri_third_party', 'stack_disclosure', 'hsts_quality',
    'csp_report_only', 'referrer_policy_quality', 'permissions_policy_quality', 'content_type_options_quality',
    'mixed_content', 'deprecated_headers', 'reporting_endpoints',
  ].map((key) => ({
    signalKey: key, observed: true, gap: true, weight: 0, detail: `${key} flagged`, evidence: { url: 'https://www.rentman.io/' }, scored: false,
  }))
  const cookie: ProposalFinding = {
    signalKey: 'cookie_flags', observed: false, gap: null, weight: 0, detail: 'not captured',
    evidence: { url: 'https://www.rentman.io/', reason: 'not recorded' }, scored: false,
  }

  it('counts the ICP’s signals in the summary, not every row on the scan', () => {
    const plain = proposalFromFindings(input())
    const mixed = proposalFromFindings(input({ findings: [...findings(['csp', 'hsts', 'security_txt']), ...informational, cookie] }))
    if (!plain.ok || !mixed.ok) throw new Error('expected both to generate')
    const icpCount = Object.keys(icp.signals).length
    expect(mixed.proposal.summary).toContain(`Of ${icpCount} signals observed, 3 were gaps`)
    expect(mixed.proposal.summary).toBe(plain.proposal.summary)
  })

  it('never turns one into scope, into "already in place" or into "not assessed"', () => {
    const out = proposalFromFindings(input({ findings: [...findings(['csp']), ...informational, cookie] }))
    if (!out.ok) throw new Error(out.message)
    const named = [
      ...out.proposal.workstreams.flatMap((w) => w.items.map((i) => i.signalKey)),
      ...out.proposal.alreadyInPlace.map((x) => x.signalKey),
      ...out.proposal.notAssessed.map((x) => x.signalKey),
    ]
    for (const f of [...informational, cookie]) expect(named, f.signalKey).not.toContain(f.signalKey)
  })

  it('refuses rather than proposing when only informational rows are gaps', () => {
    const out = proposalFromFindings(input({ findings: [...findings([]), ...informational] }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('no_gaps')
  })
})

// After an informational key is promoted into the ICP with a weight, a scan
// recorded before the promotion holds it observed but `scored = false`. The
// walk skipped the row and listed the signal under "not assessable from the
// outside" — in the buyer's document, about something the scanner saw.
describe('a scan scored under a different profile', () => {
  const promoted = parseIcpDefinition({
    ...seed,
    signals: {
      ...seed.signals,
      hsts_quality: { weight: 4, order: Object.keys(seed.signals).length + 1, why: 'HSTS max-age under 180 days' },
    },
  })
  const beforePromotion: ProposalFinding[] = [
    ...findings(['csp', 'hsts']),
    { signalKey: 'hsts_quality', observed: true, gap: true, weight: 0, detail: 'max-age=300 is under 180 days', evidence: { maxAge: 300 }, scored: false },
  ]

  it('refuses with rescore when an ICP signal was recorded unscored, rather than calling it not assessed', () => {
    const out = proposalFromFindings(input({ icp: promoted, findings: beforePromotion }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('rescore')
    expect(out.message).toContain(PROPOSAL_RESCORE_SENTENCE)
    expect(PROPOSAL_RESCORE_SENTENCE).toBe('scored under a different profile — re-scan')
  })

  it('refuses with rescore when the score names another profile', () => {
    const out = proposalFromFindings(input({ profiles: { activeProfileId: ACTIVE, scoreProfileId: EARLIER } }))
    expect(out).toMatchObject({ ok: false, reason: 'rescore' })
  })

  it('writes the proposal once the scan is scored under the active profile, or has no score to disagree', () => {
    const rescanned = beforePromotion.map((f) => (f.signalKey === 'hsts_quality' ? { ...f, weight: 4, scored: true } : f))
    const out = proposalFromFindings(input({ icp: promoted, findings: rescanned }))
    if (!out.ok) throw new Error(out.message)
    expect(out.proposal.notAssessed.map((x) => x.signalKey)).not.toContain('hsts_quality')
    expect(out.proposal.workstreams.flatMap((w) => w.items.map((i) => i.signalKey))).toContain('hsts_quality')
    expect(proposalFromFindings(input({ profiles: { activeProfileId: ACTIVE, scoreProfileId: null } })).ok).toBe(true)
  })

  it('leaves an informational row that is NOT in the active ICP alone', () => {
    // The seed ICP does not score hsts_quality, so its unscored row is context, not a mismatch.
    expect(proposalNeedsRescore({ icp, findings: beforePromotion, profiles: { activeProfileId: ACTIVE, scoreProfileId: ACTIVE } })).toBe(false)
    expect(proposalFromFindings(input({ findings: beforePromotion })).ok).toBe(true)
  })

  it('still says stale first when a scan is both stale and scored elsewhere — a re-scan fixes both', () => {
    const out = proposalFromFindings(input({
      icp: promoted, findings: beforePromotion, scan: { ranAt: RAN, stale: true, ok: true },
    }))
    expect(out).toMatchObject({ ok: false, reason: 'stale' })
  })
})
