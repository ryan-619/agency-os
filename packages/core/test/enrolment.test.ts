/**
 * Enrolment's rules, pure (§8.4, under §2.1 and §2.2).
 *
 * Two halves. Who may be drafted to — the person — which must agree with the
 * approvals page and the sender, or enrolment fills a queue with messages
 * nobody can approve. And what the draft says — the company — which is
 * §2.2's ground: the words are built from stored findings rows, so the tests
 * that matter are the ones about what must never be quoted.
 *
 * `packages/db/test/enrolment.test.ts` proves the wiring against a real
 * engine, including the one reason only the database can produce
 * (`no_contact`).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ENROL_SKIPS, draftInputFromFindings, draftOpener, enrolCompanyGate, enrolIgnoredStatuses,
  enrolPriorSkip, enrollableContact, enrolmentDraft, parseIcpDefinition,
  type EnrolContactFacts, type EnrolFinding, type EnrolScore, type EnrolSkip, type IcpDefinition,
} from '../src/index.js'

const icp = parseIcpDefinition(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../db/seed/icp-security-gap-saas.json', import.meta.url)), 'utf8')),
)
const RAN = new Date('2026-09-10T08:00:00.000Z')
const why = (key: string): string => icp.signals[key]!.why

const person = (over: Partial<EnrolContactFacts> = {}): EnrolContactFacts => ({
  email: 'priya@rentman.io',
  linkedinUrl: 'https://www.linkedin.com/in/priya-rentman',
  timeZone: 'Europe/London',
  pausedAt: null,
  consents: [],
  ...over,
})

/** Every ICP signal observed; the listed ones are gaps, the rest in place. */
function findings(gaps: string[], over: Partial<EnrolFinding>[] = []): EnrolFinding[] {
  const base: EnrolFinding[] = Object.entries(icp.signals).map(([key, s]) => ({
    signalKey: key,
    observed: true,
    gap: gaps.includes(key),
    weight: gaps.includes(key) ? s.weight : 0,
    detail: gaps.includes(key) ? `${key} seen missing on https://www.rentman.io/` : null,
    evidence: { seen: gaps.includes(key) ? 'absent' : 'present' },
    scored: true,
  }))
  for (const o of over) {
    const i = base.findIndex((f) => f.signalKey === o.signalKey)
    if (i >= 0) base[i] = { ...base[i]!, ...o }
    else base.push({ observed: true, gap: null, weight: 0, detail: null, evidence: {}, scored: true, signalKey: '?', ...o })
  }
  return base
}

const QUALIFIED: EnrolScore = { score: 83, tier: 'A — call first', qualified: true, disqualifiedReason: null }
const FRESH = { ranAt: RAN, ok: true, stale: false }

const company = { domain: 'rentman.io', name: 'Rentman' }

describe('who can be drafted to', () => {
  it('lets a person with an address, a zone and no refusal through', () => {
    expect(enrollableContact(person(), null, 'email')).toEqual({ ok: true })
    expect(enrollableContact(person(), null, 'linkedin')).toEqual({ ok: true })
  })

  it('skips a person with no address on the channel', () => {
    expect(enrollableContact(person({ email: null }), null, 'email')).toEqual({ ok: false, why: 'no_address' })
    expect(enrollableContact(person({ email: '   ' }), null, 'email')).toEqual({ ok: false, why: 'no_address' })
    expect(enrollableContact(person({ linkedinUrl: null }), null, 'linkedin')).toEqual({ ok: false, why: 'no_address' })
    // An email address does not make somebody reachable on LinkedIn.
    expect(enrollableContact(person({ linkedinUrl: null }), null, 'email')).toEqual({ ok: true })
  })

  /**
   * The sender refuses an address it cannot normalise, because no suppression
   * row could ever have matched it. A draft to one is a draft nobody can
   * approve, so it is not written.
   */
  it('treats an address the send path cannot read as no address', () => {
    expect(enrollableContact(person({ email: 'priya at rentman' }), null, 'email')).toEqual({ ok: false, why: 'no_address' })
    // A bare handle is refused by normaliseLinkedIn rather than guessed at.
    expect(enrollableContact(person({ linkedinUrl: 'priya-rentman' }), null, 'linkedin')).toEqual({
      ok: false,
      why: 'no_address',
    })
  })

  it('skips a paused person — they replied, and a follow-up reads as nobody reading it', () => {
    expect(enrollableContact(person({ pausedAt: new Date(RAN) }), null, 'email')).toEqual({ ok: false, why: 'paused' })
  })

  it('skips a person who declined THIS channel, and only this one', () => {
    expect(
      enrollableContact(person({ consents: [{ channel: 'email', granted: false }] }), null, 'email'),
    ).toEqual({ ok: false, why: 'declined' })
    expect(
      enrollableContact(person({ consents: [{ channel: 'sms', granted: false }] }), null, 'email'),
    ).toEqual({ ok: true })
  })

  /** §2.1: absence of a consent row is not a refusal on a cold channel. */
  it('does not treat no consent row as a refusal', () => {
    expect(enrollableContact(person({ consents: [] }), null, 'email')).toEqual({ ok: true })
    expect(
      enrollableContact(person({ consents: [{ channel: 'email', granted: true }] }), null, 'email'),
    ).toEqual({ ok: true })
  })

  it('skips a person with no zone, and falls back to the company’s as the sender does', () => {
    expect(enrollableContact(person({ timeZone: null }), null, 'email')).toEqual({ ok: false, why: 'no_timezone' })
    expect(enrollableContact(person({ timeZone: null }), 'Europe/Amsterdam', 'email')).toEqual({ ok: true })
  })

  it('reports the first reason in the approvals page’s order', () => {
    const everything = person({
      email: null,
      pausedAt: RAN,
      consents: [{ channel: 'email', granted: false }],
      timeZone: null,
    })
    expect(enrollableContact(everything, null, 'email')).toEqual({ ok: false, why: 'no_address' })
    expect(enrollableContact({ ...everything, email: 'priya@rentman.io' }, null, 'email')).toEqual({
      ok: false,
      why: 'paused',
    })
  })
})

