/**
 * /approvals' words, choices and keys, without a database.
 *
 * Three things this pins. Every refusal the send path can produce reaches
 * the approver in the words every other screen uses. A rule nobody may
 * approve past disables Approve, and nothing else does — the send path
 * re-checks everything at sending, so blocking a resolvable refusal here
 * would be a second opinion about §2.1. And approving from the keyboard is
 * never one keypress: `a` arms, Enter on the same card approves, anything
 * else disarms (§2.4 — a stray key must never be an outbound message).
 */
import type { SendRefusalCode } from '@agency/core'
import { describe, expect, it } from 'vitest'
import {
  ANSWER_EVIDENCE_NOTE, APPROVE_DOES_NOT_SEND, DEFERRED_CODES, EVIDENCE_LINES_SHOWN, MISSING_EVIDENCE_NOTE,
  NO_WORKER_FOOTNOTE, OTHER_CAMPAIGN_NOTE, STALE_EVIDENCE_NOTE,
  addressedByLabel, addressedByOf, approvability, approveBlock, approveFootnote, campaignToCheck, candidateLine,
  checkedUnderLabel, decisionView, draftEvidenceFrom, draftTitle, evidenceHeading, evidenceLine, evidenceNote, keyAction,
  nextFocus, smsCandidates, templateLine, uncheckedDecision,
  type Approvability, type CandidateDecision, type DraftTemplate,
} from '../src/lib/approval-view'

/**
 * Every code `decideSend` can return, with the `humanCanResolve` it returns
 * it with — listed literally and checked against the type with `satisfies`,
 * so a code added to `SendRefusalCode` fails this file's typecheck until it
 * is added here (the same instrument `refusal-words.test.ts` uses).
 */
const SEND_CODES = {
  unparseable_recipient: true,
  suppressed: false,
  bounced: true,
  cold_channel_forbidden: false,
  no_consent: false,
  consent_revoked: false,
  paused: false,
  quiet_hours: true,
  unknown_timezone: true,
  daily_cap: true,
  campaign_inactive: true,
  needs_approval: true,
  stale_evidence: false,
  no_template: false,
  template_mismatch: false,
} satisfies Record<SendRefusalCode, boolean>

const refusal = (code: string, humanCanResolve: boolean): CandidateDecision =>
  decisionView({ allowed: false, code, reason: `the rule for ${code}.`, humanCanResolve })

describe('the per-candidate decision', () => {
  it.each(Object.entries(SEND_CODES))('%s has words, and they are not the code', (code, resolvable) => {
    const view = refusal(code, resolvable)
    expect(view.code).toBe(code)
    expect(view.words.trim().length).toBeGreaterThan(0)
    expect(view.words).not.toBe(code)
    expect(view.words).not.toMatch(/_/)
    expect(view.humanCanResolve).toBe(resolvable)
    expect(view.reason).toBe(`the rule for ${code}.`)
  })

  it('keeps send_now distinct from every refusal', () => {
    const view = decisionView({ allowed: true, code: 'send_now' })
    expect(view).toEqual({ code: 'send_now', words: 'nothing stops it right now', humanCanResolve: true, reason: null })
    expect(candidateLine(view)).toBe('nothing stops it right now')
  })

  it('renders a null decision as "no campaign chosen yet"', () => {
    expect(candidateLine(null)).toContain('no campaign chosen yet')
    expect(approveBlock(null)).toBeNull()
  })

  it('says nobody may approve past exactly the rules decideSend says no human can resolve', () => {
    for (const [code, resolvable] of Object.entries(SEND_CODES)) {
      const line = candidateLine(refusal(code, resolvable))
      expect(line.startsWith(refusal(code, resolvable).words)).toBe(true)
      expect(line.includes('nobody may approve past this')).toBe(!resolvable)
    }
  })

  it('says the worker HOLDS a message refused only by the clock, the cap or the campaign', () => {
    expect([...DEFERRED_CODES].sort()).toEqual(['campaign_inactive', 'daily_cap', 'quiet_hours'])
    for (const code of DEFERRED_CODES) expect(candidateLine(refusal(code, true))).toContain('hold it')
    expect(candidateLine(refusal('unknown_timezone', true))).toContain('the worker will refuse it')
    expect(candidateLine(refusal('unparseable_recipient', true))).toContain('the worker will refuse it')
  })

  it('names a code the send path has not got yet in readable words', () => {
    expect(candidateLine(refusal('bounced', true))).toBe('address bounced — fix this first, or the worker will refuse it')
    expect(candidateLine(refusal('some_new_rule', false))).toBe('some new rule — nobody may approve past this')
  })

  it('treats a preview that could not run as resolvable, never as a block', () => {
    const d = uncheckedDecision('That campaign or contact no longer exists. Nothing was sent.')
    expect(d.humanCanResolve).toBe(true)
    expect(approveBlock(d)).toBeNull()
    expect(candidateLine(d)).toContain('the worker checks again at sending')
  })
})

