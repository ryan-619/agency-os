/**
 * The chat reducer.
 *
 * This file exists because of a bug that shipped: the reducer had NO test, and
 * a browser check that sends one question per page load never reaches the case
 * that was broken. An adversarial review found it, three reviewers described
 * it independently, and both verifiers confirmed it by tracing the path.
 *
 * The reducer is a pure function precisely so that it can be tested here
 * without a DOM — there is no jsdom or testing-library installed, and adding
 * one is a decision nobody has made. Nothing about the ordering needs a DOM.
 */
import { describe, it, expect } from 'vitest'
import type { ChatEvent } from '@agency/core'
import {
  blocksFromTranscript, emptyChat, endedMessage, parseFrame, reduceChat, withUserMessage,
  type ApprovalBlock, type NoticeBlock, type TextBlock, type ToolBlock, type TranscriptRow,
} from '../src/components/chat/reducer'

const TURN_A = 'turn-aaaa'
const TURN_B = 'turn-bbbb'

function ev(kind: string, seq: number, turnId = TURN_A, extra: Record<string, unknown> = {}): ChatEvent {
  return {
    kind, seq, turnId, sessionId: 'session-1', at: '2026-09-13T00:00:00.000Z', ...extra,
  } as unknown as ChatEvent
}

const run = (events: ChatEvent[]) => events.reduce(reduceChat, emptyChat)

describe('the per-turn sequence watermark', () => {
  /**
   * THE BUG. The worker numbers `seq` inside startTurn, so every turn begins
   * again at 1. A watermark carried across turns sits at the previous turn's
   * maximum, and every frame of the next answer falls under it.
   *
   * What the user saw: their own question, a spinner, then nothing at all.
   */
  it('renders a second turn in full, even though its seq restarts at 1', () => {
    const first = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u1' }),
      ...Array.from({ length: 200 }, (_, i) =>
        ev('text_delta', i + 2, TURN_A, { blockIndex: 0, text: 'x' }),
      ),
      ev('turn_finished', 202, TURN_A, { reason: 'success', sdkSessionId: 's' }),
    ])
    expect(first.lastSeq).toBe(202)

    // The second question. Every one of these is below 202.
    const second = [
      ev('turn_started', 1, TURN_B, { userMessageId: 'u2' }),
      ev('text_delta', 2, TURN_B, { blockIndex: 0, text: 'the answer' }),
      ev('tool_call', 3, TURN_B, {
        toolUseId: 't1', toolName: 'mcp__agency__search_companies', displayName: 'Search companies',
        input: {}, inputTruncated: false, risk: 'low', riskRule: 'read_only', agentId: null,
      }),
      ev('cost', 4, TURN_B, {
        turnCostUsd: '0.010000', sessionCostUsd: '0.020000', numTurns: 1, tokensIn: 1, tokensOut: 1,
      }),
      ev('turn_finished', 5, TURN_B, { reason: 'success', sdkSessionId: 's' }),
    ].reduce(reduceChat, first)

    const texts = second.blocks.filter((b): b is TextBlock => b.kind === 'text')
    expect(texts.at(-1)?.text, 'the second answer must render').toBe('the answer')
    expect(second.blocks.some((b) => b.kind === 'tool'), 'the tool card must render').toBe(true)
    expect(second.turnCostUsd, 'the cost must render').toBe('0.010000')
  })

  /**
   * An approval card swallowed this way is the worst version: the turn parks
   * for the full thirty-minute TTL with nothing on screen to click, then
   * reports an expiry the person never saw.
   */
  it('renders an approval card raised in a later turn', () => {
    const after = [
      ev('turn_started', 1, TURN_B, { userMessageId: 'u2' }),
      ev('approval_requested', 2, TURN_B, {
        approvalId: 'a1', toolUseId: 't1', toolName: 'mcp__agency__queue_touch',
        payload: { channel: 'email' }, risk: 'high', explain: 'Drafts a message.',
        expiresAt: '2026-09-13T00:30:00.000Z',
      }),
    ].reduce(reduceChat, run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u1' }),
      ev('text_delta', 50, TURN_A, { blockIndex: 0, text: 'first' }),
    ]))
    expect(after.blocks.some((b) => b.kind === 'approval')).toBe(true)
  })

  /**
   * What the guard is actually for. A reconnect replays the tail of the
   * CURRENT turn, and the edge of that window overlaps.
   */
  it('still drops a replayed frame within the same turn', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('text_delta', 2, TURN_A, { blockIndex: 0, text: 'hello' }),
      ev('text_delta', 2, TURN_A, { blockIndex: 0, text: 'hello' }),
      ev('text_delta', 3, TURN_A, { blockIndex: 0, text: ' world' }),
    ])
    const text = state.blocks.find((b): b is TextBlock => b.kind === 'text')
    expect(text?.text).toBe('hello world')
  })

  it('drops an out-of-order frame within a turn rather than applying it late', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('text_delta', 5, TURN_A, { blockIndex: 0, text: 'b' }),
      ev('text_delta', 3, TURN_A, { blockIndex: 0, text: 'a' }),
    ])
    expect(state.blocks.find((b): b is TextBlock => b.kind === 'text')?.text).toBe('b')
  })
})

