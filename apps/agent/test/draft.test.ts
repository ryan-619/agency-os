/**
 * Letting a model improve an opener (§5.5's `draft_outreach`).
 *
 * The deterministic draft is sendable before this runs, so every test asks
 * the same thing: when the model is absent, refused, broken, or subtly
 * wrong about the FACTS, do the words the product already had survive?
 */
import { describe, it, expect } from 'vitest'
import type { Draft, LlmProvider } from '@agency/core'
import { fakeProvider } from '@agency/llm'
import { refineDraft } from '../src/outreach/draft.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const draft: Draft = {
  subject: 'Rentman: No Content-Security-Policy on the login page',
  body: [
    'Hi,',
    '',
    'I had a look at Rentman public pages — only what anyone can see from the outside, no testing of any kind.',
    '',
    '• No Content-Security-Policy — no CSP header on https://rentman.io/login',
    '• No security or trust page — 404 on /security and /trust',
    '',
    'If any of that is already handled or looks wrong, say so.',
  ].join('\n'),
  quoted: ['No Content-Security-Policy', 'No security or trust page'],
}

describe('refining a draft', () => {
  it('returns the written draft when no model is configured', async () => {
    const out = await refineDraft({ log: silent, llm: null, allowRemoteForLeadData: false, draft })
    expect(out.body).toBe(draft.body)
  })

  it('takes a tighter rewrite that still says the same things', async () => {
    const tightened = [
      'Hi,',
      '',
      'I looked at Rentman public pages from the outside only, with no testing.',
      '',
      '• No Content-Security-Policy on the login page',
      '• No security or trust page — /security and /trust both 404',
      '',
      'If that is already handled or looks wrong, tell me and I will correct it.',
    ].join('\n')
    const out = await refineDraft({
      log: silent, llm: fakeProvider(tightened), allowRemoteForLeadData: false, draft,
    })
    expect(out.body).toBe(tightened)
    // The subject and the quoted claims are not the model's to change.
    expect(out.subject).toBe(draft.subject)
    expect(out.quoted).toEqual(draft.quoted)
  })

  /**
   * THE §2.2 case. A rewrite that quietly drops a claim has changed what the
   * email asserts about a real company, and the check is structural rather
   * than a request in the prompt.
   */
  it('discards a rewrite that dropped one of the claims', async () => {
    const dropped = [
      'Hi,',
      '',
      'I looked at your public pages, no testing.',
      '',
      '• No Content-Security-Policy on the login page',
      '',
      'Happy to be corrected.',
    ].join('\n')
    const out = await refineDraft({
      log: silent, llm: fakeProvider(dropped), allowRemoteForLeadData: false, draft,
    })
    expect(out.body).toBe(draft.body)
  })

  /** A rewrite that balloons has added something nobody observed. */
  it('discards a rewrite that grew far beyond the original', async () => {
    const padded = `${draft.body}\n\n${'We also noticed several other issues worth discussing at length. '.repeat(20)}`
    const out = await refineDraft({
      log: silent, llm: fakeProvider(padded), allowRemoteForLeadData: false, draft,
    })
    expect(out.body).toBe(draft.body)
  })

  it('discards an empty answer', async () => {
    const out = await refineDraft({
      log: silent, llm: fakeProvider('   '), allowRemoteForLeadData: false, draft,
    })
    expect(out.body).toBe(draft.body)
  })

  it('keeps the draft when the model is unreachable', async () => {
    const boom: LlmProvider = {
      name: 'ollama', model: 'llama3', local: true,
      complete: () => Promise.reject(new Error('ECONNREFUSED')),
    }
    const out = await refineDraft({ log: silent, llm: boom, allowRemoteForLeadData: false, draft })
    expect(out.body).toBe(draft.body)
  })

  /** A draft names a prospect, so §5.5 refuses a remote model for it. */
  it('does not send a draft to an unapproved remote model', async () => {
    const llm = fakeProvider('anything', { name: 'openai', local: false })
    const out = await refineDraft({ log: silent, llm, allowRemoteForLeadData: false, draft })
    expect(llm.seen).toEqual([])
    expect(out.body).toBe(draft.body)
  })

  it('sends only the observations and the draft, never the whole scan', async () => {
    const llm = fakeProvider(draft.body)
    await refineDraft({ log: silent, llm, allowRemoteForLeadData: false, draft })
    const prompt = llm.seen[0]!.prompt
    expect(prompt).toContain('No Content-Security-Policy')
    expect(prompt).toContain(draft.body)
  })
})
