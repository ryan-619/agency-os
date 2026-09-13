import {
  parseChatEvent, type ChatErrorCode, type ChatEvent, type Risk, type TurnEndReason,
} from '@agency/core'

/**
 * Turning a stream of events into something a person can read.
 *
 * Kept as a pure reducer, apart from the component, for the same reason the
 * SDK mapper is pure on the worker side: this is where the ordering bugs live,
 * and a reducer can be reasoned about and tested where a component full of
 * `useState` cannot. No DOM test environment is installed in this repo, so a
 * component test would need a new dependency and a decision nobody has made —
 * a pure function needs neither.
 *
 * The §2.2 rule applies here too, at the last possible moment. A finding whose
 * `observed` is false must never be rendered as a gap, and the tools already
 * drop those before the model sees them. This drops them again. CLAUDE.md is
 * explicit about why one guard has never been enough in this codebase.
 */

export interface TextBlock {
  readonly kind: 'text'
  readonly id: string
  readonly role: 'user' | 'assistant'
  text: string
  /** False once `message_complete` closes it, so the caret can stop blinking. */
  streaming: boolean
}

export interface ToolBlock {
  readonly kind: 'tool'
  readonly id: string
  readonly toolUseId: string
  readonly toolName: string
  readonly displayName: string
  readonly risk: Risk
  readonly input: unknown
  readonly inputTruncated: boolean
  /** Non-null when a subagent made the call. */
  readonly agentId: string | null
  status: 'running' | 'ok' | 'failed'
  summary: string
  detail: unknown
  detailTruncated: boolean
  durationMs: number
}

export interface ApprovalBlock {
  readonly kind: 'approval'
  readonly id: string
  readonly approvalId: string
  readonly toolUseId: string
  readonly toolName: string
  /** NOT truncated: a person has to see exactly what they are approving. */
  readonly payload: unknown
  readonly risk: Risk
  readonly explain: string
  readonly expiresAt: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  decidedByEmail: string | null
  reason: string | null
}

export interface NoticeBlock {
  readonly kind: 'notice'
  readonly id: string
  readonly tone: 'info' | 'error'
  readonly code: ChatErrorCode
  readonly text: string
  readonly retryable: boolean
}

export type Block = TextBlock | ToolBlock | ApprovalBlock | NoticeBlock

export interface ChatState {
  readonly blocks: readonly Block[]
  readonly running: boolean
  readonly turnId: string | null
  readonly endedBecause: TurnEndReason | null
  readonly turnCostUsd: string | null
  readonly sessionCostUsd: string | null
  /** The highest seq seen, so a reconnect can say where it got to. */
  readonly lastSeq: number
}

export const emptyChat: ChatState = {
  blocks: [],
  running: false,
  turnId: null,
  endedBecause: null,
  turnCostUsd: null,
  sessionCostUsd: null,
  lastSeq: 0,
}

/** What a turn ending means, in words rather than an enum. */
export function endedMessage(reason: TurnEndReason): string | null {
  switch (reason) {
    case 'success':
      return null
    case 'max_turns':
      return 'The agent reached its step limit for one question. Ask for something narrower.'
    case 'max_budget':
      return 'This question reached its spending limit before it finished.'
    case 'session_budget':
      return 'This conversation has reached its spending limit. Start a new one to continue.'
    case 'interrupted':
      return 'Stopped.'
    case 'turn_timeout':
      return 'The agent ran out of time and was stopped. Nothing further was done.'
    case 'halted':
      return 'The agent runtime has stopped. Tell an owner before using chat again.'
    default:
      return 'The agent stopped before finishing. Nothing further was done.'
  }
}

function replace(blocks: readonly Block[], id: string, next: Block): Block[] {
  return blocks.map((b) => (b.id === id ? next : b))
}