describe('a turn that ended without a clean finish', () => {
  /**
   * Found by the test above, not by review. Only a CLEAN finish emits
   * `message_complete`; an error, an interrupt, a timeout and a budget refusal
   * all end the turn with the last block still open. The next answer then
   * appended to the previous one — two replies run together in one paragraph,
   * under a caret that never stopped blinking.
   */
  it.each(['error', 'interrupted', 'turn_timeout', 'max_budget', 'success'])(
    'closes the open block when the turn ends as %s',
    (reason) => {
      const state = run([
        ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
        ev('text_delta', 2, TURN_A, { blockIndex: 0, text: 'half an ans' }),
        ev('turn_finished', 3, TURN_A, { reason, sdkSessionId: null }),
      ])
      const texts = state.blocks.filter((b): b is TextBlock => b.kind === 'text')
      expect(texts.every((b) => !b.streaming)).toBe(true)
    },
  )

  it('starts a new block for the next turn instead of extending the last one', () => {
    const first = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u1' }),
      ev('text_delta', 2, TURN_A, { blockIndex: 0, text: 'interrupted mid-' }),
      ev('turn_finished', 3, TURN_A, { reason: 'interrupted', sdkSessionId: null }),
    ])
    const second = [
      ev('turn_started', 1, TURN_B, { userMessageId: 'u2' }),
      ev('text_delta', 2, TURN_B, { blockIndex: 0, text: 'a fresh answer' }),
    ].reduce(reduceChat, first)

    const texts = second.blocks.filter((b): b is TextBlock => b.kind === 'text')
    expect(texts).toHaveLength(2)
    expect(texts[0]!.text).toBe('interrupted mid-')
    expect(texts[1]!.text).toBe('a fresh answer')
  })

  /**
   * Belt and braces: even if `turn_finished` never arrives — a dropped
   * connection, a worker killed mid-turn — the next turn's text must not land
   * inside the previous turn's block.
   */
  it('does not extend a previous turn’s block even with no ending at all', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u1' }),
      ev('text_delta', 2, TURN_A, { blockIndex: 0, text: 'turn one' }),
      ev('turn_started', 1, TURN_B, { userMessageId: 'u2' }),
      ev('text_delta', 2, TURN_B, { blockIndex: 0, text: 'turn two' }),
    ])
    const texts = state.blocks.filter((b): b is TextBlock => b.kind === 'text')
    expect(texts.map((t) => t.text)).toEqual(['turn one', 'turn two'])
  })
})