describe('approveBlock', () => {
  it('blocks Approve for every rule nobody may approve past, and says why', () => {
    for (const [code, resolvable] of Object.entries(SEND_CODES)) {
      const block = approveBlock(refusal(code, resolvable))
      if (resolvable) {
        expect(block).toBeNull()
      } else {
        expect(block).toContain('Approving is pointless')
        expect(block).toContain(refusal(code, resolvable).words)
        // Another person at the company gets the same aged words, so stale
        // evidence names its own fix instead.
        expect(block).toContain(
          code === 'stale_evidence'
            ? 're-scan the company, then draft it again'
            : code === 'no_template' || code === 'template_mismatch'
              ? 'draft it again from an active registered template'
              : 'choose someone else',
        )
      }
    }
  })

  it('names the fix for stale evidence — a re-scan and a new draft — never another person', () => {
    const block = approveBlock(refusal('stale_evidence', false))
    expect(block).toBe(
      'Approving is pointless: the evidence it quotes is stale — the scan it was written from is past its ' +
        're-verification deadline, and nobody may approve past that. Deny it, re-scan the company, then draft it again.',
    )
    expect(candidateLine(refusal('stale_evidence', false))).toBe('the evidence it quotes is stale — nobody may approve past this')
  })

  /**
   * A pause is lifted by a person, after which the same draft can simply be
   * approved — and a denial is a person's no, which stops enrolment drafting
   * them again. So the block does not tell anyone to deny it.
   */
  it('says a paused contact waits for the pause to be lifted, and does not say to deny', () => {
    const block = approveBlock(refusal('paused', false))
    expect(block).toBe(
      'Approving is pointless: contact paused, and nobody may approve past a pause — the worker would refuse it. ' +
        'The rule below says what lifts it; the draft can wait here until then, or choose someone else.',
    )
    expect(block).not.toMatch(/deny/i)
    expect(candidateLine(refusal('paused', false))).toBe('contact paused — nobody may approve past this')
  })

  /** 0019: the words are what the operator scrubs, so "choose someone else" fixes nothing. */
  it('names the fix for a template refusal — a new draft from a registered template — never another person', () => {
    for (const code of ['no_template', 'template_mismatch']) {
      const block = approveBlock(refusal(code, false))
      expect(block).toMatch(/^Approving is pointless: .* — the operator would not deliver it/)
      expect(block).toContain('Deny it, then draft it again from an active registered template.')
      expect(block).not.toContain('choose someone else')
    }
  })

  it('leaves Approve enabled when nothing stops the message', () => {
    expect(approveBlock(decisionView({ allowed: true, code: 'send_now' }))).toBeNull()
  })
})

describe('campaignToCheck', () => {
  const campaigns = [
    { id: 'c-li', name: 'LinkedIn Q3', channel: 'linkedin', status: 'active' },
    { id: 'c-paused', name: 'Old email', channel: 'email', status: 'paused' },
    { id: 'c-live', name: 'Email Q3', channel: 'email', status: 'active' },
  ]

  it("uses the draft's own campaign when it carries one, even a paused one", () => {
    expect(campaignToCheck({ channel: 'email', campaignId: 'c-paused' }, campaigns)).toEqual({
      id: 'c-paused', name: 'Old email', own: true,
    })
  })

  it('otherwise uses the first ACTIVE campaign on its channel, and says it is not the draft\'s own', () => {
    expect(campaignToCheck({ channel: 'email', campaignId: null }, campaigns)).toEqual({
      id: 'c-live', name: 'Email Q3', own: false,
    })
  })

  it('falls back to the first on the channel when none is active', () => {
    const paused = campaigns.map((c) => ({ ...c, status: 'paused' }))
    expect(campaignToCheck({ channel: 'email', campaignId: null }, paused)?.id).toBe('c-paused')
  })

  it('never crosses channels, and is null when the channel has no campaign', () => {
    expect(campaignToCheck({ channel: 'sms', campaignId: null }, campaigns)).toBeNull()
    expect(campaignToCheck({ channel: 'linkedin', campaignId: null }, campaigns)?.id).toBe('c-li')
  })

  it('does not trust a campaign id that is no longer listed', () => {
    expect(campaignToCheck({ channel: 'email', campaignId: 'gone' }, campaigns)).toEqual({
      id: 'c-live', name: 'Email Q3', own: false,
    })
  })

  it('labels which campaign the check ran under', () => {
    expect(checkedUnderLabel({ id: 'x', name: 'Email Q3', own: true }, 'email')).toContain("this draft's campaign, Email Q3")
    expect(checkedUnderLabel({ id: 'x', name: 'Email Q3', own: false }, 'email')).toContain('the first email campaign')
    expect(checkedUnderLabel(null, 'sms')).toContain('no sms campaign')
    // Choosing another campaign cannot change a block; it can change the clock.
    expect(OTHER_CAMPAIGN_NOTE).toContain('Suppression and consent are the same')
  })
})