export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  // Out-of-order or replayed frames are dropped rather than applied twice. A
  // reconnect replays from the last seq, and the edge of that window overlaps.
  if (event.seq <= state.lastSeq && event.kind !== 'turn_started') return state
  const s = { ...state, lastSeq: Math.max(state.lastSeq, event.seq) }

  switch (event.kind) {
    case 'turn_started':
      return { ...s, running: true, turnId: event.turnId, endedBecause: null, turnCostUsd: null }

    case 'text_delta': {
      const last = s.blocks[s.blocks.length - 1]
      if (last?.kind === 'text' && last.role === 'assistant' && last.streaming) {
        return {
          ...s,
          blocks: replace(s.blocks, last.id, { ...last, text: last.text + event.text }),
        }
      }
      return {
        ...s,
        blocks: [
          ...s.blocks,
          {
            kind: 'text',
            id: `${event.turnId}:text:${event.blockIndex}:${event.seq}`,
            role: 'assistant',
            text: event.text,
            streaming: true,
          },
        ],
      }
    }

    case 'message_complete': {
      // Closes the streaming block. The text is NOT taken from here — the
      // deltas already delivered it, and using both would double it.
      const open = [...s.blocks].reverse().find((b) => b.kind === 'text' && b.streaming) as
        | TextBlock
        | undefined
      if (!open) return s
      return { ...s, blocks: replace(s.blocks, open.id, { ...open, streaming: false }) }
    }

    case 'tool_call':
      return {
        ...s,
        blocks: [
          ...s.blocks,
          {
            kind: 'tool',
            id: `tool:${event.toolUseId}`,
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            displayName: event.displayName,
            risk: event.risk,
            input: event.input,
            inputTruncated: event.inputTruncated,
            agentId: event.agentId,
            status: 'running',
            summary: '',
            detail: null,
            detailTruncated: false,
            durationMs: 0,
          },
        ],
      }

    case 'tool_result': {
      const block = s.blocks.find(
        (b) => b.kind === 'tool' && b.toolUseId === event.toolUseId,
      ) as ToolBlock | undefined
      if (!block) return s
      return {
        ...s,
        blocks: replace(s.blocks, block.id, {
          ...block,
          status: event.ok ? 'ok' : 'failed',
          summary: event.summary,
          detail: event.detail,
          detailTruncated: event.detailTruncated,
          durationMs: event.durationMs,
        }),
      }
    }

    case 'approval_requested':
      return {
        ...s,
        blocks: [
          ...s.blocks,
          {
            kind: 'approval',
            id: `approval:${event.approvalId}`,
            approvalId: event.approvalId,
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            payload: event.payload,
            risk: event.risk,
            explain: event.explain,
            expiresAt: event.expiresAt,
            status: 'pending',
            decidedByEmail: null,
            reason: null,
          },
        ],
      }

    case 'approval_resolved': {
      const block = s.blocks.find(
        (b) => b.kind === 'approval' && b.approvalId === event.approvalId,
      ) as ApprovalBlock | undefined
      if (!block) return s
      return {
        ...s,
        blocks: replace(s.blocks, block.id, {
          ...block,
          status: event.status,
          decidedByEmail: event.decidedByEmail,
          reason: event.reason,
        }),
      }
    }

    case 'cost':
      return { ...s, turnCostUsd: event.turnCostUsd, sessionCostUsd: event.sessionCostUsd }

    case 'turn_finished': {
      const note = endedMessage(event.reason)
      return {
        ...s,
        running: false,
        endedBecause: event.reason,
        blocks: note
          ? [
              ...s.blocks,
              {
                kind: 'notice',
                id: `${event.turnId}:end`,
                tone: event.reason === 'interrupted' ? 'info' : 'error',
                code: 'internal',
                text: note,
                retryable: event.reason !== 'session_budget' && event.reason !== 'halted',
              },
            ]
          : s.blocks,
      }
    }

    case 'notice':
    case 'error':
      return {
        ...s,
        blocks: [
          ...s.blocks,
          {
            kind: 'notice',
            id: `${event.turnId}:${event.kind}:${event.seq}`,
            tone: event.kind === 'error' ? 'error' : 'info',
            code: event.code,
            text: event.message,
            retryable: event.kind === 'error' ? event.retryable : false,
          },
        ],
      }

    case 'heartbeat':
      return s

    default:
      return s
  }
}

/** The person's own message, added locally so it appears the instant they send. */
export function withUserMessage(state: ChatState, text: string): ChatState {
  return {
    ...state,
    blocks: [
      ...state.blocks,
      { kind: 'text', id: `user:${state.blocks.length}:${text.length}`, role: 'user', text, streaming: false },
    ],
  }
}

/**
 * Parse one SSE `data:` line into an event, or null.
 *
 * Never throws. A deployed page and a redeployed worker can disagree for as
 * long as one tab stays open, and the useful behaviour then is to skip the
 * frame rather than to break the transcript that is already on screen.
 */
export function parseFrame(data: string): ChatEvent | null {
  try {
    return parseChatEvent(JSON.parse(data))
  } catch {
    return null
  }
}
