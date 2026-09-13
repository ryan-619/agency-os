/**
 * The translation layer and the turn loop.
 *
 * Both are written as functions over data precisely so that they can be tested
 * without a model: there is no API key here and the SDK has no mock transport,
 * so anything tangled into the live loop would be untestable. The mapper takes
 * recorded message shapes; the turn loop takes an injected `query`.
 *
 * The turn's contract matches the gate's: **it always ends.** Well, badly,
 * early, or because someone stopped it — but a turn that simply stops
 * producing events leaves a spinner that never resolves.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '@agency/core'
import { displayNameFor, mapSdkMessage, type MapContext } from '../src/chat/map-sdk.js'

const ctx: MapContext = {
  costSeenUsd: 0,
  usd: (n) => n.toFixed(6),
  sessionCostUsd: (n) => n.toFixed(6),
}

const kinds = (msg: SDKMessage, c: MapContext = ctx) => mapSdkMessage(msg, c).map((e) => e.kind)

describe('mapping SDK messages to wire events', () => {
  const delta = (text: string, parent: string | null = null) =>
    ({
      type: 'stream_event',
      parent_tool_use_id: parent,
      uuid: 'u1',
      session_id: 's1',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    }) as unknown as SDKMessage

  it('turns a text delta into a text event', () => {
    const [event] = mapSdkMessage(delta('hello'), ctx)
    expect(event).toMatchObject({ kind: 'text_delta', text: 'hello', blockIndex: 0 })
  })

  /**
   * A subagent narrating its own work would interleave two voices into one
   * answer. Its tool calls still surface; its prose does not.
   */
  it('drops a subagent’s narration', () => {
    expect(kinds(delta('thinking…', 'toolu_parent'))).toEqual([])
  })

  it('ignores stream events that are not text', () => {
    const ping = {
      type: 'stream_event', parent_tool_use_id: null, uuid: 'u', session_id: 's',
      event: { type: 'message_start' },
    } as unknown as SDKMessage
    expect(kinds(ping)).toEqual([])
  })

  const assistant = (blocks: unknown[]) =>
    ({
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: 'u2',
      session_id: 's1',
      message: { id: 'msg_1', content: blocks },
    }) as unknown as SDKMessage

  /**
   * The deltas already carried the text. Emitting it again from the complete
   * message paints the answer twice.
   */
  it('closes the block without re-emitting the text as a delta', () => {
    expect(kinds(assistant([{ type: 'text', text: 'hello' }]))).toEqual(['message_complete'])
  })

  it('surfaces each tool call with the risk the gate will apply', () => {
    const events = mapSdkMessage(
      assistant([
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'toolu_a', name: 'mcp__agency__search_companies', input: { limit: 3 } },
        { type: 'tool_use', id: 'toolu_b', name: 'mcp__agency__queue_touch', input: { channel: 'email' } },
      ]),
      ctx,
    )
    expect(events.map((e) => e.kind)).toEqual(['message_complete', 'tool_call', 'tool_call'])
    expect(events[1]).toMatchObject({ toolUseId: 'toolu_a', risk: 'low', displayName: 'Search companies' })
    expect(events[2]).toMatchObject({ toolUseId: 'toolu_b', risk: 'high' })
  })

  it('marks a call that came from a subagent, so the card can say so', () => {
    const fromSub = {
      type: 'assistant', parent_tool_use_id: 'toolu_parent', uuid: 'u', session_id: 's',
      message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'mcp__agency__get_icp', input: {} }] },
    } as unknown as SDKMessage
    const call = mapSdkMessage(fromSub, ctx).find((e) => e.kind === 'tool_call')
    expect(call).toMatchObject({ agentId: 'toolu_parent' })
  })

  it('caps a huge tool input and says it did', () => {
    const big = { blob: 'x'.repeat(20_000) }
    const call = mapSdkMessage(
      assistant([{ type: 'tool_use', id: 't', name: 'mcp__agency__get_icp', input: big }]),
      ctx,
    ).find((e) => e.kind === 'tool_call')
    expect(call).toMatchObject({ inputTruncated: true })
  })

  it('pairs a tool result with the call it answers', () => {
    const result = {
      type: 'user', parent_tool_use_id: null, uuid: 'u', session_id: 's',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', is_error: false, content: 'rentman.io 77/100\nmore' },
        ],
      },
    } as unknown as SDKMessage
    const [event] = mapSdkMessage(result, ctx)
    expect(event).toMatchObject({ kind: 'tool_result', toolUseId: 'toolu_a', ok: true })
    expect((event as { summary: string }).summary).toBe('rentman.io 77/100')
  })

  it('marks a failed tool as failed', () => {
    const failed = {
      type: 'user', parent_tool_use_id: null, uuid: 'u', session_id: 's',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'not_found: no' }] },
    } as unknown as SDKMessage
    expect(mapSdkMessage(failed, ctx)[0]).toMatchObject({ ok: false })
  })

  const result = (over: Record<string, unknown> = {}) =>
    ({
      type: 'result', subtype: 'success', session_id: 'sdk-1',
      total_cost_usd: 0.05, num_turns: 3,
      usage: { input_tokens: 1200, output_tokens: 340 },
      ...over,
    }) as unknown as SDKMessage

  it('reports the cost and finishes', () => {
    const events = mapSdkMessage(result(), ctx)
    expect(events.map((e) => e.kind)).toEqual(['cost', 'turn_finished'])
    expect(events[0]).toMatchObject({ turnCostUsd: '0.050000', numTurns: 3, tokensIn: 1200 })
    expect(events[1]).toMatchObject({ reason: 'success', sdkSessionId: 'sdk-1' })
  })

  /**
   * total_cost_usd is documented as cumulative: "each result carries the
   * running total so far". Treating it as a per-turn figure bills a long
   * conversation several times over.
   */
  it('reports the turn cost as a delta, not the running total', () => {
    const events = mapSdkMessage(result({ total_cost_usd: 0.08 }), { ...ctx, costSeenUsd: 0.05 })
    expect(events[0]).toMatchObject({ turnCostUsd: '0.030000' })
  })

  it('never reports a negative cost, whatever the SDK says', () => {
    const events = mapSdkMessage(result({ total_cost_usd: 0 }), { ...ctx, costSeenUsd: 0.05 })
    expect(events[0]).toMatchObject({ turnCostUsd: '0.000000' })
  })

  it.each([
    ['error_max_turns', 'max_turns'],
    ['error_max_budget_usd', 'max_budget'],
    ['error_during_execution', 'error'],
    ['success', 'success'],
  ])('maps the %s result to %s', (subtype, reason) => {
    const events = mapSdkMessage(result({ subtype }), ctx)
    expect(events[1]).toMatchObject({ reason })
  })

  /**
   * The SDK's message union has thirty-odd members and gains more. A turn must
   * not die because a new status frame appeared.
   */
  it('ignores the many frame kinds the chat does not render', () => {
    for (const type of ['system', 'status', 'hook_started', 'task_started', 'rate_limit', 'auth_status']) {
      expect(kinds({ type } as unknown as SDKMessage), type).toEqual([])
    }
  })
})

