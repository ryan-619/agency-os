/**
 * One agent turn, start to finish (PROMPT.md §5.1, §5.2, §5.3).
 *
 * The shape of this file is dictated by one requirement: a turn must always
 * END. It can end well, badly, early, or because someone stopped it, but a
 * turn that simply stops producing events leaves a browser showing a spinner
 * that never resolves — and that is indistinguishable from the model thinking.
 * So the loop is wrapped, the finish is in a `finally`, and the session claim
 * is released on every path including a crash.
 *
 * Everything the browser sees passes through `emit`, which stamps the sequence
 * number. Everything worth keeping is written to `chat_messages` as it
 * happens, so a reattaching browser can rebuild the conversation from the
 * database rather than from a buffer the worker may have lost.
 */
import { randomUUID } from 'node:crypto'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatEventBody, TurnEndReason } from '@agency/core'
import { mapSdkMessage, type MapContext } from './map-sdk.js'

export interface TurnDeps {
  readonly orgId: string
  readonly sessionId: string
  readonly userId: string
  readonly turnId: string
  /** Claim the thread. False when another turn already holds it. */
  readonly claim: () => Promise<boolean>
  readonly release: () => Promise<void>
  /** What this session has cost so far, before this turn. */
  readonly sessionCostSoFar: () => Promise<number>
  readonly sessionBudgetUsd: number
  readonly persist: (event: ChatEvent) => Promise<void>
  readonly setSdkSessionId: (id: string) => Promise<void>
  readonly usd: (n: number) => string
  readonly now: () => Date
  readonly log: {
    info: (msg: string, fields?: Record<string, unknown>) => void
    warn: (msg: string, fields?: Record<string, unknown>) => void
    error: (msg: string, fields?: Record<string, unknown>) => void
  }
}

export interface TurnRequest {
  readonly text: string
  readonly options: Options
  readonly abort: AbortController
  /** Wall clock for the whole turn. Must exceed the approval TTL. */
  readonly timeoutMs: number
}

export interface RunningTurn {
  readonly turnId: string
  /** Every event, in order. Ends after `turn_finished`. */
  events(): AsyncGenerator<ChatEvent, void>
  /** Stop the turn. The generator still finishes cleanly. */
  interrupt(): void
  /**
   * Push an event from outside the SDK loop.
   *
   * The approval gate produces cards while the turn is mid-flight, and it is
   * built BEFORE the turn exists — it closes over the turn id, which is what
   * the approval rows are keyed on. So the gate is handed a deferred emitter
   * that forwards here once there is a turn to forward to, and the card
   * appears in the stream exactly where the pause happened.
   */
  emit(body: ChatEventBody): void
}

/**
 * An emitter that can be handed out before its destination exists.
 *
 * Buffers until bound, then forwards. Nothing is lost in the window between
 * building the gate and starting the turn, which is where a synchronous gate
 * failure would otherwise vanish.
 */
export interface DeferredEmitter {
  emit(body: ChatEventBody): void
  bind(sink: (body: ChatEventBody) => void): void
}

export function createDeferredEmitter(): DeferredEmitter {
  const buffered: ChatEventBody[] = []
  let sink: ((body: ChatEventBody) => void) | null = null
  return {
    emit(body) {
      if (sink) sink(body)
      else buffered.push(body)
    },
    bind(next) {
      sink = next
      while (buffered.length > 0) next(buffered.shift()!)
    },
  }
}

/**
 * A queue one producer writes and one consumer reads.
 *
 * The SDK loop and the HTTP response run at different speeds: the model can
 * produce a hundred deltas while a browser is mid-reconnect. Buffering here
 * rather than awaiting the consumer means a slow or vanished reader cannot
 * stall the turn — the turn is doing real work with real money attached and
 * has to finish whether anyone is watching or not.
 */
class EventQueue {
  private readonly buffer: ChatEvent[] = []
  private waiting: (() => void) | null = null
  private closed = false

  push(event: ChatEvent): void {
    if (this.closed) return
    this.buffer.push(event)
    this.waiting?.()
    this.waiting = null
  }

  close(): void {
    this.closed = true
    this.waiting?.()
    this.waiting = null
  }

  async *drain(): AsyncGenerator<ChatEvent, void> {
    for (;;) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiting = resolve
      })
    }
  }
}

