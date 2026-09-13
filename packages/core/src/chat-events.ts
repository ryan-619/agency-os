/**
 * What the browser is told while an agent turn runs (PROMPT.md §5.2, §8.1).
 *
 * Plain types plus a hand-written parser, in the same style as
 * `parseIcpDefinition` — `packages/core` has an empty dependencies block that
 * a test enforces, so zod is not available here and the boundary is validated
 * by hand. That is a feature at this particular boundary: these types are
 * shared by the worker that produces them and the browser that renders them,
 * and a shared type both sides compile against is the cheapest way to stop a
 * rename in one from silently becoming a blank card in the other.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 *  - **Costs are strings.** `chat_messages.cost_usd` is a `numeric` column,
 *    which drizzle types as a string on the way in and the way out. Keeping
 *    the wire format a string means the figure a person reads is the figure in
 *    the database, and addition happens in Postgres rather than in a float.
 *  - **`input` and `detail` are capped; `payload` is not.** Someone approving
 *    an outbound message has to see exactly what they are approving. A
 *    truncated approval payload would make the audit trail a lie.
 *  - **Nothing on the wire is redacted.** `redact()` matches on key names and
 *    is a logging backstop, not a defence. It is applied to log lines, as it
 *    is today, and to nothing here.
 */
import type { Risk, RiskRule } from './risk.js'

/**
 * Monotonic within one chat session, assigned by the worker. Becomes the SSE
 * `id:` field, so a browser that reconnects can say where it got to — and so
 * ordering never depends on a wall clock that two processes disagree about.
 */
export type Seq = number

export interface ChatEventBase {
  readonly seq: Seq
  readonly sessionId: string
  /** One turn. Stable across SSE reconnects and page loads. */
  readonly turnId: string
  /** Worker wall clock, ISO 8601. For display only — never order by it. */
  readonly at: string
}

export type TurnEndReason =
  | 'success'
  | 'max_turns'
  | 'max_budget'
  | 'session_budget'
  | 'interrupted'
  | 'turn_timeout'
  | 'error'
  | 'halted'

export type ChatErrorCode =
  /** The SDK returned an error result. */
  | 'sdk_error'
  /** The gate could not reach a human, so the call was refused. */
  | 'gate_failed'
  /** A tool ran that the gate never saw — the gate is not live. */
  | 'bypass_detected'
  /** One tool threw. The turn continues. */
  | 'tool_failed'
  /** This turn was interrupted by a worker restart. */
  | 'worker_restart'
  | 'session_budget_exceeded'
  /** No ANTHROPIC_API_KEY, so there is no agent to talk to. */
  | 'chat_disabled'
  /**
   * The API refused for a reason a person has to fix: no credit, a rejected
   * key, an account on hold. Distinct from `sdk_error` because the useful
   * advice is different — "try again" is wrong when the balance is zero, and
   * telling someone to retry a request that cannot succeed is worse than
   * saying nothing.
   */
  | 'chat_account'
  /** Rate limited or overloaded. This one really is worth retrying. */
  | 'chat_busy'
  | 'internal'

