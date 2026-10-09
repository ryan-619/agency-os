/**
 * The model seam (PROMPT.md §5.5).
 *
 * §5.5's rationale — "local models keep lead data on their hardware, which
 * is the point" — is implemented as a rule, so these tests are about what
 * `decideLlmCall` REFUSES. The important one is the inverted default: a
 * task carrying a real person's words does not reach a third party because
 * somebody configured a third party; it reaches one because somebody said
 * it may.
 */
import { describe, it, expect } from 'vitest'
import {
  TASK_CARRIES_LEAD_DATA, decideLlmCall, leadDataFor,
  type LlmFacts, type LlmTask,
} from '../src/llm/provider.js'

const facts = (over: Partial<LlmFacts> = {}): LlmFacts => ({
  task: 'summarise_call',
  providerName: 'ollama',
  providerIsLocal: true,
  taskEnabled: true,
  carriesLeadData: true,
  allowRemoteForLeadData: false,
  promptLength: 200,
  ...over,
})

describe('decideLlmCall', () => {
  it('allows a lead-data task on a local model, with nothing else configured', () => {
    expect(decideLlmCall(facts())).toEqual({ allowed: true })
  })

  /** THE rule. The default is refusal, not permission. */
  it('refuses to send somebody’s words to a remote model nobody approved', () => {
    const d = decideLlmCall(facts({ providerName: 'openai', providerIsLocal: false }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('lead_data_offsite')
    expect(d.reason).toMatch(/openai/)
  })

  it('allows it once the operator has accepted that deliberately', () => {
    expect(
      decideLlmCall(facts({ providerName: 'openai', providerIsLocal: false, allowRemoteForLeadData: true })),
    ).toEqual({ allowed: true })
  })

  /** The agency's own template wording is the agency's to send anywhere. */
  it('lets copy that names nobody go to a remote model without ceremony', () => {
    expect(
      decideLlmCall(facts({
        task: 'polish_copy',
        carriesLeadData: leadDataFor('polish_copy'),
        providerName: 'openai',
        providerIsLocal: false,
      })),
    ).toEqual({ allowed: true })
  })

  it('still refuses copy the caller says quotes a prospect', () => {
    const d = decideLlmCall(facts({
      task: 'polish_copy',
      carriesLeadData: leadDataFor('polish_copy', true),
      providerName: 'openai',
      providerIsLocal: false,
    }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('lead_data_offsite')
  })

  it.each([
    ['nothing configured', { providerName: null }, 'no_provider'],
    ['the task switched off', { taskEnabled: false }, 'task_disabled'],
    ['an empty prompt', { promptLength: 0 }, 'nothing_to_send'],
  ])('refuses %s', (_label, over, code) => {
    const d = decideLlmCall(facts(over as Partial<LlmFacts>))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe(code)
  })

  /**
   * The ORDER, not just the outcomes. A refusal code is what somebody reads
   * in a log six months later, and "nothing is configured" and "you may not
   * send this offsite" call for completely different actions.
   */
  it('reports the more specific problem first when several are true at once', () => {
    const d = decideLlmCall(facts({
      providerName: null,
      taskEnabled: false,
      promptLength: 0,
      providerIsLocal: false,
    }))
    if (!d.allowed) expect(d.code).toBe('no_provider')

    const e = decideLlmCall(facts({ taskEnabled: false, promptLength: 0, providerIsLocal: false }))
    if (!e.allowed) expect(e.code).toBe('task_disabled')

    const f = decideLlmCall(facts({ promptLength: 0, providerIsLocal: false }))
    if (!f.allowed) expect(f.code).toBe('nothing_to_send')
  })
})

describe('leadDataFor', () => {
  /**
   * Everything this product summarises, classifies or drafts is about a
   * real company and the people at it. The one exception is what makes the
   * flag mean anything.
   */
  it('treats everything about a prospect as lead data', () => {
    const tasks: LlmTask[] = ['summarise_call', 'classify_reply', 'draft_outreach', 'draft_reply', 'summarise_findings']
    for (const t of tasks) expect(leadDataFor(t)).toBe(true)
    expect(leadDataFor('polish_copy')).toBe(false)
  })

  it('can be escalated by the caller but never downgraded', () => {
    expect(leadDataFor('polish_copy', true)).toBe(true)
    // A caller does not get to declare a call transcript safe.
    expect(leadDataFor('summarise_call', false)).toBe(true)
  })

  it('keeps the table and the helper in step', () => {
    for (const [task, carries] of Object.entries(TASK_CARRIES_LEAD_DATA)) {
      expect(leadDataFor(task as LlmTask)).toBe(carries)
    }
  })
})