describe('assembling an answer', () => {
  it('accumulates deltas into one block rather than one block per token', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('text_delta', 2, TURN_A, { blockIndex: 0, text: 'rent' }),
      ev('text_delta', 3, TURN_A, { blockIndex: 0, text: 'man' }),
      ev('text_delta', 4, TURN_A, { blockIndex: 0, text: '.io' }),
    ])
    const texts = state.blocks.filter((b) => b.kind === 'text')
    expect(texts).toHaveLength(1)
    expect((texts[0] as TextBlock).text).toBe('rentman.io')
    expect((texts[0] as TextBlock).streaming).toBe(true)
  })

  /**
   * message_complete must NOT carry the text into the block — the deltas
   * already delivered it, and using both paints the answer twice.
   */
  it('closes the block without doubling the text', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('text_delta', 2, TURN_A, { blockIndex: 0, text: 'hello' }),
      ev('message_complete', 3, TURN_A, { messageId: 'm', text: 'hello' }),
    ])
    const text = state.blocks.find((b): b is TextBlock => b.kind === 'text')!
    expect(text.text).toBe('hello')
    expect(text.streaming).toBe(false)
  })

  it('pairs a tool result with the call it answers', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('tool_call', 2, TURN_A, {
        toolUseId: 't1', toolName: 'mcp__agency__get_icp', displayName: 'Get icp',
        input: {}, inputTruncated: false, risk: 'low', riskRule: 'read_only', agentId: null,
      }),
      ev('tool_result', 3, TURN_A, {
        toolUseId: 't1', ok: true, summary: 'ICP: Security-gap SaaS', detail: {},
        detailTruncated: false, durationMs: 12,
      }),
    ])
    const tool = state.blocks.find((b): b is ToolBlock => b.kind === 'tool')!
    expect(tool.status).toBe('ok')
    expect(tool.summary).toBe('ICP: Security-gap SaaS')
  })

  it('leaves a result with no matching call alone rather than inventing a card', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('tool_result', 2, TURN_A, {
        toolUseId: 'ghost', ok: true, summary: 'x', detail: null, detailTruncated: false, durationMs: 0,
      }),
    ])
    expect(state.blocks.filter((b) => b.kind === 'tool')).toHaveLength(0)
  })

  it('resolves an approval card in place', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('approval_requested', 2, TURN_A, {
        approvalId: 'a1', toolUseId: 't1', toolName: 'mcp__agency__queue_touch',
        payload: { channel: 'email' }, risk: 'high', explain: 'Drafts a message.',
        expiresAt: '2026-09-13T00:30:00.000Z',
      }),
      ev('approval_resolved', 3, TURN_A, {
        approvalId: 'a1', toolUseId: 't1', status: 'denied',
        decidedByEmail: 'priya@agency.test', reason: 'wrong company',
      }),
    ])
    const card = state.blocks.find((b): b is ApprovalBlock => b.kind === 'approval')!
    expect(card.status).toBe('denied')
    expect(card.decidedByEmail).toBe('priya@agency.test')
    expect(state.blocks.filter((b) => b.kind === 'approval')).toHaveLength(1)
  })
})

describe('how a turn ends', () => {
  it('says nothing extra when it simply succeeded', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('turn_finished', 2, TURN_A, { reason: 'success', sdkSessionId: 's' }),
    ])
    expect(state.blocks.filter((b) => b.kind === 'notice')).toHaveLength(0)
    expect(state.running).toBe(false)
  })

  /**
   * An SDK failure already explained itself — "the account has no credit".
   * Following that with "the agent stopped before finishing" reads as two
   * separate problems, and the second one's advice contradicts the first.
   */
  it('does not add a second explanation when the turn already gave one', () => {
    const state = run([
      ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
      ev('error', 2, TURN_A, {
        code: 'chat_account', retryable: false, message: 'The account has no credit left.',
      }),
      ev('turn_finished', 3, TURN_A, { reason: 'error', sdkSessionId: null }),
    ])
    const notices = state.blocks.filter((b) => b.kind === 'notice')
    expect(notices).toHaveLength(1)
  })

  it.each([
    ['max_turns', /step limit/i],
    ['max_budget', /spending limit/i],
    ['session_budget', /spending limit/i],
    ['turn_timeout', /ran out of time/i],
    ['halted', /tell an owner/i],
  ])('explains a %s ending in words', (reason, matches) => {
    expect(endedMessage(reason as never)).toMatch(matches)
  })

  it('stops the spinner on every ending', () => {
    for (const reason of ['success', 'error', 'interrupted', 'max_turns', 'halted']) {
      const state = run([
        ev('turn_started', 1, TURN_A, { userMessageId: 'u' }),
        ev('turn_finished', 2, TURN_A, { reason, sdkSessionId: null }),
      ])
      expect(state.running, reason).toBe(false)
    }
  })
})