export type ChatEvent = ChatEventBase &
  (
    | { readonly kind: 'turn_started'; readonly userMessageId: string }
    | { readonly kind: 'text_delta'; readonly blockIndex: number; readonly text: string }
    | { readonly kind: 'message_complete'; readonly messageId: string; readonly text: string }
    | {
        readonly kind: 'tool_call'
        readonly toolUseId: string
        readonly toolName: string
        readonly displayName: string
        readonly input: unknown
        readonly inputTruncated: boolean
        readonly risk: Risk
        readonly riskRule: RiskRule
        /** Non-null when the call came from a subagent (§7). */
        readonly agentId: string | null
      }
    | {
        readonly kind: 'tool_result'
        readonly toolUseId: string
        readonly ok: boolean
        /** One line, for the collapsed card. */
        readonly summary: string
        /** Already filtered for §2.2 by the tool handler. */
        readonly detail: unknown
        readonly detailTruncated: boolean
        readonly durationMs: number
      }
    | {
        readonly kind: 'approval_requested'
        readonly approvalId: string
        readonly toolUseId: string
        readonly toolName: string
        /** NOT truncated. A person has to see what they are approving. */
        readonly payload: unknown
        readonly risk: Risk
        readonly explain: string
        readonly expiresAt: string
      }
    | {
        readonly kind: 'approval_resolved'
        readonly approvalId: string
        readonly toolUseId: string
        readonly status: 'approved' | 'denied' | 'expired'
        readonly decidedByEmail: string | null
        readonly reason: string | null
      }
    | {
        readonly kind: 'cost'
        readonly turnCostUsd: string
        readonly sessionCostUsd: string
        readonly numTurns: number
        readonly tokensIn: number
        readonly tokensOut: number
      }
    | {
        readonly kind: 'turn_finished'
        readonly reason: TurnEndReason
        readonly sdkSessionId: string | null
      }
    | { readonly kind: 'notice'; readonly code: ChatErrorCode; readonly message: string }
    | {
        readonly kind: 'error'
        readonly code: ChatErrorCode
        readonly message: string
        readonly retryable: boolean
      }
    | { readonly kind: 'heartbeat' }
  )

export type ChatEventKind = ChatEvent['kind']

/**
 * One event without the fields the emitter stamps on.
 *
 * Distributive on purpose. A plain `Omit<ChatEvent, …>` collapses the union
 * into a single object carrying only the keys EVERY member shares — so
 * `approvalId` and `code` vanish and the producer cannot construct any event
 * that has them. The conditional type keeps the union intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type ChatEventBody = DistributiveOmit<ChatEvent, keyof ChatEventBase>

export const CHAT_EVENT_KINDS: readonly ChatEventKind[] = [
  'turn_started', 'text_delta', 'message_complete', 'tool_call', 'tool_result',
  'approval_requested', 'approval_resolved', 'cost', 'turn_finished', 'notice',
  'error', 'heartbeat',
]

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * One SSE frame.
 *
 * `id:` carries the sequence number so a reconnecting browser can send
 * `Last-Event-ID` and be given only what it missed. `event:` carries the kind
 * so a client can attach listeners per kind rather than switching on a parsed
 * body.
 *
 * Newlines in the JSON would split the frame, so the payload is serialised
 * without them — `JSON.stringify` already escapes newlines inside strings, and
 * no indentation is added.
 */
