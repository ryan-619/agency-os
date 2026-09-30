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
  ENROL_IGNORED_REFUSALS, ENROL_SKIPS, REFUSALS_A_CORRECTION_RESOLVES, REFUSALS_THE_CLOCK_RESOLVES,
  decideSend, draftInputFromFindings, draftOpener, enrolCompanyGate, enrolIgnoredStatuses, enrolPriorScope,
  enrolPriorSkip, enrollableContact, enrolmentDraft, observedWithoutDetail, parseIcpDefinition,
  type EnrolContactFacts, type EnrolFinding, type EnrolPriorRow, type EnrolScore, type EnrolSkip, type IcpDefinition,
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
  emailBouncedAt: null,
  ...over,
})

/** Earlier rows by status; a `refused` one needs its code, as 0010 requires. */
const rows = (...statuses: string[]): EnrolPriorRow[] => statuses.map((status) => ({ status, refusalCode: null }))
const refused = (refusalCode: string): EnrolPriorRow => ({ status: 'refused', refusalCode })

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

  /**
   * The sender refuses a bounced address on sight, so a draft to one is a
   * card nobody can approve, or under auto-send a row refused at once. The
   * mark is about the ADDRESS: it does not follow the person to LinkedIn.
   */
  it('skips an email address that bounced, and only on the email channel', () => {
    const bounced = person({ emailBouncedAt: new Date(RAN) })
    expect(enrollableContact(bounced, null, 'email')).toEqual({ ok: false, why: 'bounced' })
    expect(enrollableContact(person({ emailBouncedAt: RAN.toISOString() }), null, 'email')).toEqual({
      ok: false,
      why: 'bounced',
    })
    expect(enrollableContact(bounced, null, 'linkedin')).toEqual({ ok: true })
  })

  it('reports the first reason in the send path’s order', () => {
    const everything = person({
      email: null,
      pausedAt: RAN,
      consents: [{ channel: 'email', granted: false }],
      emailBouncedAt: RAN,
      timeZone: null,
    })
    expect(enrollableContact(everything, null, 'email')).toEqual({ ok: false, why: 'no_address' })
    expect(enrollableContact({ ...everything, email: 'priya@rentman.io' }, null, 'email')).toEqual({
      ok: false,
      why: 'paused',
    })
    // A refusal outranks a bounce: it is the reason nobody may approve past.
    expect(enrollableContact({ ...everything, email: 'priya@rentman.io', pausedAt: null }, null, 'email')).toEqual({
      ok: false,
      why: 'declined',
    })
    // And a bounce outranks a missing zone.
    expect(
      enrollableContact({ ...everything, email: 'priya@rentman.io', pausedAt: null, consents: [] }, null, 'email'),
    ).toEqual({ ok: false, why: 'bounced' })
  })
})