describe('who addressed the draft', () => {
  it('an answer from the inbox names the reply it answers', () => {
    expect(addressedByOf({ contactId: 'p', campaignId: 'c', answersTouchId: 'r' })).toBe('inbox')
  })

  it('a pre-addressed row with no reply behind it came from enrolment', () => {
    expect(addressedByOf({ contactId: 'p', campaignId: 'c', answersTouchId: null })).toBe('enrolment')
  })

  it("the agent's draft is addressed to nobody", () => {
    expect(addressedByOf({ contactId: null, campaignId: null, answersTouchId: null })).toBeNull()
    expect(addressedByOf({ contactId: 'p', campaignId: null, answersTouchId: null })).toBeNull()
  })

  it('says the choice is a suggestion', () => {
    expect(addressedByLabel('enrolment')).toBe('Addressed by enrolment — change if wrong.')
    expect(addressedByLabel('inbox')).toBe('Addressed by the inbox — change if wrong.')
    expect(addressedByLabel(null)).toBeNull()
  })
})

describe('the evidence', () => {
  const asOf = '2026-09-12T09:30:00.000Z'

  /**
   * It used to end "re-scan, then approve". Since the send path refuses
   * stale evidence, judged by the scan current when the draft was WRITTEN,
   * a re-scan freshens the company and never this draft — so the sentence
   * says to draft it again, and never to approve.
   */
  it('leads a stale card with the §2.2 sentence and the scan date, and never says to approve', () => {
    expect(STALE_EVIDENCE_NOTE).toBe(
      'This draft is about a company whose findings are stale; §2.2 says re-verify before anything outbound — ' +
        're-scan, then draft it again. The send path refuses a draft written from a stale scan, and approving does not change that.',
    )
    expect(STALE_EVIDENCE_NOTE).not.toMatch(/then approve/)
    const note = evidenceNote({ asOf, stale: true, lines: [] }, true)
    expect(note?.tone).toBe('warn')
    expect(note?.text.startsWith(STALE_EVIDENCE_NOTE)).toBe(true)
    expect(note?.text).toContain('12 Sep 2026')
  })

  it('warns when no successful scan had run when the draft was written', () => {
    expect(evidenceNote(null, true)).toEqual({ tone: 'warn', text: MISSING_EVIDENCE_NOTE })
    expect(MISSING_EVIDENCE_NOTE).toContain('§2.2')
  })

  it('says nothing when the evidence is fresh and there is some', () => {
    expect(evidenceNote({ asOf, stale: false, lines: ['a: b'] }, true)).toBeNull()
  })

  it('says plainly when a fresh scan observed no gaps', () => {
    const note = evidenceNote({ asOf, stale: false, lines: [] }, true)
    expect(note?.tone).toBe('plain')
    expect(note?.text).toContain('observed no gaps')
  })

  it('does not call a draft about no company stale or missing', () => {
    expect(evidenceNote(null, false)?.tone).toBe('plain')
  })

  it('dates the heading', () => {
    expect(evidenceHeading({ asOf, stale: false, lines: ['x'] })).toContain('observed 12 Sep 2026')
  })

  /**
   * The panel describes the scan the DECISION judges. It used to be the
   * company's latest scan for every card, so an answer about a stale company
   * read "the send path refuses" beside an enabled Approve, and a re-scanned
   * company's card listed the new scan's lines under words written from the
   * old one. Found by review.
   */
  describe('per draft, as the sender judges its words', () => {
    const scanA = { id: 'a', ranAt: new Date('2026-09-01T09:00:00.000Z'), stale: false }
    const scanB = { id: 'b', ranAt: new Date('2026-09-20T09:00:00.000Z'), stale: false }
    const lines = ['No Content-Security-Policy: header absent']

    it('lists the lines when the scan the words were written from is the latest, and fresh', () => {
      const e = draftEvidenceFrom({ answersReply: false, writtenFrom: scanB, latest: scanB, latestLines: lines })
      expect(e).toEqual({ asOf: scanB.ranAt.toISOString(), stale: false, lines, newer: null })
      expect(evidenceNote(e, true)).toBeNull()
    })

    it('never lists a newer scan\'s lines under words written from an older one', () => {
      const e = draftEvidenceFrom({ answersReply: false, writtenFrom: scanA, latest: scanB, latestLines: lines })
      expect(e?.asOf).toBe(scanA.ranAt.toISOString())
      expect(e?.lines).toEqual([])
      expect(e?.newer).toEqual({ asOf: scanB.ranAt.toISOString(), stale: false })
      const note = evidenceNote(e, true)
      expect(note?.tone).toBe('plain')
      expect(note?.text).toContain('Written from the scan of 1 Sep 2026')
      expect(note?.text).toContain('A newer scan ran 20 Sep 2026')
    })

    it('is stale by the scan the words were written from, even after a fresh re-scan — and says to draft again, not to re-scan', () => {
      const e = draftEvidenceFrom({
        answersReply: false, writtenFrom: { ...scanA, stale: true }, latest: scanB, latestLines: lines,
      })
      expect(e?.stale).toBe(true)
      expect(e?.lines).toEqual([])
      const note = evidenceNote(e, true)
      expect(note?.tone).toBe('warn')
      expect(note?.text).toContain('The scan this draft was written from (1 Sep 2026) is past its re-verification deadline')
      expect(note?.text).toContain('re-scanned 20 Sep 2026 — deny this draft and draft it again from that scan')
      expect(note?.text).not.toMatch(/re-scan, then/)
    })

    it('uses the §2.2 sentence when there is no fresh scan since', () => {
      const e = draftEvidenceFrom({
        answersReply: false, writtenFrom: { ...scanA, stale: true }, latest: { ...scanA, stale: true }, latestLines: [],
      })
      const note = evidenceNote(e, true)
      expect(note?.text.startsWith(STALE_EVIDENCE_NOTE)).toBe(true)
      expect(note?.text).toContain('The scan it was written from ran 1 Sep 2026.')
    })

    it('is missing for a draft written before any scan, even when the company was scanned since', () => {
      expect(draftEvidenceFrom({ answersReply: false, writtenFrom: null, latest: scanB, latestLines: lines })).toBeNull()
      expect(MISSING_EVIDENCE_NOTE).toMatch(/had run when this draft was written/)
      expect(MISSING_EVIDENCE_NOTE).not.toMatch(/never scanned/)
    })

    /**
     * An answer is judged by no scan (`evidenceAsOfFor` is null), so the send
     * path never refuses it as stale — the card must not say it does.
     */
    it('never gives an answer to a reply the stale-evidence sentence, however old the scan', () => {
      const stale = draftEvidenceFrom({ answersReply: true, writtenFrom: null, latest: { ...scanA, stale: true }, latestLines: [] })
      expect(stale).toEqual({ asOf: scanA.ranAt.toISOString(), stale: true, lines: [], answersReply: true })
      const note = evidenceNote(stale, true)
      expect(note?.text.startsWith(ANSWER_EVIDENCE_NOTE)).toBe(true)
      expect(note?.text).not.toContain(STALE_EVIDENCE_NOTE)
      expect(note?.text).not.toMatch(/refuses/)
      expect(note?.text).toContain('The last successful scan ran 1 Sep 2026 and is past its re-verification deadline')
      expect(ANSWER_EVIDENCE_NOTE).toMatch(/does not judge an answer by the age of a scan/)
      expect(ANSWER_EVIDENCE_NOTE).toMatch(/repeats no finding that is no longer known to be true/)
    })

    it('shows an answer the latest fresh lines to check it against, and says so when there is no scan', () => {
      const fresh = draftEvidenceFrom({ answersReply: true, writtenFrom: null, latest: scanB, latestLines: lines })
      expect(fresh?.lines).toEqual(lines)
      expect(evidenceNote(fresh, true)).toEqual({ tone: 'plain', text: ANSWER_EVIDENCE_NOTE })
      const none = draftEvidenceFrom({ answersReply: true, writtenFrom: null, latest: null, latestLines: [] })
      expect(evidenceNote(none, true)).toEqual({ tone: 'plain', text: `${ANSWER_EVIDENCE_NOTE} This company has no successful scan.` })
    })
  })

  it("quotes the ICP's reason and what was observed, and invents no detail", () => {
    expect(evidenceLine({ signalKey: 'csp', why: 'No Content-Security-Policy', detail: 'header absent' })).toBe(
      'No Content-Security-Policy: header absent',
    )
    expect(evidenceLine({ signalKey: 'csp', why: null, detail: null })).toBe('csp: no detail recorded — see the company page')
    expect(EVIDENCE_LINES_SHOWN).toBeGreaterThan(0)
  })
})

