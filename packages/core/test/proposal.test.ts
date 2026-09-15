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
import { parseIcpDefinition, proposalFromFindings, type ProposalFinding, type ProposalInput } from '../src/index.js'

const icp = parseIcpDefinition(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../db/seed/icp-security-gap-saas.json', import.meta.url)), 'utf8')),
)
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
