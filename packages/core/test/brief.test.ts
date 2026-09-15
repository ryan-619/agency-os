/**
 * The meeting brief (PROMPT.md §8.6).
 *
 * Deterministic and pure, so the test worth writing is the §2.2 edge: a scan
 * that has aged out must be FLAGGED, not quoted. A brief that repeated a
 * three-week-old gap in the two minutes before a call is the exact thing
 * "must be re-verified before appearing in any outbound draft" forbids.
 */
import { describe, it, expect } from 'vitest'
import { meetingBrief, type BriefInput } from '../src/index.js'

const RAN = new Date('2026-09-10T08:00:00.000Z')
const signals = {
  csp: { why: 'No Content-Security-Policy' },
  hsts: { why: 'No Strict-Transport-Security' },
  tls: { why: 'TLS configuration' },
}

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  meeting: { startsAt: new Date('2026-09-18T14:00:00.000Z'), timeZone: 'Europe/London', title: null },
  company: { domain: 'rentman.io', name: 'Rentman', country: 'NL' },
  contacts: [{ name: 'Priya Sharma', title: 'Head of Engineering', email: 'priya@rentman.io' }],
  deal: { stage: 'meeting', nextAction: 'Prepare', valueCents: 1250000 },
  signals,
  findings: [
    { signalKey: 'csp', observed: true, gap: true, weight: 15, detail: 'absent' },
    { signalKey: 'hsts', observed: true, gap: true, weight: 10, detail: null },
    { signalKey: 'tls', observed: true, gap: false, weight: 8, detail: null },
  ],
  scan: { ranAt: RAN, stale: false, ok: true },
  score: { score: 71, tier: 'A' },
  thread: [
    { direction: 'in', status: 'replied', subject: 'Re: A gap', body: 'Thursday works.\n\n> quoted', at: new Date('2026-09-15T10:00:00.000Z') },
    { direction: 'out', status: 'sent', subject: 'A gap', body: 'Hi —\nI had a look…', at: new Date('2026-09-14T20:50:00.000Z') },
  ],
  ...over,
})

describe('a fresh scan', () => {
  it('lists the gaps heaviest first, with the ICP’s words', () => {
    const b = meetingBrief(input())
    expect(b.posture.gaps.map((g) => g.signalKey)).toEqual(['csp', 'hsts'])
    expect(b.posture.gaps[0]!.why).toBe('No Content-Security-Policy')
    expect(b.posture.strengths).toEqual(['tls'])
    expect(b.posture.caveat).toBeNull()
    expect(b.posture.summary).toContain('71/100')
  })

  it('asks the question keyed to each gap, then the money question', () => {
    const b = meetingBrief(input())
    expect(b.questions[0]).toMatch(/Content-Security-Policy/)
    expect(b.questions.at(-1)).toMatch(/signs off/)
  })

  it('summarises the thread with the first line of each message, quoted text excluded', () => {
    const b = meetingBrief(input())
    expect(b.conversation[0]).toBe('2026-09-15 — They wrote: Re: A gap — "Thursday works."')
    expect(b.conversation[1]).toMatch(/^2026-09-14 — We sent: A gap/)
  })

  it('names who is on the call and where the deal is', () => {
    const b = meetingBrief(input())
    expect(b.who).toEqual(['Priya Sharma, Head of Engineering <priya@rentman.io>'])
    expect(b.deal).toContain('Stage: meeting')
    expect(b.deal).toContain('12,500')
  })

  it('is deterministic', () => {
    expect(meetingBrief(input())).toEqual(meetingBrief(input()))
  })
})

describe('§2.2 — evidence that cannot be quoted', () => {
  it('flags a stale scan and quotes none of its findings', () => {
    const b = meetingBrief(input({ scan: { ranAt: RAN, stale: true, ok: true } }))
    expect(b.posture.gaps).toEqual([])
    expect(b.posture.strengths).toEqual([])
    expect(b.posture.caveat).toMatch(/aged out/)
    expect(b.posture.caveat).toMatch(/re-scan/i)
    expect(b.posture.summary).toBe('No current evidence.')
    // No gap-keyed questions either: they would be about findings nobody may quote.
    expect(b.questions).toHaveLength(1)
  })

  it('flags a scan that never reached the site', () => {
    const b = meetingBrief(input({ scan: { ranAt: RAN, stale: false, ok: false } }))
    expect(b.posture.gaps).toEqual([])
    expect(b.posture.caveat).toMatch(/never reached/)
  })

  it('flags a company that was never scanned', () => {
    const b = meetingBrief(input({ scan: null, findings: [], score: null }))
    expect(b.posture.caveat).toMatch(/never been scanned/)
  })

  it('never renders an unobserved finding as a gap or a strength', () => {
    const b = meetingBrief(
      input({ findings: [{ signalKey: 'csp', observed: false, gap: null, weight: 15, detail: null }] }),
    )
    expect(b.posture.gaps).toEqual([])
    expect(b.posture.strengths).toEqual([])
  })
})

describe('missing pieces', () => {
  it('copes with no deal, no contacts, no thread and no ICP', () => {
    const b = meetingBrief(input({ deal: null, contacts: [], thread: [], signals: {} }))
    expect(b.deal).toBe('No deal recorded yet.')
    expect(b.who).toEqual([])
    expect(b.conversation).toEqual([])
    // With no ICP the gap is named by its key rather than dropped.
    expect(b.posture.gaps[0]!.why).toBe('csp')
  })
})
