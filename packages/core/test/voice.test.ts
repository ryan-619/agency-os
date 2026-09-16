/**
 * The voice rules (PROMPT.md §2.1, §8.5), pure.
 *
 * The three that are law — disclose first, honour "stop" immediately, hand
 * off to a person on request — and the scripted policy that has to reach
 * "qualified" without a model, because that is what the Definition of Done
 * is proved with when no model is configured.
 */
import { describe, it, expect } from 'vitest'
import {
  INITIAL_STATE, aiDisclosure, decideInboundCall, projectedCallCost, qualificationOutcome, scriptedTurn,
  sentimentOf, shouldHandOffForSentiment, spokenOptOut, summariseCall, wantsHuman, type QualificationState,
} from '../src/voice.js'

describe('the disclosure', () => {
  it('says it is an AI, says it may be recorded, and says how to stop — in that order', () => {
    const d = aiDisclosure('Agency')
    const ai = d.indexOf("I'm an AI assistant")
    const rec = d.indexOf('may be recorded')
    const stop = d.indexOf('Say "stop"')
    expect(ai).toBeGreaterThan(-1)
    expect(rec).toBeGreaterThan(ai)
    expect(stop).toBeGreaterThan(rec)
    expect(d).toMatch(/talk to a person/)
  })
})

describe('spokenOptOut', () => {
  it.each([
    'stop', 'Stop.', 'please stop', 'stop calling me', 'remove me from your list', 'take me off the list',
    'do not call this number', "don't contact me again", 'unsubscribe', 'I want to opt out', 'leave me alone',
  ])('hears %j as an opt-out', (t) => {
    expect(spokenOptOut(t)).toBe(true)
  })
  it.each(['we stopped using that vendor', 'the bus stop is near us', 'yes please go on', ''])('does not hear %j as one', (t) => {
    expect(spokenOptOut(t)).toBe(false)
  })
})

describe('wantsHuman', () => {
  it.each(['can I speak to a real person', 'is this a robot?', 'transfer me to someone', 'I want to talk to a human', 'put me through to a manager'])(
    'hears %j',
    (t) => expect(wantsHuman(t)).toBe(true),
  )
  it.each(['email is fine', "no thanks, I don't need a person", 'we build a payments platform'])('does not hear %j', (t) => {
    expect(wantsHuman(t)).toBe(false)
  })
})

describe('sentiment', () => {
  const at = '2026-09-15T10:00:00.000Z'
  it('scores the caller, not the agent', () => {
    expect(sentimentOf([{ role: 'agent', text: 'great great great', at }, { role: 'caller', text: 'this is a waste of time', at }])).toBe('negative')
  })
  it('is neutral with nothing to go on', () => {
    expect(sentimentOf([{ role: 'caller', text: 'we build software', at }])).toBe('neutral')
  })
  it('hands off on two negatives even without a request', () => {
    expect(shouldHandOffForSentiment([{ role: 'caller', text: 'this is ridiculous and a waste', at }])).toBe(true)
    expect(shouldHandOffForSentiment([{ role: 'caller', text: 'hmm not sure', at }])).toBe(false)
  })
})

describe('the scripted policy', () => {
  const org = 'Agency'
  const drive = (answers: string[]): { state: QualificationState; actions: string[]; replies: string[] } => {
    let state = INITIAL_STATE
    const actions: string[] = []
    const replies: string[] = []
    for (const a of answers) {
      const r = scriptedTurn(state, a, org)
      state = r.next
      actions.push(r.action)
      replies.push(r.reply)
      if (r.action !== 'continue') break
    }
    return { state, actions, replies }
  }

  it('qualifies a caller with a login-bearing product, a questionnaire, and a near-term timeline, then hands off on request', () => {
    const r = drive([
      'We build a B2B SaaS platform, customers log in',
      'Yes, we had a security questionnaire last quarter and lost a deal on SOC 2',
      'This month, before the next enterprise deal',
      'Can I talk to a person now?',
    ])
    expect(r.actions).toEqual(['continue', 'continue', 'continue', 'handoff'])
    expect(qualificationOutcome(r.state)).toBe('handoff')
    expect(qualificationOutcome({ ...r.state, ending: undefined })).toBe('qualified')
  })

  it('ends by email when the caller says email is enough', () => {
    const r = drive(['A mobile app', 'Yes, a questionnaire', 'Next month', 'Email is fine'])
    expect(r.actions.at(-1)).toBe('end')
    expect(r.state.ending).toBe('email')
    expect(qualificationOutcome(r.state)).toBe('qualified')
  })

  it('is not qualified when the answers are disengaged', () => {
    const r = drive(['Nothing really', 'No', 'No idea', 'email'])
    expect(qualificationOutcome(r.state)).toBe('not_qualified')
  })

  it('is incomplete when the caller hangs up after one answer', () => {
    const r = drive(['We build software'])
    expect(qualificationOutcome(r.state)).toBe('incomplete')
  })

  it('honours "stop" at any step, before anything else', () => {
    const r = drive(['We build software', 'Stop calling me'])
    expect(r.actions).toEqual(['continue', 'opted_out'])
    expect(r.replies[1]).toMatch(/nobody from Agency contacts you again/)
    expect(qualificationOutcome(r.state)).toBe('opted_out')
  })

  it('hands off the moment a person is asked for, whatever the step', () => {
    const r = drive(['Is this a robot? I want a human'])
    expect(r.actions).toEqual(['handoff'])
  })
})

describe('summariseCall', () => {
  const at = '2026-09-15T10:00:00.000Z'
  it('states the outcome and the answers, and invents nothing', () => {
    const s = summariseCall(
      [{ role: 'agent', text: 'hi', at }, { role: 'caller', text: 'We build a platform', at }],
      'qualified',
      { step: 'done', answers: { what: 'We build a platform', pain: 'Yes', timeline: 'Now' } },
    )
    expect(s).toMatch(/^Outcome: qualified\./)
    expect(s).toMatch(/What they build: We build a platform/)
    expect(s).not.toMatch(/recommend|should/)
  })
  it('says so when nothing was transcribed', () => {
    expect(summariseCall([], 'no_answer')).toMatch(/did not say anything/)
  })
})

describe('projectedCallCost', () => {
  it('is null when the rate is not configured — the page says so instead of guessing', () => {
    expect(projectedCallCost({ calls: 10, avgMinutes: 3, ratePerMinUsd: null, outboundPerMinUsd: null })).toBeNull()
  })
  it('adds the outbound rate for outbound calls', () => {
    expect(projectedCallCost({ calls: 10, avgMinutes: 3, ratePerMinUsd: 0.07, outboundPerMinUsd: 0.014 })).toEqual({ perCallUsd: 0.25, totalUsd: 2.5 })
    expect(projectedCallCost({ calls: 10, avgMinutes: 3, ratePerMinUsd: 0.07, outboundPerMinUsd: null })).toEqual({ perCallUsd: 0.21, totalUsd: 2.1 })
  })
})

describe('decideInboundCall', () => {
  it('answers a suppressed number in service-only mode — no questions, a person or a goodbye', () => {
    expect(decideInboundCall({ suppressed: true })).toEqual({ mode: 'service_only' })
    expect(decideInboundCall({ suppressed: false })).toEqual({ mode: 'qualify' })
  })
})