describe('approving does not send', () => {
  it('says the worker re-checks when there is one', () => {
    expect(approveFootnote(null)).toBe(APPROVE_DOES_NOT_SEND)
    expect(APPROVE_DOES_NOT_SEND).toBe('Approving does not send. The worker re-checks every rule at the moment of sending.')
  })

  it('does not promise a worker the deployment does not have', () => {
    const note = 'No agent worker is connected to this deployment.'
    expect(approveFootnote(note)).toBe(NO_WORKER_FOOTNOTE)
    expect(NO_WORKER_FOOTNOTE.startsWith('Approving does not send')).toBe(true)
    expect(approveFootnote(note)).not.toContain('The worker re-checks')
  })
})

describe('nextFocus', () => {
  const ids = ['a1', 'b2', 'c3']

  it('j moves to the next card and wraps from the last to the first', () => {
    expect(nextFocus(ids, 'a1', 'j')).toBe('b2')
    expect(nextFocus(ids, 'c3', 'j')).toBe('a1')
  })

  it('k moves to the previous card and wraps from the first to the last', () => {
    expect(nextFocus(ids, 'b2', 'k')).toBe('a1')
    expect(nextFocus(ids, 'a1', 'k')).toBe('c3')
  })

  it('starts at the first (j) or the last (k) from nothing, or from a card no longer listed', () => {
    expect(nextFocus(ids, null, 'j')).toBe('a1')
    expect(nextFocus(ids, null, 'k')).toBe('c3')
    expect(nextFocus(ids, 'gone', 'j')).toBe('a1')
  })

  it('ignores unknown keys', () => {
    for (const key of ['a', 'd', 'J', 'K', 'Enter', 'ArrowDown', ' ']) expect(nextFocus(ids, 'b2', key)).toBe('b2')
    expect(nextFocus(ids, null, 'x')).toBeNull()
  })

  it('has nowhere to go when there are no cards', () => {
    expect(nextFocus([], null, 'j')).toBeNull()
  })
})