describe('displayNameFor', () => {
  it.each([
    ['mcp__agency__search_companies', 'Search companies'],
    ['mcp__apollo__find_people', 'Find people'],
    ['Agent', 'Agent'],
  ])('renders %s as %s', (name, expected) => {
    expect(displayNameFor(name)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------

describe('a turn always ends', () => {
  /**
   * The loop is exercised with an injected `query`, because the real one needs
   * a model. What is being asserted is the SHAPE of the turn — one
   * turn_finished on every path, the claim released, the spinner stopped —
   * which is exactly the part that does not depend on what the model said.
   */
  const collect = async (events: AsyncGenerator<ChatEvent, void>) => {
    const out: ChatEvent[] = []
    for await (const e of events) out.push(e)
    return out
  }

  const baseDeps = (over: Record<string, unknown> = {}) => ({
    orgId: 'org-1',
    sessionId: 'session-1',
    userId: 'user-1',
    turnId: 'turn-1',
    claim: async () => true,
    release: async () => {},
    sessionCostSoFar: async () => 0,
    sessionBudgetUsd: 20,
    persist: async () => {},
    setSdkSessionId: async () => {},
    usd: (n: number) => n.toFixed(6),
    now: () => new Date('2026-09-13T00:00:00.000Z'),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  })

  it('refuses a second concurrent turn on one conversation, and still ends', async () => {
    const { startTurn } = await import('../src/chat/turn.js')
    const turn = startTurn(baseDeps({ claim: async () => false }) as never, {
      text: 'hello',
      options: {} as never,
      abort: new AbortController(),
      timeoutMs: 1000,
    })
    const events = await collect(turn.events())
    expect(events.map((e) => e.kind)).toEqual(['error', 'turn_finished'])
    expect(events.at(-1)).toMatchObject({ reason: 'error' })
  })

  /**
   * maxTurns and maxBudgetUsd bound ONE turn. Nothing bounds a person who
   * keeps typing, so twenty $2 turns in an hour is within every SDK limit.
   */
  it('refuses once the conversation has spent its budget, and says so plainly', async () => {
    const { startTurn } = await import('../src/chat/turn.js')
    const released = vi.fn(async () => {})
    const turn = startTurn(
      baseDeps({ sessionCostSoFar: async () => 25, sessionBudgetUsd: 20, release: released }) as never,
      { text: 'hello', options: {} as never, abort: new AbortController(), timeoutMs: 1000 },
    )
    const events = await collect(turn.events())
    expect(events[0]).toMatchObject({ kind: 'error', code: 'session_budget_exceeded' })
    expect(events.at(-1)).toMatchObject({ kind: 'turn_finished', reason: 'session_budget' })
    // The claim was taken, so it has to be given back even on this path.
    expect(released).toHaveBeenCalled()
  })

  it('releases the conversation claim even when the turn throws', async () => {
    vi.resetModules()
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => {
        throw new Error('the model exploded')
      },
    }))
    const { startTurn } = await import('../src/chat/turn.js')
    const released = vi.fn(async () => {})
    const turn = startTurn(baseDeps({ release: released }) as never, {
      text: 'hello',
      options: {} as never,
      abort: new AbortController(),
      timeoutMs: 1000,
    })
    const events = await collect(turn.events())
    expect(released).toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ kind: 'turn_finished', reason: 'error' })
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
    vi.resetModules()
  })

  it('emits exactly one turn_finished, whatever happened', async () => {
    vi.resetModules()
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      // eslint-disable-next-line require-yield
      query: async function* () {
        yield {
          type: 'result', subtype: 'success', session_id: 'sdk-9',
          total_cost_usd: 0.01, num_turns: 1, usage: {},
        } as unknown as SDKMessage
      },
    }))
    const { startTurn } = await import('../src/chat/turn.js')
    const turn = startTurn(baseDeps() as never, {
      text: 'hello',
      options: {} as never,
      abort: new AbortController(),
      timeoutMs: 1000,
    })
    const events = await collect(turn.events())
    expect(events.filter((e) => e.kind === 'turn_finished')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ reason: 'success', sdkSessionId: 'sdk-9' })
    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
    vi.resetModules()
  })

  it('numbers events monotonically, so a reconnect can say where it got to', async () => {
    const { startTurn } = await import('../src/chat/turn.js')
    const turn = startTurn(baseDeps({ claim: async () => false }) as never, {
      text: 'hello',
      options: {} as never,
      abort: new AbortController(),
      timeoutMs: 1000,
    })
    const events = await collect(turn.events())
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  })

  /**
   * A browser that vanished mid-turn must not stall work that costs money and
   * is already running. Persisting is best-effort for the same reason.
   */
  it('finishes even when every persist fails', async () => {
    const { startTurn } = await import('../src/chat/turn.js')
    const turn = startTurn(
      baseDeps({
        claim: async () => false,
        persist: async () => {
          throw new Error('database gone')
        },
      }) as never,
      { text: 'hello', options: {} as never, abort: new AbortController(), timeoutMs: 1000 },
    )
    const events = await collect(turn.events())
    expect(events.at(-1)).toMatchObject({ kind: 'turn_finished' })
  })
})