describe('an earlier row for the same person and campaign', () => {
  it('says nothing when there is none, or only refusals', () => {
    expect(enrolPriorSkip([], false)).toBeNull()
    expect(enrolPriorSkip(['refused', 'refused'], false)).toBeNull()
    expect(enrolPriorSkip(['refused'], true)).toBeNull()
  })

  it('is already_enrolled while a message is still on its way', () => {
    for (const s of ['queued', 'awaiting_approval', 'approved', 'sending']) {
      expect(enrolPriorSkip([s], false), s).toBe('already_enrolled')
    }
  })

  /**
   * The skeptic's case. A contact who was SENT the opener and did not reply
   * is not paused, has no live row, and would otherwise be enrolled again —
   * the same cold opener twice, and under auto-send with nobody in the loop.
   */
  it('is already_contacted once anything went, and that outranks a live row', () => {
    for (const s of ['sent', 'delivered', 'replied', 'bounced']) {
      expect(enrolPriorSkip([s], false), s).toBe('already_contacted')
      expect(enrolPriorSkip([s], true), s).toBe('already_contacted')
    }
    expect(enrolPriorSkip(['awaiting_approval', 'sent'], false)).toBe('already_contacted')
  })

  it('reads a status it does not know as possibly sent', () => {
    expect(enrolPriorSkip(['some_future_status'], false)).toBe('already_contacted')
  })

  /**
   * `recoverStuckSends` marks a row the worker died sending as `failed` —
   * "the safe direction; the alternative is guessing the provider was not
   * reached and sending it twice". A person reading the new draft can make
   * that call; auto-send cannot.
   */
  it('lets a failed row be re-drafted for a person, never re-queued for auto-send', () => {
    expect(enrolPriorSkip(['failed'], false)).toBeNull()
    expect(enrolPriorSkip(['failed'], true)).toBe('already_contacted')
    expect(enrolIgnoredStatuses(false)).toEqual(['refused', 'failed'])
    expect(enrolIgnoredStatuses(true)).toEqual(['refused'])
  })
})

