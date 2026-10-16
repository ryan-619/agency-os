/** The steps editor's client-safe copies are core's own (`components/outreach/steps-words.ts`). */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FOLLOW_UP_BODY, SEQUENCE_LIMITS, SEQUENCE_PLACEHOLDERS, SEQUENCE_STEP_KINDS, SEQUENCE_STOP_REASONS } from '@agency/core'
import { STEP_DEFAULT_BODY, STEP_KIND_WORDS, STEP_LIMITS, STEP_PLACEHOLDERS, STOP_REASON_WORDS, stepsLine } from '../src/components/outreach/steps-words'

describe('the steps editor’s words', () => {
  it('are core’s, copied for the browser', () => {
    expect(STEP_DEFAULT_BODY).toBe(DEFAULT_FOLLOW_UP_BODY)
    expect(STEP_LIMITS).toEqual(SEQUENCE_LIMITS)
    expect(STEP_PLACEHOLDERS).toEqual(SEQUENCE_PLACEHOLDERS)
    expect(Object.keys(STEP_KIND_WORDS)).toEqual([...SEQUENCE_STEP_KINDS])
    expect(Object.keys(STOP_REASON_WORDS).sort()).toEqual([...SEQUENCE_STOP_REASONS].sort())
  })

  it('says the steps in a line', () => {
    expect(stepsLine([{ kind: 'message', afterDays: 3 }, { kind: 'call', afterDays: 1 }])).toBe('message after 3 days, call after 1 day')
  })
})
