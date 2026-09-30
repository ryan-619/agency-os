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
  APPROVE_DOES_NOT_SEND, DEFERRED_CODES, EVIDENCE_LINES_SHOWN, MISSING_EVIDENCE_NOTE, NO_WORKER_FOOTNOTE,
  OTHER_CAMPAIGN_NOTE, STALE_EVIDENCE_NOTE,
  addressedByLabel, addressedByOf, approvability, approveBlock, approveFootnote, campaignToCheck, candidateLine,
  checkedUnderLabel, decisionView, evidenceHeading, evidenceLine, evidenceNote, keyAction, nextFocus,
  uncheckedDecision,
  type Approvability, type CandidateDecision,
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
  quiet_hours: true,
  unknown_timezone: true,
  daily_cap: true,
  campaign_inactive: true,
  needs_approval: true,
  stale_evidence: false,
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
        expect(block).toContain(code === 'stale_evidence' ? 're-scan the company, then draft it again' : 'choose someone else')
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

  it('warns when the company was never scanned successfully', () => {
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