describe('the company half', () => {
  it('refuses in draftOpener’s order, with qualification before evidence', () => {
    expect(enrolCompanyGate(null, QUALIFIED)).toBe('stale')
    expect(enrolCompanyGate({ ok: false, stale: true }, QUALIFIED)).toBe('unreachable')
    expect(enrolCompanyGate({ ok: true, stale: true }, QUALIFIED)).toBe('stale')
    expect(
      enrolCompanyGate({ ok: true, stale: false }, { ...QUALIFIED, qualified: false, disqualifiedReason: 'Sells security' }),
    ).toBe('disqualified')
    expect(enrolCompanyGate({ ok: true, stale: false }, { ...QUALIFIED, qualified: false })).toBe('not_qualified')
    expect(enrolCompanyGate({ ok: true, stale: false }, null)).toBe('not_qualified')
    expect(enrolCompanyGate({ ok: true, stale: false }, QUALIFIED)).toBeNull()
  })

  const draft = (over: Partial<Parameters<typeof enrolmentDraft>[0]> = {}) =>
    enrolmentDraft({
      company,
      icp,
      findings: findings(['csp', 'hsts']),
      scan: FRESH,
      score: QUALIFIED,
      agencyName: 'Agency',
      senderName: 'Priya',
      ...over,
    })

  it('writes one draft from a fresh, reachable, qualifying scan', () => {
    const r = draft()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.quoted).toEqual([why('csp'), why('hsts')])
    expect(r.draft.subject).toContain('Rentman')
    expect(r.draft.body).toContain('Agency')
  })

  it('skips each company-side reason by name', () => {
    expect(draft({ scan: null })).toEqual({ ok: false, why: 'stale' })
    expect(draft({ scan: { ...FRESH, ok: false, error: 'timeout' } })).toEqual({ ok: false, why: 'unreachable' })
    expect(draft({ scan: { ...FRESH, stale: true } })).toEqual({ ok: false, why: 'stale' })
    expect(draft({ score: { ...QUALIFIED, qualified: false, disqualifiedReason: 'Sells security' } })).toEqual({
      ok: false,
      why: 'disqualified',
    })
    expect(draft({ score: { ...QUALIFIED, qualified: false } })).toEqual({ ok: false, why: 'not_qualified' })
    // Observed, fresh, qualified — and every observed signal was fine.
    expect(draft({ findings: findings([]) })).toEqual({ ok: false, why: 'no_evidence' })
  })

  /**
   * Only the gaps the scanner SAW count. A qualifying score whose gaps were
   * all unobserved has nothing to say, and says nothing.
   */
  it('has no evidence when the only gaps were not observed', () => {
    const r = draft({
      findings: findings([], [
        { signalKey: 'csp', observed: false, gap: null, weight: 0, detail: null },
        { signalKey: 'trust_page', observed: false, gap: null, weight: 0, detail: null },
      ]),
    })
    expect(r).toEqual({ ok: false, why: 'no_evidence' })
  })
})