describe('an earlier row for the same person and campaign', () => {
  it('says nothing when there is none, or only refusals a correction resolves', () => {
    expect(enrolPriorSkip([], false)).toBeNull()
    expect(enrolPriorSkip([refused('bounced'), refused('unparseable_recipient')], false)).toBeNull()
    expect(enrolPriorSkip([refused('unknown_timezone')], true)).toBeNull()
  })

  it('is already_enrolled while a draft is still waiting', () => {
    for (const s of ['queued', 'awaiting_approval', 'approved']) {
      expect(enrolPriorSkip(rows(s), false), s).toBe('already_enrolled')
      expect(enrolPriorSkip(rows(s), true), s).toBe('already_enrolled')
    }
  })

  /**
   * The skeptic's case. A contact who was SENT the opener and did not reply
   * is not paused, has no live row, and would otherwise be enrolled again —
   * the same cold opener twice, and under auto-send with nobody in the loop.
   * `sending` is the worker's claim on a row it is handing over; one left
   * there may already have been delivered.
   */
  it('is already_contacted once anything went, and that outranks a live row', () => {
    for (const s of ['sent', 'sending', 'delivered', 'replied', 'bounced']) {
      expect(enrolPriorSkip(rows(s), false), s).toBe('already_contacted')
      expect(enrolPriorSkip(rows(s), true), s).toBe('already_contacted')
    }
    expect(enrolPriorSkip(rows('awaiting_approval', 'sent'), false)).toBe('already_contacted')
  })

  it('reads a status it does not know as possibly sent', () => {
    expect(enrolPriorSkip(rows('some_future_status'), false)).toBe('already_contacted')
  })

  /**
   * `recoverStuckSends` marks a row the worker died sending as `failed` —
   * "the safe direction; the alternative is guessing the provider was not
   * reached and sending it twice". A person reading the new draft can make
   * that call; auto-send cannot.
   */
  it('lets a failed row be re-drafted for a person, never re-queued for auto-send', () => {
    expect(enrolPriorSkip(rows('failed'), false)).toBeNull()
    expect(enrolPriorSkip(rows('failed'), true)).toBe('already_contacted')
    expect(enrolIgnoredStatuses(false)).toEqual(['failed'])
    expect(enrolIgnoredStatuses(true)).toEqual([])
  })

  /**
   * The review's case. A campaign runs supervised; a person denies Jane's
   * draft (`denyDraft` writes `refused`, `needs_approval`). The campaign is
   * switched to auto-send and enrolled again — and the words a person said no
   * to used to be queued and mailed with nobody seeing them. A reply's
   * cancel (`consent_revoked`) and an opt-out (`suppressed`) are the
   * recipient's own no, and stop a new draft the same way.
   */
  it('treats a refusal somebody made as already_contacted, supervised or auto-send', () => {
    for (const code of ['needs_approval', 'consent_revoked', 'suppressed']) {
      expect(enrolPriorSkip([refused(code)], true), code).toBe('already_contacted')
      expect(enrolPriorSkip([refused(code)], false), code).toBe('already_contacted')
    }
    // A code nobody listed is read the safe way, as a no.
    expect(enrolPriorSkip([refused('some_future_code')], true)).toBe('already_contacted')
    // So is a refused row with no code, which 0010 makes unstorable anyway.
    expect(enrolPriorSkip([{ status: 'refused', refusalCode: null }], true)).toBe('already_contacted')
  })

  /**
   * The other kind of refusal: nobody said no, the record or the scan was
   * wrong — or it was the clock, which the sender defers rather than refuses,
   * so a `refused` row with a clock code is a deferral never put back.
   */
  it('lets a refusal a correction, a re-scan or the clock resolves be drafted again', () => {
    for (const code of [...REFUSALS_A_CORRECTION_RESOLVES, ...REFUSALS_THE_CLOCK_RESOLVES]) {
      expect(enrolPriorSkip([refused(code)], true), code).toBeNull()
      expect(enrolPriorSkip([refused(code)], false), code).toBeNull()
    }
    expect([...REFUSALS_A_CORRECTION_RESOLVES].sort()).toEqual(
      ['bounced', 'stale_evidence', 'unknown_timezone', 'unparseable_recipient'],
    )
    expect([...REFUSALS_THE_CLOCK_RESOLVES].sort()).toEqual(['campaign_inactive', 'daily_cap', 'quiet_hours'])
    expect([...ENROL_IGNORED_REFUSALS].sort()).toEqual(
      [...REFUSALS_A_CORRECTION_RESOLVES, ...REFUSALS_THE_CLOCK_RESOLVES].sort(),
    )
    expect(Object.isFrozen(ENROL_IGNORED_REFUSALS)).toBe(true)
  })

  /**
   * Every refusal the send path can write is classified on purpose. The codes
   * come from `decideSend` itself, driven into each one here, so a code the
   * sender can refuse with and this list has never decided about is a failing
   * test rather than a silent block. It is not `humanCanResolve`: a person
   * can approve past `needs_approval` and it still stops a new draft, because
   * it IS a person saying no; nobody can approve past `stale_evidence` and it
   * does not, because a re-scan and a new draft are the fix.
   */
  it('decides about every refusal decideSend can write', () => {
    const DECIDED: Readonly<Record<string, 'stops a new draft' | 'does not'>> = {
      cold_channel_forbidden: 'stops a new draft',
      suppressed: 'stops a new draft',
      consent_revoked: 'stops a new draft',
      no_consent: 'stops a new draft',
      needs_approval: 'stops a new draft',
      unparseable_recipient: 'does not',
      bounced: 'does not',
      stale_evidence: 'does not',
      unknown_timezone: 'does not',
      quiet_hours: 'does not',
      daily_cap: 'does not',
      campaign_inactive: 'does not',
    }
    // `evidenceStale` is the send path's newest fact; carried here so the
    // same facts reach its refusal on a tree that has it.
    const base = {
      channel: 'email' as const,
      recipient: 'priya@rentman.io',
      suppressed: false,
      recipientBounced: false,
      consent: null,
      recipientTimeZone: 'Europe/London',
      quietStart: '21:00',
      quietEnd: '08:00',
      sentToday: 0,
      dailyCap: 25,
      campaignStatus: 'active' as const,
      autoSend: false,
      evidenceStale: false,
      now: new Date('2026-09-15T12:00:00.000Z'),
    }
    const variants: (Partial<Parameters<typeof decideSend>[0]> & { readonly evidenceStale?: boolean })[] = [
      { channel: 'sms' },
      { recipient: 'not an address' },
      { suppressed: true },
      { recipientBounced: true },
      { consent: { granted: false, source: 'said no' } },
      { evidenceStale: true },
      { recipientTimeZone: null },
      { now: new Date('2026-09-15T23:00:00.000Z') },
      { sentToday: 25 },
      { campaignStatus: 'paused' },
      {},
    ]
    const seen = new Set<string>()
    for (const v of variants) {
      const d = decideSend({ ...base, ...v })
      if (d.allowed) continue
      seen.add(d.code)
      expect(DECIDED[d.code], `nobody decided about ${d.code}`).toBeDefined()
      const stops = enrolPriorSkip([refused(d.code)], true) === 'already_contacted'
      expect(stops ? 'stops a new draft' : 'does not', d.code).toBe(DECIDED[d.code])
    }
    // The variants really reached the refusals they aim at.
    expect([...seen]).toEqual(
      expect.arrayContaining([
        'cold_channel_forbidden', 'unparseable_recipient', 'suppressed', 'bounced', 'consent_revoked',
        'unknown_timezone', 'quiet_hours', 'daily_cap', 'campaign_inactive', 'needs_approval',
      ]),
    )
    for (const [code, verdict] of Object.entries(DECIDED)) {
      expect(enrolPriorSkip([refused(code)], true) === 'already_contacted' ? 'stops a new draft' : 'does not', code).toBe(
        verdict,
      )
    }
  })

  it('reads every campaign on the channel only when nobody reads the words', () => {
    expect(enrolPriorScope(true)).toBe('channel')
    expect(enrolPriorScope(false)).toBe('campaign')
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

  /**
   * §2.2, the review's case. `recordScan` stores an empty detail as NULL, and
   * three gaps the scanner stores that way are not headers at all. The rows
   * below carry the evidence `extractProfile` writes for each (the db test
   * drives the real extractor over a recorded site); each is worded from what
   * the scanner did, and "header absent" is kept for a header alone.
   */
  it('words a detail-less gap from what the scanner did, and "header absent" only for a header', () => {
    const r = build(
      findings(['trust_page', 'compliance_claim', 'security_txt', 'hsts'], [
        {
          signalKey: 'trust_page',
          detail: null,
          evidence: { probed: ['/security', '/trust', '/trust-center', '/security-and-privacy'], found: null },
        },
        {
          signalKey: 'compliance_claim',
          detail: null,
          evidence: { url: 'https://www.rentman.io/', termsFound: [], qualifyingTerms: [] },
        },
        {
          signalKey: 'security_txt',
          detail: null,
          evidence: { probed: ['/.well-known/security.txt', '/security.txt'], found: null },
        },
        { signalKey: 'hsts', detail: null },
      ]),
    )
    expect(r.evidence).toEqual([
      {
        claim: why('trust_page'),
        observed: 'no security or trust page found at /security, /trust, /trust-center or /security-and-privacy',
      },
      { claim: why('compliance_claim'), observed: 'no SOC 2 or ISO 27001 claim found on the homepage' },
      { claim: why('security_txt'), observed: 'no security.txt found at /.well-known/security.txt or /security.txt' },
      { claim: why('hsts'), observed: 'header absent on homepage response' },
    ])

    // And that is what reaches the body a stranger reads.
    const opener = draftOpener({ score: r, agencyName: 'Agency', senderName: 'Priya', maxEvidence: 6 })
    if (!opener.ok) throw new Error(opener.reason)
    expect(opener.draft.body).toContain(`• ${why('security_txt')} — no security.txt found at /.well-known/security.txt`)
    for (const line of opener.draft.body.split('\n').filter((l) => l.includes('header absent'))) {
      expect(line).toBe(`• ${why('hsts')} — header absent on homepage response`)
    }
  })

  it('names only the paths the row itself says were requested', () => {
    expect(observedWithoutDetail('trust_page', { probed: ['/security'] })).toBe('no security or trust page found at /security')
    // No list, an empty one, or anything but short absolute paths: nothing
    // on the row says where anybody looked, so nothing is said about it.
    expect(observedWithoutDetail('security_txt', {})).toBeNull()
    expect(observedWithoutDetail('trust_page', { probed: [] })).toBeNull()
    expect(observedWithoutDetail('trust_page', { probed: '/security' })).toBeNull()
    expect(observedWithoutDetail('security_txt', { probed: ['/.well-known/security.txt', 'https://x.test/'] })).toBeNull()
    expect(observedWithoutDetail('trust_page', { probed: ['/security', 42] })).toBeNull()
    // Every header signal of the seed ICP, and no other key, is a header.
    for (const key of ['csp', 'hsts', 'frame_protection', 'content_type_options', 'referrer_policy', 'permissions_policy']) {
      expect(observedWithoutDetail(key, {}), key).toBe('header absent on homepage response')
    }
    for (const key of ['server_banner', 'outdated_js', 'tls', 'cookie_flags', 'custom_check']) {
      expect(observedWithoutDetail(key, { seen: 'absent' }), key).toBeNull()
    }
  })

  /**
   * A key with no detail and no words for what the scanner did — a custom
   * ICP signal, or a path signal whose row lost its list — is not quoted:
   * `draftOpener` writes a claim beside what was observed, and a claim with
   * nothing observed beside it is an assertion nobody can check. It stays in
   * the gap list; only the quoting leaves it out.
   */
  it('leaves out, rather than invents, a gap with nothing to show for it', () => {
    const custom: IcpDefinition = {
      ...icp,
      signals: { ...icp.signals, custom_check: { weight: 20, order: 99, why: 'Custom check failed' } },
    }
    const r = build(
      findings(['csp'], [
        { signalKey: 'custom_check', observed: true, gap: true, weight: 20, detail: null, evidence: { seen: 'absent' } },
        { signalKey: 'security_txt', gap: true, weight: 12, detail: null, evidence: {} },
      ]),
      { icp: custom },
    )
    expect(r.gaps.map((g) => g.key)).toEqual(['custom_check', 'csp', 'security_txt'])
    expect(r.evidence).toEqual([{ claim: why('csp'), observed: 'csp seen missing on https://www.rentman.io/' }])
    expect(r.headlineFinding).toBe(why('csp'))
    expect(JSON.stringify(r.evidence)).not.toContain('header absent')

    // With nothing else to quote there is no opener at all.
    const bare = enrolmentDraft({
      company,
      icp: custom,
      findings: findings([], [
        { signalKey: 'custom_check', observed: true, gap: true, weight: 20, detail: null, evidence: {} },
      ]),
      scan: FRESH,
      score: QUALIFIED,
      agencyName: 'Agency',
    })
    expect(bare).toEqual({ ok: false, why: 'no_evidence' })
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
    note(enrollableContact(person({ emailBouncedAt: RAN }), null, 'email'))
    note(enrollableContact(person({ timeZone: null }), null, 'email'))
    note(enrolPriorSkip(rows('queued'), false))
    note(enrolPriorSkip(rows('sent'), false))
    const base = { company, icp, findings: findings(['csp']), scan: FRESH, score: QUALIFIED, agencyName: 'Agency' }
    note(enrolmentDraft({ ...base, scan: { ...FRESH, ok: false } }))
    note(enrolmentDraft({ ...base, scan: { ...FRESH, stale: true } }))
    note(enrolmentDraft({ ...base, score: { ...QUALIFIED, qualified: false, disqualifiedReason: 'x' } }))
    note(enrolmentDraft({ ...base, score: { ...QUALIFIED, qualified: false } }))
    note(enrolmentDraft({ ...base, findings: findings([]) }))
    expect([...seen].sort()).toEqual(ENROL_SKIPS.filter((s) => s !== 'no_contact').sort())
  })
})