describe('keyAction', () => {
  const ids = ['a1', 'b2']
  const yes = (): Approvability => ({ ok: true })
  const base = { ids, focused: 'a1' as string | null, armed: null as string | null, approvable: yes, deniable: () => true }

  it('a arms the focused card and does NOT approve it', () => {
    expect(keyAction({ ...base, key: 'a' })).toEqual({ kind: 'arm', id: 'a1' })
  })

  it('Enter approves only a card that was armed, and only while it is still focused', () => {
    expect(keyAction({ ...base, key: 'Enter' })).toEqual({ kind: 'none' })
    expect(keyAction({ ...base, key: 'Enter', armed: 'a1' })).toEqual({ kind: 'approve', id: 'a1' })
    expect(keyAction({ ...base, key: 'Enter', armed: 'a1', focused: 'b2' })).toEqual({ kind: 'disarm' })
    expect(keyAction({ ...base, key: 'Enter', armed: 'a1', focused: null })).toEqual({ kind: 'disarm' })
  })

  it('re-checks approvability at Enter, so a choice changed after arming cannot slip through', () => {
    const blocked = (): Approvability => ({ ok: false, why: 'Choose a person and a campaign first.' })
    expect(keyAction({ ...base, key: 'Enter', armed: 'a1', approvable: blocked })).toEqual({ kind: 'disarm' })
  })

  it('any other key, Escape included, disarms', () => {
    for (const key of ['Escape', 'x', ' ', 'Tab', 'ArrowDown']) {
      expect(keyAction({ ...base, key, armed: 'a1' })).toEqual({ kind: 'disarm' })
    }
    // A modifier on its own is half of a keystroke, not a different one.
    expect(keyAction({ ...base, key: 'Shift', armed: 'a1' })).toEqual({ kind: 'none' })
  })

  it('j and k move focus, which is how an armed card is left behind', () => {
    expect(keyAction({ ...base, key: 'j', armed: 'a1' })).toEqual({ kind: 'focus', id: 'b2' })
    expect(keyAction({ ...base, key: 'k', focused: null })).toEqual({ kind: 'focus', id: 'b2' })
  })

  it('does nothing to a card nobody focused', () => {
    expect(keyAction({ ...base, key: 'a', focused: null })).toEqual({ kind: 'none' })
    expect(keyAction({ ...base, key: 'd', focused: null })).toEqual({ kind: 'none' })
    expect(keyAction({ ...base, key: 'Enter', focused: null })).toEqual({ kind: 'none' })
  })

  it('a on a card that cannot be approved explains instead of arming', () => {
    const blocked = (): Approvability => ({ ok: false, why: 'Approving is pointless: on the suppression list.' })
    expect(keyAction({ ...base, key: 'a', approvable: blocked })).toEqual({
      kind: 'explain', id: 'a1', why: 'Approving is pointless: on the suppression list.',
    })
  })

  it('d denies the focused card in one key, because denying sends nothing', () => {
    expect(keyAction({ ...base, key: 'd' })).toEqual({ kind: 'deny', id: 'a1' })
    expect(keyAction({ ...base, key: 'd', deniable: () => false })).toEqual({ kind: 'none' })
  })

  it('is case-sensitive: A and D are not a and d', () => {
    expect(keyAction({ ...base, key: 'A' })).toEqual({ kind: 'none' })
    expect(keyAction({ ...base, key: 'D' })).toEqual({ kind: 'none' })
  })
})