export function startTurn(deps: TurnDeps, req: TurnRequest): RunningTurn {
  const queue = new EventQueue()
  let seq = 0
  let costSeenUsd = 0
  let sessionCostBefore = 0

  const stamp = (body: ChatEventBody): ChatEvent =>
    ({
      ...body,
      seq: (seq += 1),
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      at: deps.now().toISOString(),
    }) as ChatEvent

  const emit = (body: ChatEventBody): ChatEvent => {
    const event = stamp(body)
    queue.push(event)
    // Persisting is best-effort and must never stop the turn: a failed insert
    // costs the reattach path a frame, a thrown one costs the whole answer.
    void deps.persist(event).catch((err: unknown) => {
      deps.log.warn('could not persist a chat event', {
        kind: event.kind,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    })
    return event
  }

  const mapCtx: MapContext = {
    get costSeenUsd() {
      return costSeenUsd
    },
    usd: deps.usd,
    sessionCostUsd: (turnUsd) => deps.usd(sessionCostBefore + turnUsd),
  }

  const run = async (): Promise<void> => {
    let reason: TurnEndReason = 'error'
    let sdkSessionId: string | null = null
    let claimed = false
    // Whether the turn has already told the user WHY it is failing. The SDK
    // reports a refusal on the assistant message — "the account has no credit"
    // — and then the iteration throws. Emitting a second, generic "stopped
    // unexpectedly, try again" on top of that reads as two separate problems
    // and the advice contradicts the first message.
    let explained = false
    const timer = setTimeout(() => {
      deps.log.warn('turn timed out', { turnId: deps.turnId })
      req.abort.abort()
    }, req.timeoutMs)

    try {
      // Claim the thread. Two browser tabs starting a turn on one conversation
      // would interleave two exchanges into a single SDK transcript.
      claimed = await deps.claim()
      if (!claimed) {
        emit({
          kind: 'error',
          code: 'internal',
          retryable: true,
          message: 'Another turn is already running in this conversation. Wait for it to finish.',
        })
        reason = 'error'
        return
      }

      // §5.4 bounds one turn with maxTurns and maxBudgetUsd, and nothing
      // bounds a person who keeps typing. One query, one refusal.
      sessionCostBefore = await deps.sessionCostSoFar()
      if (sessionCostBefore >= deps.sessionBudgetUsd) {
        emit({
          kind: 'error',
          code: 'session_budget_exceeded',
          retryable: false,
          message:
            `This conversation has reached its spending limit of $${deps.sessionBudgetUsd.toFixed(2)}. ` +
            'Start a new one to continue.',
        })
        reason = 'session_budget'
        return
      }

      emit({ kind: 'turn_started', userMessageId: randomUUID() })

      for await (const message of query({ prompt: req.text, options: req.options })) {
        for (const body of mapSdkMessage(message, mapCtx)) {
          if (body.kind === 'error') explained = true
          if (body.kind === 'turn_finished') {
            // Held back: the finish is emitted once, in the finally, so every
            // exit path produces exactly one and the browser has a single
            // thing to wait for.
            reason = body.reason
            sdkSessionId = body.sdkSessionId
            continue
          }
          if (body.kind === 'cost') {
            costSeenUsd += Number.parseFloat(body.turnCostUsd)
          }
          emit(body)
        }
      }
    } catch (err) {
      if (req.abort.signal.aborted) {
        reason = 'interrupted'
      } else {
        reason = 'error'
        deps.log.error('turn failed', {
          turnId: deps.turnId,
          error: err instanceof Error ? err.name : 'UnknownError',
          alreadyExplained: explained,
        })
        if (!explained) {
          emit({
            kind: 'error',
            code: 'sdk_error',
            retryable: true,
            message: 'The agent stopped unexpectedly. Nothing further was done. Try again.',
          })
        }
      }
    } finally {
      clearTimeout(timer)
      if (sdkSessionId) {
        // §5.3: the handle the next turn resumes from.
        await deps.setSdkSessionId(sdkSessionId).catch((err: unknown) => {
          deps.log.warn('could not record the sdk session id', {
            error: err instanceof Error ? err.name : 'UnknownError',
          })
        })
      }
      if (claimed) {
        await deps.release().catch((err: unknown) => {
          deps.log.error('could not release the session claim', {
            turnId: deps.turnId,
            error: err instanceof Error ? err.name : 'UnknownError',
          })
        })
      }
      // Exactly one, on every path — including a crash, a timeout and an
      // interrupt. This is the event the browser stops spinning on.
      emit({ kind: 'turn_finished', reason, sdkSessionId })
      queue.close()
    }
  }

  void run()

  return {
    turnId: deps.turnId,
    events: () => queue.drain(),
    interrupt: () => req.abort.abort(),
    emit: (body) => {
      emit(body)
    },
  }
}