describe('parseFrame', () => {
  /**
   * A deployed page and a redeployed worker disagree for as long as one tab
   * stays open. The useful behaviour is to skip the frame, not to break the
   * transcript already on screen.
   */
  it('returns null rather than throwing on anything unparseable', () => {
    for (const bad of ['', 'not json', '{}', '{"kind":"nope","seq":1}', 'null', '[]']) {
      expect(parseFrame(bad), bad).toBeNull()
    }
  })

  it('parses a good frame', () => {
    const frame = JSON.stringify(ev('heartbeat', 1))
    expect(parseFrame(frame)).toMatchObject({ kind: 'heartbeat', seq: 1 })
  })
})

describe('withUserMessage', () => {
  it('shows the question the instant it is sent, before any event arrives', () => {
    const state = withUserMessage(emptyChat, 'score the pipeline')
    const text = state.blocks[0] as TextBlock
    expect(text.role).toBe('user')
    expect(text.text).toBe('score the pipeline')
    expect(text.streaming).toBe(false)
  })
})

describe('rebuilding a conversation from what was written down', () => {
  /**
   * Nothing did this. A reload showed an EMPTY panel — while the worker
   * resumed the SDK session with the whole conversation still in the model's
   * context. The agent remembered and the person did not, so the next answer
   * referred to things no longer on screen and the obvious repair (asking
   * again) spent money re-deriving what was already stored.
   */
  const row = (over: Partial<TranscriptRow> & { id: string }): TranscriptRow => ({
    role: 'assistant', content: {}, toolName: null, toolUseId: null, turnId: TURN_A, ...over,
  })

  it('puts the exchange back in the order it happened', () => {
    const blocks = blocksFromTranscript([
      row({ id: '1', role: 'user', content: { text: 'who is worth working?' } }),
      row({ id: '2', content: { text: 'Rentman, on the evidence.' } }),
    ])
    expect(blocks.map((b) => (b as TextBlock).text)).toEqual([
      'who is worth working?',
      'Rentman, on the evidence.',
    ])
    expect((blocks[0] as TextBlock).role).toBe('user')
    expect((blocks[1] as TextBlock).role).toBe('assistant')
  })

  /**
   * Deltas are deliberately not persisted, so nothing rebuilt is mid-stream.
   * A restored block left `streaming` would blink a caret under an answer
   * that finished days ago.
   */
  it('never restores a block as still streaming', () => {
    const blocks = blocksFromTranscript([row({ id: '1', content: { text: 'done' } })])
    expect((blocks[0] as TextBlock).streaming).toBe(false)
  })

  it('pairs a tool call with the result that was stored for it', () => {
    const blocks = blocksFromTranscript([
      row({
        id: '1', toolName: 'mcp__agency__scan_company', toolUseId: 't1',
        content: { kind: 'tool_call', input: { domain: 'rentman.io' }, risk: 'low', displayName: 'Scan company' },
      }),
      row({
        id: '2', role: 'tool', toolUseId: 't1',
        content: { kind: 'tool_result', ok: true, summary: 'scored 77, tier A' },
      }),
    ])
    const tool = blocks.find((b): b is ToolBlock => b.kind === 'tool')!
    expect(tool.status).toBe('ok')
    expect(tool.summary).toBe('scored 77, tier A')
    expect(tool.displayName).toBe('Scan company')
    expect(blocks).toHaveLength(1)
  })

  /**
   * A call whose result never landed is exactly what it was when the worker
   * died. Showing it as finished would be a claim nobody made.
   */
  it('leaves a call with no result showing as still running', () => {
    const blocks = blocksFromTranscript([
      row({
        id: '1', toolName: 'mcp__agency__scan_company', toolUseId: 't1',
        content: { kind: 'tool_call', input: {}, risk: 'low', displayName: 'Scan company' },
      }),
    ])
    expect((blocks[0] as ToolBlock).status).toBe('running')
  })

  it('drops a result whose call is missing rather than drawing a nameless card', () => {
    const blocks = blocksFromTranscript([
      row({ id: '1', role: 'tool', toolUseId: 'ghost', content: { kind: 'tool_result', ok: true, summary: 'x' } }),
    ])
    expect(blocks).toHaveLength(0)
  })

  it('explains the reconciler’s notes in words a person can act on', () => {
    const blocks = blocksFromTranscript([
      row({ id: '1', role: 'system', content: { kind: 'worker_restart', turnId: TURN_A } }),
      row({ id: '2', role: 'system', content: { kind: 'approval_orphaned', approvalId: 'a1', toolName: 'queue_touch' } }),
    ])
    const notices = blocks.filter((b): b is NoticeBlock => b.kind === 'notice')
    expect(notices).toHaveLength(2)
    expect(notices[0]!.text).toMatch(/restarted/i)
    expect(notices[1]!.text).toMatch(/cancelled/i)
    expect(notices[1]!.text).toMatch(/Nothing was done/)
  })

  it('ignores a system note it does not recognise instead of rendering an empty box', () => {
    const blocks = blocksFromTranscript([row({ id: '1', role: 'system', content: { kind: 'something_new' } })])
    expect(blocks).toHaveLength(0)
  })

  const approval = {
    id: 'a1', toolName: 'mcp__agency__queue_touch', payload: { channel: 'email' }, risk: 'high',
    expiresAt: '2026-09-13T00:30:00.000Z', toolUseId: 't1', decidedReason: null,
  }

  it('brings back a request that is still waiting for someone', () => {
    const blocks = blocksFromTranscript([], [{ ...approval, status: 'pending' }])
    const card = blocks.find((b): b is ApprovalBlock => b.kind === 'approval')!
    expect(card.status).toBe('pending')
    expect(card.payload).toEqual({ channel: 'email' })
  })

  /**
   * A decided card belongs to a turn that already reported its outcome in
   * words. Re-rendering it invites a second click on a question nobody is
   * asking any more.
   */
  it.each(['approved', 'denied', 'expired'])('does not bring back a %s one', (status) => {
    expect(blocksFromTranscript([], [{ ...approval, status }])).toHaveLength(0)
  })

  it('survives rows whose content is missing or the wrong shape', () => {
    expect(() =>
      blocksFromTranscript([
        row({ id: '1', role: 'user', content: null }),
        row({ id: '2', content: { text: 42 } }),
        row({ id: '3', role: 'tool', toolUseId: null, content: undefined }),
        row({ id: '4', role: 'something-new', content: { text: 'x' } }),
      ]),
    ).not.toThrow()
  })

  it('starts from nothing for a brand-new conversation', () => {
    expect(blocksFromTranscript([], [])).toEqual([])
  })

  /**
   * The restored blocks go straight into the reducer's state, so their ids
   * have to be unique — React keys off them, and a duplicate silently drops a
   * message.
   */
  it('gives every restored block a distinct id', () => {
    const blocks = blocksFromTranscript(
      [
        row({ id: '1', role: 'user', content: { text: 'a' } }),
        row({ id: '2', content: { text: 'b' } }),
        row({ id: '3', toolName: 't', toolUseId: 'u', content: { kind: 'tool_call', risk: 'low' } }),
        row({ id: '4', role: 'system', content: { kind: 'worker_restart' } }),
      ],
      [{ ...approval, status: 'pending' }],
    )
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length)
  })
})