export function encodeSse(event: ChatEvent): string {
  const data = JSON.stringify(event)
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${data}\n\n`
}

/**
 * A comment frame. Proxies and load balancers drop an idle connection, and an
 * agent thinking for ninety seconds looks exactly like an idle connection.
 */
export const SSE_KEEPALIVE = ': keepalive\n\n'

/**
 * Cap a value's JSON at `maxBytes`, reporting whether anything was dropped.
 *
 * Returns a REPLACEMENT rather than a truncated JSON string, because half a
 * JSON document is not a JSON document and the browser has to parse this. The
 * flag is rendered next to the value, so a reader can tell the difference
 * between "this is all of it" and "this is the start of it".
 */
export function truncateJson(value: unknown, maxBytes: number): readonly [unknown, boolean] {
  let json: string
  try {
    json = JSON.stringify(value) ?? 'null'
  } catch {
    return ['[unserialisable]', true]
  }
  // TextEncoder, not Buffer.byteLength: this module is imported by the browser
  // as well as the worker, and Buffer is a Node global. The function is only
  // ever CALLED on the server, but a build that inlines it would break the
  // page, and that is not a failure worth discovering in production.
  if (UTF8.encode(json).byteLength <= maxBytes) return [value, false]
  return [`${json.slice(0, maxBytes)}…`, true]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const UTF8 = new TextEncoder()

function fail(field: string, why: string): never {
  throw new Error(`Invalid chat event: ${field} ${why}`)
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string') fail(key, 'must be a string')
  return v as string
}

function optStr(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') fail(key, 'must be a string or null')
  return v as string
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(key, 'must be a finite number')
  return v as number
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key]
  if (typeof v !== 'boolean') fail(key, 'must be a boolean')
  return v as boolean
}

/**
 * Narrow an unknown frame to a ChatEvent, or explain why not.
 *
 * The browser parses what the worker sent, so this is not a security boundary
 * — it is a version boundary. A deployed page and a redeployed worker can
 * disagree for as long as one tab stays open, and the useful behaviour then is
 * a named error rather than a card rendering `undefined`.
 */
export function parseChatEvent(value: unknown): ChatEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid chat event: not an object')
  }
  const o = value as Record<string, unknown>
  const kind = str(o, 'kind')
  const base = {
    seq: num(o, 'seq'),
    sessionId: str(o, 'sessionId'),
    turnId: str(o, 'turnId'),
    at: str(o, 'at'),
  }

  switch (kind) {
    case 'turn_started':
      return { ...base, kind, userMessageId: str(o, 'userMessageId') }
    case 'text_delta':
      return { ...base, kind, blockIndex: num(o, 'blockIndex'), text: str(o, 'text') }
    case 'message_complete':
      return { ...base, kind, messageId: str(o, 'messageId'), text: str(o, 'text') }
    case 'tool_call':
      return {
        ...base, kind,
        toolUseId: str(o, 'toolUseId'),
        toolName: str(o, 'toolName'),
        displayName: str(o, 'displayName'),
        input: o['input'],
        inputTruncated: bool(o, 'inputTruncated'),
        risk: str(o, 'risk') as Risk,
        riskRule: str(o, 'riskRule') as RiskRule,
        agentId: optStr(o, 'agentId'),
      }
    case 'tool_result':
      return {
        ...base, kind,
        toolUseId: str(o, 'toolUseId'),
        ok: bool(o, 'ok'),
        summary: str(o, 'summary'),
        detail: o['detail'],
        detailTruncated: bool(o, 'detailTruncated'),
        durationMs: num(o, 'durationMs'),
      }
    case 'approval_requested':
      return {
        ...base, kind,
        approvalId: str(o, 'approvalId'),
        toolUseId: str(o, 'toolUseId'),
        toolName: str(o, 'toolName'),
        payload: o['payload'],
        risk: str(o, 'risk') as Risk,
        explain: str(o, 'explain'),
        expiresAt: str(o, 'expiresAt'),
      }
    case 'approval_resolved': {
      const status = str(o, 'status')
      if (status !== 'approved' && status !== 'denied' && status !== 'expired') {
        fail('status', 'must be approved, denied or expired')
      }
      return {
        ...base, kind,
        approvalId: str(o, 'approvalId'),
        toolUseId: str(o, 'toolUseId'),
        status,
        decidedByEmail: optStr(o, 'decidedByEmail'),
        reason: optStr(o, 'reason'),
      }
    }
    case 'cost':
      return {
        ...base, kind,
        turnCostUsd: str(o, 'turnCostUsd'),
        sessionCostUsd: str(o, 'sessionCostUsd'),
        numTurns: num(o, 'numTurns'),
        tokensIn: num(o, 'tokensIn'),
        tokensOut: num(o, 'tokensOut'),
      }
    case 'turn_finished':
      return {
        ...base, kind,
        reason: str(o, 'reason') as TurnEndReason,
        sdkSessionId: optStr(o, 'sdkSessionId'),
      }
    case 'notice':
      return { ...base, kind, code: str(o, 'code') as ChatErrorCode, message: str(o, 'message') }
    case 'error':
      return {
        ...base, kind,
        code: str(o, 'code') as ChatErrorCode,
        message: str(o, 'message'),
        retryable: bool(o, 'retryable'),
      }
    case 'heartbeat':
      return { ...base, kind }
    default:
      throw new Error(`Invalid chat event: unknown kind "${kind}"`)
  }
}
