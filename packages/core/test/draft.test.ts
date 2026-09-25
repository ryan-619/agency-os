/**
 * The opener a scan earns (§5.5's `draft_outreach`, §8.4), and §2.2's grip
 * on it.
 *
 * An outreach email is the one artefact a stranger reads, so a finding
 * nobody observed inside one is a false statement about their company made
 * in writing. Most of what follows is about REFUSING to write one.
 */
import { describe, it, expect } from 'vitest'
import { draftOpener } from '../src/draft.js'
import type { ScoreResult } from '../src/scoring.js'

const score = (over: Partial<ScoreResult> = {}): ScoreResult =>
  ({
    domain: 'rentman.io',
    company: 'Rentman',
    title: 'Rentman — rental software',
    score: 77,
    tier: 'A',
    qualified: true,
    disqualified: '',
    gaps: [],
    strengths: [],
    headlineFinding: 'No Content-Security-Policy on the login page; no public trust page',
    angle: 'Worth a look before your next customer security questionnaire.',
    evidence: [
      { claim: 'No Content-Security-Policy', observed: 'no CSP header on https://rentman.io/login' },
      { claim: 'No /security or /trust page', observed: '404 on /security, /trust and /security.txt' },
      { claim: 'No public SOC 2 or ISO 27001 claim', observed: 'neither term appears on the site' },
    ],
    reachable: true,
    fetchError: '',
    ...over,
  }) as ScoreResult

describe('drafting an opener', () => {
  it('quotes the observation beside the claim, so the reader can check it', () => {
    const r = draftOpener({ score: score(), agencyName: 'Agency', senderName: 'Priya' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.body).toContain('no CSP header on https://rentman.io/login')
    expect(r.draft.body).toContain('No Content-Security-Policy')
    expect(r.draft.body).toContain('Priya')
    expect(r.draft.subject).toContain('Rentman')
    // What was quoted is returned explicitly, so a reviewer does not have to
    // parse the body to see what the email asserts.
    expect(r.draft.quoted).toHaveLength(3)
  })

  /**
   * THE §2.2 case. A site that would not answer has told us nothing, and an
   * email written anyway would state findings about a company nobody
   * observed. The refusal names the fix.
   */
  it('refuses outright when the scan could not reach the site', () => {
    const r = draftOpener({
      score: score({ reachable: false, fetchError: 'timeout' }),
      agencyName: 'Agency',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.why).toBe('unreachable')
    expect(r.reason).toMatch(/could not reach/i)
    expect(r.reason).toMatch(/re-scan/i)
  })

  /** Freshness needs the scan's ran_at, so the caller decides and passes it. */
  it('refuses on stale evidence', () => {
    const r = draftOpener({ score: score(), agencyName: 'Agency', stale: true })
    expect(r.ok === false && r.why).toBe('stale')
  })

  /**
   * An opener with no evidence in it is a cold pitch, which is the thing
   * this product exists not to send.
   */
  it('refuses when nothing quotable was observed', () => {
    const r = draftOpener({ score: score({ evidence: [] }), agencyName: 'Agency' })
    expect(r.ok === false && r.why).toBe('no_evidence')
    expect(r.ok === false && r.reason).toMatch(/cold pitch/i)
  })

  it('refuses for a disqualified company', () => {
    const r = draftOpener({ score: score({ disqualified: 'no login surface' }), agencyName: 'Agency' })
    expect(r.ok === false && r.why).toBe('disqualified')
  })

  /** Three lines reads as a note; ten reads as a report nobody asked for. */
  it('quotes a bounded number of lines', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ claim: `claim ${i}`, observed: `saw ${i}` }))
    const r = draftOpener({ score: score({ evidence: many }), agencyName: 'Agency' })
    expect(r.ok && r.draft.quoted).toHaveLength(3)
    const two = draftOpener({ score: score({ evidence: many }), agencyName: 'Agency', maxEvidence: 2 })
    expect(two.ok && two.draft.quoted).toHaveLength(2)
  })

  /**
   * The copy has to describe what the scanner actually does. §2.2's last
   * clause: every piece of copy must call it posture review from the
   * outside, not a security test.
   */
  it('describes itself as looking at public pages, never as testing', () => {
    const r = draftOpener({ score: score(), agencyName: 'Agency' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.body).toMatch(/public pages/i)
    expect(r.draft.body).toMatch(/no testing/i)
    expect(r.draft.body).not.toMatch(/\b(pen ?test|exploit|vulnerabilit|we scanned your)\b/i)
  })

  it('invites a correction, because the scan can be wrong', () => {
    const r = draftOpener({ score: score(), agencyName: 'Agency' })
    expect(r.ok && r.draft.body).toMatch(/already handled or looks wrong/i)
  })
})