describe('approvability', () => {
  const card = { canDecide: true, settled: false, busy: false, contactId: 'p', campaignId: 'c', block: null }

  it('is ok only when a person and a campaign are chosen and nothing blocks', () => {
    expect(approvability(card)).toEqual({ ok: true })
    expect(approvability({ ...card, contactId: '' })).toEqual({ ok: false, why: 'Choose a person and a campaign first.' })
    expect(approvability({ ...card, campaignId: '' }).ok).toBe(false)
  })

  it('carries the block through as the reason', () => {
    expect(approvability({ ...card, block: 'Approving is pointless: x.' })).toEqual({ ok: false, why: 'Approving is pointless: x.' })
  })

  it('refuses a decided, in-flight or not-permitted card', () => {
    expect(approvability({ ...card, settled: true }).ok).toBe(false)
    expect(approvability({ ...card, busy: true }).ok).toBe(false)
    expect(approvability({ ...card, canDecide: false }).ok).toBe(false)
  })
})

/**
 * An SMS card (0019). The body is the rendered message, shown whole like
 * every other; what an SMS card adds is the registration it was rendered
 * from — the operator delivers it only as those exact words — and it can be
 * approved only to the person it was rendered for.
 */
describe('an SMS draft’s card', () => {
  const tpl: DraftTemplate = { externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', active: true }

  it('is titled by its template, having no subject of its own', () => {
    expect(draftTitle(null, tpl)).toBe('From template 1107160000000012345')
    expect(draftTitle('Re: the CSP gap', tpl)).toBe('Re: the CSP gap')
    expect(draftTitle(null, null)).toBe('(no subject)')
    expect(draftTitle(null, undefined)).toBe('(no subject)')
  })

  it('names the template id, the header and the category — never the template’s text', () => {
    expect(templateLine(tpl)).toBe(
      'Rendered from DLT template 1107160000000012345, header ACMEIN, service explicit. The operator delivers it only as these exact words.',
    )
    expect(templateLine({ ...tpl, active: false })).toBe(
      'Rendered from DLT template 1107160000000012345, header ACMEIN, service explicit — switched off since this was drafted.',
    )
  })

  it('offers only the person it was rendered for; an email draft keeps everyone at its company', () => {
    const people = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(smsCandidates('sms', 'b', people)).toEqual([{ id: 'b' }])
    expect(smsCandidates('sms', 'gone', people)).toEqual([])
    expect(smsCandidates('email', 'b', people)).toEqual(people)
    // An SMS row always names its person (`smsDraft` writes one); a row that does not is left as it was.
    expect(smsCandidates('sms', null, people)).toEqual(people)
  })

  it('blocks approving words the operator would not deliver, and says to draft again', () => {
    const block = approveBlock({ code: 'template_mismatch', words: 'not its registered template', reason: 'x', humanCanResolve: false })
    expect(block).toContain('the operator would not deliver it')
    expect(block).toContain('draft it again from an active registered template')
  })
})
