/**
 * SDK messages in, wire events out (PROMPT.md §5.2).
 *
 * A pure function, deliberately. There is no API key in this environment and
 * the SDK ships no mock transport, so the only way the translation layer gets
 * tested at all is if it is a function over recorded message shapes rather
 * than something tangled into the loop that produces them. Hand it a message,
 * get events; the turn runner does the I/O.
 *
 * Two shapes here are easy to get wrong and both show up as a visible bug:
 *
 *  - **Deltas and the complete message would double-render.** The SDK streams
 *    `text_delta` events and then delivers the finished `SDKAssistantMessage`
 *    carrying the same text. Emitting text from both paints the answer twice.
 *    Deltas carry the text; the complete message carries only its id and the
 *    tool calls, and the browser uses it to close the block.
 *  - **`total_cost_usd` is CUMULATIVE**, documented as "each result carries
 *    the running total so far, so read the latest result rather than summing
 *    across results". Adding them up across turns multiplies the bill.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  classifyRisk, truncateJson, type ChatEventBody, type TurnEndReason,
} from '@agency/core'

/** Tool input and result bodies are capped; an approval payload never is. */
export const WIRE_BUDGET_BYTES = 8 * 1024

export interface MapContext {
  /** Cumulative cost already seen this session, so the turn cost is a delta. */
  readonly costSeenUsd: number
  /** Formats money as a string, matching the numeric column. */
  readonly usd: (n: number) => string
  /** The running session total, including this turn. */
  readonly sessionCostUsd: (turnUsd: number) => string
}

/** A friendlier label than `mcp__agency__search_companies` for a card header. */
export function displayNameFor(toolName: string): string {
  const bare = toolName.startsWith('mcp__') ? (toolName.split('__')[2] ?? toolName) : toolName
  return bare.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function endReasonFor(subtype: string): TurnEndReason {
  switch (subtype) {
    case 'success':
      return 'success'
    case 'error_max_turns':
      return 'max_turns'
    case 'error_max_budget_usd':
      return 'max_budget'
    default:
      return 'error'
  }
}

interface ContentBlock {
  readonly type?: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
  readonly tool_use_id?: string
  readonly is_error?: boolean
  readonly content?: unknown
}

/** The first line of a tool result, for the collapsed card. */
function summarise(content: unknown): string {
  if (typeof content === 'string') return content.split('\n')[0]?.slice(0, 200) ?? ''
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (typeof block?.text === 'string') return block.text.split('\n')[0]?.slice(0, 200) ?? ''
    }
  }
  return ''
}

/**
 * Translate one SDK message.
 *
 * Returns an array because one message can be several events — an assistant
 * message with two tool calls is one `message_complete` and two `tool_call`s —
 * and an empty array for the many message kinds the chat does not render.
 * Unknown kinds are dropped rather than throwing: the SDK's message union has
 * thirty-odd members and gains more, and a turn must not die because a new
 * status frame appeared.
 */
export function mapSdkMessage(msg: SDKMessage, ctx: MapContext): ChatEventBody[] {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event as { type?: string; index?: number; delta?: { type?: string; text?: string } }
      // Only the main thread's text. A subagent's narration would interleave
      // two voices into one answer.
      if (msg.parent_tool_use_id !== null) return []
      if (event?.type !== 'content_block_delta') return []
      if (event.delta?.type !== 'text_delta') return []
      const text = event.delta.text ?? ''
      if (!text) return []
      return [{ kind: 'text_delta', blockIndex: event.index ?? 0, text }]
    }

    case 'assistant': {
      const message = msg.message as unknown as { id?: string; content?: ContentBlock[] }
      const blocks = message?.content ?? []
      const out: ChatEventBody[] = []

      // No text here: the deltas above already carried it. This closes the
      // block and gives the browser a stable id for the finished message.
      out.push({
        kind: 'message_complete',
        messageId: message?.id ?? msg.uuid,
        text: blocks
          .filter((b) => b?.type === 'text')
          .map((b) => b.text ?? '')
          .join(''),
      })

      for (const block of blocks) {
        if (block?.type !== 'tool_use') continue
        const toolName = block.name ?? ''
        const verdict = classifyRisk({
          toolName,
          input: (block.input ?? {}) as Record<string, unknown>,
          agentId: msg.parent_tool_use_id,
        })
        const [input, inputTruncated] = truncateJson(block.input ?? {}, WIRE_BUDGET_BYTES)
        out.push({
          kind: 'tool_call',
          toolUseId: block.id ?? '',
          toolName,
          displayName: displayNameFor(toolName),
          input,
          inputTruncated,
          risk: verdict.risk,
          riskRule: verdict.rule,
          // Non-null means a subagent made this call, which the card shows so
          // a person can tell delegated work from the main thread.
          agentId: msg.parent_tool_use_id,
        })
      }
      return out
    }

    case 'user': {
      const message = msg.message as unknown as { content?: ContentBlock[] | string }
      const blocks = Array.isArray(message?.content) ? message.content : []
      const out: ChatEventBody[] = []
      for (const block of blocks) {
        if (block?.type !== 'tool_result') continue
        const [detail, detailTruncated] = truncateJson(block.content ?? null, WIRE_BUDGET_BYTES)
        out.push({
          kind: 'tool_result',
          toolUseId: block.tool_use_id ?? '',
          ok: block.is_error !== true,
          summary: summarise(block.content),
          detail,
          detailTruncated,
          // The SDK does not report per-tool duration on this frame; the turn
          // runner fills it in from its own clock, and 0 means unknown rather
          // than instantaneous.
          durationMs: 0,
        })
      }
      return out
    }

    case 'result': {
      const result = msg as unknown as {
        subtype: string
        session_id: string
        total_cost_usd?: number
        num_turns?: number
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      // A DELTA, not the raw value. Phase 2 runs one query() per turn so the
      // two are usually the same, but the documented shape is cumulative and
      // a resumed session that carried a total forward would bill it twice.
      const turnUsd = Math.max(0, (result.total_cost_usd ?? 0) - ctx.costSeenUsd)
      return [
        {
          kind: 'cost',
          turnCostUsd: ctx.usd(turnUsd),
          sessionCostUsd: ctx.sessionCostUsd(turnUsd),
          numTurns: result.num_turns ?? 0,
          tokensIn: result.usage?.input_tokens ?? 0,
          tokensOut: result.usage?.output_tokens ?? 0,
        },
        {
          kind: 'turn_finished',
          reason: endReasonFor(result.subtype),
          sdkSessionId: result.session_id ?? null,
        },
      ]
    }

    default:
      // Every other frame kind — status, hook, task, compaction, retry. The
      // union has thirty-odd members and gains more; a turn must not die
      // because a new one appeared.
      return []
  }
}
