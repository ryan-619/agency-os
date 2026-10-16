/** Follow-up sequences' rules (`src/sequence.ts`): the steps, their words and the one decision per run. */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FOLLOW_UP_BODY, SEQUENCE_LIMITS, followUpSubject, renderStepWords, sequenceNext, sequenceStepsProblem,
  type SequenceFacts, type SequenceStep,
} from '../src/index.js'

const DAY = 86_400_000
const T0 = new Date('2026-10-01T09:00:00Z')
const message = (position: number, afterDays: number, body = DEFAULT_FOLLOW_UP_BODY): SequenceStep =>
  ({ position, kind: 'message', afterDays, subject: null, body })
const task = (position: number, kind: 'call' | 'visit', afterDays: number): SequenceStep =>
  ({ position, kind, afterDays, subject: null, body: null })
const STEPS = [message(2, 3), task(3, 'call', 2), task(4, 'visit', 7)]
const facts = (over: Partial<SequenceFacts> = {}): SequenceFacts => ({
  nextPosition: 2, anchorAt: T0, waiting: null, steps: STEPS, campaignStatus: 'active',
  repliedSince: false, contactPaused: false, dealClosed: false, now: new Date(T0.getTime() + 4 * DAY), ...over,
})

describe('the steps', () => {
  it('takes steps that run 2, 3, 4… with words only on messages and known placeholders', () => {
    expect(sequenceStepsProblem(STEPS)).toBeNull()
    expect(sequenceStepsProblem([message(3, 2)])).toMatch(/out of order/)
    expect(sequenceStepsProblem([message(2, 0)])).toMatch(/between 1 and 90 days/)
    expect(sequenceStepsProblem([message(2, 2, '  ')])).toMatch(/needs its words/)
    expect(sequenceStepsProblem([{ ...task(2, 'call', 2), body: 'Hi' }])).toMatch(/is a call, which has no words/)
    expect(sequenceStepsProblem([message(2, 2, 'Hi {name}')])).toMatch(/uses \{name\}, which nothing fills in/)
    expect(sequenceStepsProblem(Array.from({ length: SEQUENCE_LIMITS.steps + 1 }, (_, i) => message(i + 2, 1)))).toMatch(/at most 9/)
  })

  it('fills in the words, and a reply subject once', () => {
    expect(renderStepWords(DEFAULT_FOLLOW_UP_BODY, { firstName: 'Ravi', company: 'Kumar Dental', agency: 'Accemy' }))
      .toBe('Hi Ravi,\n\nJust bringing my note back to the top of your inbox. Happy to share more — or to stop here if it is not for you.\n\nAccemy')
    expect(renderStepWords('Hi {first_name} at {company}', { firstName: null, company: 'Kumar Dental', agency: 'A' })).toBe('Hi there at Kumar Dental')
    expect(followUpSubject('A quick look at Kumar Dental')).toBe('Re: A quick look at Kumar Dental')
    expect(followUpSubject('RE: re: Hello')).toBe('Re: Hello')
    expect(followUpSubject(null)).toBeNull()
  })
})

describe('sequenceNext', () => {
  it('stops for good on a reply, a pause, a closed deal or a finished campaign — in that order', () => {
    expect(sequenceNext(facts({ repliedSince: true, contactPaused: true }))).toEqual({ kind: 'stop', reason: 'replied' })
    expect(sequenceNext(facts({ contactPaused: true, dealClosed: true }))).toEqual({ kind: 'stop', reason: 'paused' })
    expect(sequenceNext(facts({ dealClosed: true, campaignStatus: 'done' }))).toEqual({ kind: 'stop', reason: 'deal_closed' })
    expect(sequenceNext(facts({ campaignStatus: 'done' }))).toEqual({ kind: 'stop', reason: 'campaign_ended' })
  })

  it('stops when its last message did not go, and waits while it is a draft or queued', () => {
    for (const status of ['refused', 'failed', 'bounced']) {
      expect(sequenceNext(facts({ waiting: { status, sentAt: null } })), status).toEqual({ kind: 'stop', reason: 'refused' })
    }
    for (const status of ['awaiting_approval', 'approved', 'queued', 'sending']) {
      expect(sequenceNext(facts({ waiting: { status, sentAt: null } })), status).toMatchObject({ kind: 'wait', why: 'message_not_sent' })
    }
  })

  it('counts the next step from when the last message WENT, not from when it was drafted', () => {
    const sentAt = new Date(T0.getTime() + 2 * DAY)
    const at = (days: number) => facts({ nextPosition: 3, waiting: { status: 'sent', sentAt }, now: new Date(sentAt.getTime() + days * DAY) })
    expect(sequenceNext(at(1))).toEqual({ kind: 'wait', why: 'not_due', anchorAt: sentAt, settled: true })
    expect(sequenceNext(at(2))).toEqual({ kind: 'take', step: STEPS[1], anchorAt: sentAt, settled: true })
  })

  it('takes the next step on its day, waits before it and while the campaign is paused, and finishes after the last', () => {
    expect(sequenceNext(facts({ now: new Date(T0.getTime() + 2 * DAY) }))).toMatchObject({ kind: 'wait', why: 'not_due' })
    expect(sequenceNext(facts())).toEqual({ kind: 'take', step: STEPS[0], anchorAt: T0, settled: false })
    expect(sequenceNext(facts({ campaignStatus: 'paused' }))).toMatchObject({ kind: 'wait', why: 'campaign_not_active' })
    expect(sequenceNext(facts({ nextPosition: 5 }))).toEqual({ kind: 'stop', reason: 'finished' })
    // A step removed since: the next one there is.
    expect(sequenceNext(facts({ nextPosition: 3, steps: [message(2, 3), task(4, 'visit', 1)] }))).toMatchObject({ kind: 'take', step: { position: 4 } })
  })
})
