/**
 * Reply triage (§5.5's `classify_reply`), and the two things it may not do.
 *
 * The deterministic kind is already stored by the time this runs, so every
 * test below asks the same question in a different way: when the model is
 * absent, refused, broken or wrong, does the answer the product already had
 * survive?
 */
import { describe, it, expect, vi } from 'vitest'
import type { AgencyDb } from '@agency/db'
import type { LlmProvider } from '@agency/core'
import { fakeProvider } from '@agency/llm'
import { refineReplyKind } from '../src/outreach/classify.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Records what would have been written, without a database. */
function spyDb(): { db: AgencyDb; writes: unknown[] } {
  const writes: unknown[] = []
  const db = {
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          writes.push(values)
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as AgencyDb
  return { db, writes }
}

const base = (over: Partial<Parameters<typeof refineReplyKind>[0]> = {}) => {
  const { db, writes } = spyDb()
  return {
    writes,
    args: {
      db,
      log: silent,
      llm: null as LlmProvider | null,
      allowRemoteForLeadData: false,
      touchId: 'touch-1',
      body: 'Sounds good, can you send pricing?',
      deterministic: 'other' as const,
      ...over,
    },
  }
}

describe('refining a reply kind', () => {
  /**
   * THE rule (§2.1). An opt-out is decided by a pure function over the
   * person's own words, and a model is not asked — not asked-and-overruled,
   * NOT ASKED. The suppression row that word implies has already been
   * written by the send path; this function has no business revisiting it.
   */
  it('never consults a model about a reply already read as an opt-out', async () => {
    const llm = fakeProvider('interested')
    const { args, writes } = base({ llm, deterministic: 'opted_out', body: 'take me off your list' })
    expect(await refineReplyKind(args)).toBe('opted_out')
    expect(llm.seen).toEqual([])
    expect(writes).toEqual([])
  })

  /**
   * And the same rule from the other side: a model that answers `opted_out`
   * for an ordinary reply is IGNORED. Obeying it would imply a suppression
   * nobody wrote — a row saying somebody asked to be left alone when they
   * did not.
   */
  it('ignores a model that claims a reply was an opt-out', async () => {
    const llm = fakeProvider('opted_out')
    const { args, writes } = base({ llm, deterministic: 'interested' })
    expect(await refineReplyKind(args)).toBe('interested')
    expect(writes).toEqual([])
  })

  it('takes a better kind from the model and stores it', async () => {
    const llm = fakeProvider('wrong_person')
    const { args, writes } = base({ llm, deterministic: 'other' })
    expect(await refineReplyKind(args)).toBe('wrong_person')
    expect(writes).toEqual([{ replyKind: 'wrong_person' }])
  })

  it('writes nothing when the model agrees with what is already stored', async () => {
    const llm = fakeProvider('interested')
    const { args, writes } = base({ llm, deterministic: 'interested' })
    expect(await refineReplyKind(args)).toBe('interested')
    expect(writes).toEqual([])
  })

  it('keeps the deterministic kind when the model answers nonsense', async () => {
    for (const nonsense of ['very interested indeed', 'CATEGORY: none', '']) {
      const { args, writes } = base({ llm: fakeProvider(nonsense), deterministic: 'not_now' })
      expect(await refineReplyKind(args), nonsense).toBe('not_now')
      expect(writes).toEqual([])
    }
  })

  it('keeps it when the model is unreachable', async () => {
    const boom: LlmProvider = {
      name: 'ollama', model: 'llama3', local: true,
      complete: () => Promise.reject(new Error('ECONNREFUSED')),
    }
    const { args, writes } = base({ llm: boom, deterministic: 'auto_reply' })
    expect(await refineReplyKind(args)).toBe('auto_reply')
    expect(writes).toEqual([])
  })

  /** A reply is a named person's words — §5.5 refuses a remote model for it. */
  it('does not send a reply to an unapproved remote model', async () => {
    const llm = fakeProvider('interested', { name: 'openai', local: false })
    const { args } = base({ llm, deterministic: 'other' })
    expect(await refineReplyKind(args)).toBe('other')
    expect(llm.seen).toEqual([])
  })

  it('sends it once the operator has accepted that', async () => {
    const llm = fakeProvider('interested', { name: 'openai', local: false })
    const { args } = base({ llm, deterministic: 'other', allowRemoteForLeadData: true })
    expect(await refineReplyKind(args)).toBe('interested')
    expect(llm.seen).toHaveLength(1)
  })

  it('does not call a model for an empty reply', async () => {
    const llm = fakeProvider('interested')
    const { args } = base({ llm, body: '   ', deterministic: 'other' })
    expect(await refineReplyKind(args)).toBe('other')
    expect(llm.seen).toEqual([])
  })

  /** A quoted thread runs long; the category is in what the person wrote. */
  it('bounds what it sends', async () => {
    const llm = fakeProvider('interested')
    const { args } = base({ llm, body: 'x'.repeat(50_000), deterministic: 'other' })
    await refineReplyKind(args)
    expect(llm.seen[0]!.prompt.length).toBeLessThanOrEqual(4000)
  })
})