describe('the draft input built from rows', () => {
  const build = (rows: EnrolFinding[], over: { icp?: IcpDefinition } = {}) =>
    draftInputFromFindings({ company, icp: over.icp ?? icp, findings: rows, scan: FRESH, score: QUALIFIED })

  it('quotes observed gaps only, heaviest first, ties in the ICP’s order, at most six', () => {
    // Weights: trust_page 14, compliance_claim 12, security_txt 12, hsts 10,
    // outdated_js 10, frame_protection 8, tls 8, permissions_policy 3.
    const r = build(
      findings([
        'permissions_policy', 'tls', 'frame_protection', 'outdated_js', 'hsts', 'security_txt', 'compliance_claim', 'trust_page',
      ]),
    )
    expect(r.evidence.map((e) => e.claim)).toEqual([
      why('trust_page'),
      why('compliance_claim'),
      why('security_txt'),
      why('hsts'),
      why('outdated_js'),
      why('frame_protection'),
    ])
    expect(r.evidence).toHaveLength(6)
    // The full gap list is kept, in the same order, for anyone who reads it.
    expect(r.gaps.map((g) => g.key)).toEqual([
      'trust_page', 'compliance_claim', 'security_txt', 'hsts', 'outdated_js', 'frame_protection', 'tls', 'permissions_policy',
    ])
  })

  /**
   * jsonb sorts object keys by length, then bytewise — so the ICP read back
   * from the row walks differently from the file. The order must come from
   * `order`, not from the object.
   */
  it('orders ties the same whichever way the ICP object iterates', () => {
    const reversed = { ...icp, signals: Object.fromEntries(Object.entries(icp.signals).reverse()) }
    const rows = findings(['security_txt', 'compliance_claim', 'tls', 'frame_protection'])
    expect(build(rows, { icp: reversed }).evidence).toEqual(build(rows).evidence)
    expect(build(rows).evidence.map((e) => e.claim)).toEqual([
      why('compliance_claim'),
      why('security_txt'),
      why('frame_protection'),
      why('tls'),
    ])
  })

  it('never quotes an unobserved signal, an informational row, or a key the ICP does not name', () => {
    const r = build(
      findings(['csp'], [
        { signalKey: 'trust_page', observed: false, gap: null, weight: 0, detail: 'timed out' },
        // Informational (0018): observed, recorded, NOT scored — and a "gap"
        // on it would still not be one anybody can claim.
        { signalKey: 'hsts', gap: true, weight: 0, detail: 'max-age too short', scored: false },
        { signalKey: 'cookie_flags', gap: true, weight: 0, detail: 'Secure missing', scored: true },
      ]),
    )
    expect(r.evidence.map((e) => e.claim)).toEqual([why('csp')])
    const text = JSON.stringify(r)
    expect(text).not.toContain(why('trust_page'))
    expect(text).not.toContain('timed out')
    expect(text).not.toContain('max-age too short')
    expect(text).not.toContain('Secure missing')
  })

  it('pairs each claim with what was observed, and says so when a header was simply absent', () => {
    const r = build(findings(['csp', 'hsts'], [{ signalKey: 'hsts', detail: null }]))
    expect(r.evidence).toEqual([
      { claim: why('csp'), observed: 'csp seen missing on https://www.rentman.io/' },
      { claim: why('hsts'), observed: 'header absent on homepage response' },
    ])
    expect(r.headlineFinding).toBe(why('csp'))
  })

  it('leaves the angle empty — it is internal sales guidance', () => {
    expect(build(findings(['csp', 'trust_page', 'compliance_claim'])).angle).toBe('')
  })

  it('carries reachability and the fetch error from the scan', () => {
    const r = draftInputFromFindings({
      company,
      icp,
      findings: [],
      scan: { ...FRESH, ok: false, error: 'ECONNRESET' },
      score: null,
    })
    expect(r.reachable).toBe(false)
    expect(r.fetchError).toBe('ECONNRESET')
    expect(r.qualified).toBe(false)
    expect(r.company).toBe('Rentman')
    expect(draftInputFromFindings({ company: { domain: 'x.io', name: null }, icp, findings: [], scan: FRESH, score: null }).company).toBe('x.io')
  })

  /**
   * The ICP's own outreach rule: "Never send a numeric score." The input
   * carries one (83, from the row), so this proves the draft never reaches
   * for it — driven through the real `draftOpener`, not a copy of its rules.
   */
  it('round-trips through draftOpener with no score, no angle, and no unobserved claim in the body', () => {
    const rows = findings(['csp', 'hsts', 'security_txt'], [
      { signalKey: 'trust_page', observed: false, gap: null, weight: 0, detail: null },
    ])
    const input = draftInputFromFindings({ company, icp, findings: rows, scan: FRESH, score: QUALIFIED })
    const r = draftOpener({ score: input, agencyName: 'Agency', senderName: 'Priya' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.body).not.toMatch(/\b83\b/)
    expect(r.draft.body).not.toMatch(/score|tier/i)
    expect(r.draft.subject).not.toMatch(/\b83\b/)
    expect(r.draft.body).not.toContain(why('trust_page'))
    expect(r.draft.body).toContain(why('csp'))
    expect(r.draft.body).toContain('csp seen missing on https://www.rentman.io/')
    expect(r.draft.body).toMatch(/public pages/)
  })
})

describe('the skip vocabulary', () => {
  /**
   * Every reason in the list is one this suite produces, so the list cannot
   * carry a name the code never uses — except `no_contact`, which only the
   * database can observe, and which its test drives.
   */
  it('names exactly the reasons the rules produce', () => {
    const seen = new Set<EnrolSkip>()
    const note = (r: { ok: boolean; why?: EnrolSkip } | EnrolSkip | null) => {
      if (typeof r === 'string') seen.add(r)
      else if (r && !r.ok && r.why) seen.add(r.why)
    }
    note(enrollableContact(person({ email: null }), null, 'email'))
    note(enrollableContact(person({ pausedAt: RAN }), null, 'email'))
    note(enrollableContact(person({ consents: [{ channel: 'email', granted: false }] }), null, 'email'))
    note(enrollableContact(person({ timeZone: null }), null, 'email'))
    note(enrolPriorSkip(['queued'], false))
    note(enrolPriorSkip(['sent'], false))
    const base = { company, icp, findings: findings(['csp']), scan: FRESH, score: QUALIFIED, agencyName: 'Agency' }
    note(enrolmentDraft({ ...base, scan: { ...FRESH, ok: false } }))
    note(enrolmentDraft({ ...base, scan: { ...FRESH, stale: true } }))
    note(enrolmentDraft({ ...base, score: { ...QUALIFIED, qualified: false, disqualifiedReason: 'x' } }))
    note(enrolmentDraft({ ...base, score: { ...QUALIFIED, qualified: false } }))
    note(enrolmentDraft({ ...base, findings: findings([]) }))
    expect([...seen].sort()).toEqual(ENROL_SKIPS.filter((s) => s !== 'no_contact').sort())
  })
})
