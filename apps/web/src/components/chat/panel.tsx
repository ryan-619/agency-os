'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyChat, parseFrame, reduceChat, withUserMessage,
  type ApprovalBlock, type Block, type ChatState, type NoticeBlock, type TextBlock, type ToolBlock,
} from './reducer'

/**
 * The chat panel (PROMPT.md §8.1).
 *
 * The only client component in the app, and it stays small: the reducer beside
 * it does the ordering, and this does the network and the markup. That split
 * is what makes the ordering testable — there is no DOM test environment
 * installed here, so anything that lives inside a component is untested by
 * construction.
 *
 * Three things §8.1 asks for explicitly, and where each is:
 *  - tool calls as collapsible cards showing name, input and result, so a
 *    person can see what the agent DID rather than only its summary;
 *  - inline approval cards with the full payload and Approve / Deny, which
 *    resolve the promise the worker is parked on;
 *  - the running cost, because "a team that cannot see cost will not trust
 *    the tool".
 */
export function ChatPanel({
  sessionId,
  agentAvailable,
  canDecide,
}: {
  sessionId: string
  agentAvailable: boolean
  canDecide: boolean
}) {
  const [state, setState] = useState<ChatState>(emptyChat)
  const [draft, setDraft] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [state.blocks.length])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || state.running) return
    setDraft('')
    setState((s) => withUserMessage({ ...s, running: true, endedBecause: null }, text))

    const ac = new AbortController()
    abortRef.current = ac

    let res: Response
    try {
      res = await fetch('/api/chat/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatSessionId: sessionId, text }),
        signal: ac.signal,
      })
    } catch {
      setState((s) => ({ ...s, running: false }))
      return
    }

    if (!res.ok || !res.body) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string }
      setState((s) => ({
        ...s,
        running: false,
        blocks: [
          ...s.blocks,
          {
            kind: 'notice',
            id: `err:${Date.now()}`,
            tone: 'error',
            code: 'internal',
            text: messageForRefusal(detail.error),
            retryable: detail.error !== 'agent_not_configured',
          } satisfies NoticeBlock,
        ],
      }))
      return
    }

    // The frames arrive as text; each is separated by a blank line and only
    // the `data:` line carries the event. A chunk can split a frame in half,
    // so the tail is carried forward rather than parsed optimistically.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          const event = parseFrame(line.slice('data: '.length))
          if (event) setState((s) => reduceChat(s, event))
        }
      }
    } catch {
      // The connection dropped. The turn is still running on the worker and
      // everything it did is in the transcript; nothing is lost but the view.
    } finally {
      setState((s) => ({ ...s, running: false }))
      abortRef.current = null
    }
  }, [draft, sessionId, state.running])

  const decide = useCallback(async (approvalId: string, decision: 'approved' | 'denied') => {
    const res = await fetch(`/api/approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
    if (res.status === 409 || res.status === 410) {
      // Someone else got there first, or it lapsed. The worker will emit the
      // resolution over the stream anyway; this just stops the buttons
      // pretending they still work.
      const detail = (await res.json().catch(() => ({}))) as { status?: string }
      setState((s) => ({
        ...s,
        blocks: s.blocks.map((b) =>
          b.kind === 'approval' && b.approvalId === approvalId
            ? { ...b, status: (detail.status as ApprovalBlock['status']) ?? 'expired' }
            : b,
        ),
      }))
    }
  }, [])

  if (!agentAvailable) {
    return (
      <div className="chat">
        <div className="note">
          <strong>The agent is not configured.</strong> Chat needs the agent worker running and
          reachable at <code>AGENT_URL</code>, with an <code>ANTHROPIC_API_KEY</code> set on it.
          Everything else in Agency OS works without it.
        </div>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {state.blocks.length === 0 ? (
          <p className="muted" style={{ fontSize: 13.5 }}>
            Ask about the companies in the CRM — what is worth working, what a company&apos;s
            posture looks like, what to say to them. The agent can read the CRM and scan public
            pages. It cannot send anything.
          </p>
        ) : null}
        {state.blocks.map((b) => (
          <BlockView key={b.id} block={b} canDecide={canDecide} onDecide={decide} />
        ))}
        <div ref={endRef} />
      </div>

      <div className="chat-bar">
        <textarea
          className="chat-input"
          value={draft}
          rows={2}
          placeholder={state.running ? 'Working…' : 'Ask about the pipeline'}
          disabled={state.running}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {state.running ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button type="button" onClick={() => void send()} disabled={!draft.trim()}>Send</button>
        )}
      </div>

      {/* §8.1: "A team that cannot see cost will not trust the tool." */}
      <div className="chat-cost">
        {state.turnCostUsd ? <span>last answer ${trim(state.turnCostUsd)}</span> : null}
        {state.sessionCostUsd ? <span>conversation ${trim(state.sessionCostUsd)}</span> : null}
      </div>
    </div>
  )
}

function trim(usd: string): string {
  const n = Number.parseFloat(usd)
  return Number.isFinite(n) ? n.toFixed(n < 0.01 ? 4 : 2) : usd
}

function messageForRefusal(code: string | undefined): string {
  switch (code) {
    case 'agent_not_configured':
      return 'The agent worker is not configured for this deployment.'
    case 'agent_unreachable':
      return 'The agent worker is not responding. Everything else still works.'
    case 'chat_disabled':
      return 'The agent worker has no API key, so it cannot answer. Everything else still works.'
    case 'runtime_halted':
      return 'The agent runtime has stopped because a tool ran that it never authorised. Tell an owner.'
    case 'no_such_conversation':
      return 'That conversation no longer exists.'
    default:
      return 'The agent could not start. Nothing was done.'
  }
}

function BlockView({
  block, canDecide, onDecide,
}: {
  block: Block
  canDecide: boolean
  onDecide: (id: string, d: 'approved' | 'denied') => Promise<void>
}) {
  if (block.kind === 'text') return <TextView block={block} />
  if (block.kind === 'tool') return <ToolCard block={block} />
  if (block.kind === 'approval') return <ApprovalCard block={block} canDecide={canDecide} onDecide={onDecide} />
  return <NoticeView block={block} />
}

function TextView({ block }: { block: TextBlock }) {
  return (
    <div className={block.role === 'user' ? 'msg msg-user' : 'msg msg-agent'}>
      {block.text}
      {block.streaming ? <span className="caret" /> : null}
    </div>
  )
}

/**
 * §8.1: "the user must be able to see what the agent actually did, not just
 * its summary". Collapsed by default because a turn can make a dozen calls,
 * but the full input and result are one click away and are never summarised
 * out of existence.
 */
function ToolCard({ block }: { block: ToolBlock }) {
  return (
    <details className={`tool tool-${block.status}`}>
      <summary>
        <span className="tool-name">{block.displayName}</span>
        {block.risk !== 'low' ? <span className="pill pill-risk">{block.risk} risk</span> : null}
        {block.agentId ? <span className="pill">subagent</span> : null}
        <span className="tool-summary">
          {block.status === 'running' ? 'working…' : block.summary || (block.status === 'failed' ? 'failed' : 'done')}
        </span>
      </summary>
      <div className="tool-body">
        <div className="tool-label">called with</div>
        <pre className="mono">{JSON.stringify(block.input, null, 2)}</pre>
        {block.inputTruncated ? <p className="muted">Input was too large to show in full.</p> : null}
        {block.status !== 'running' ? (
          <>
            <div className="tool-label">answered</div>
            <pre className="mono">{renderDetail(block.detail)}</pre>
            {block.detailTruncated ? <p className="muted">Result was too large to show in full.</p> : null}
          </>
        ) : null}
      </div>
    </details>
  )
}

function renderDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return '(nothing)'
  if (typeof detail === 'string') return detail
  return JSON.stringify(detail, null, 2)
}

/**
 * The approval card.
 *
 * The payload is rendered in FULL, never truncated: someone deciding whether a
 * message may leave the building has to see exactly what they are approving,
 * and a shortened payload would make the audit trail a lie.
 */
function ApprovalCard({
  block, canDecide, onDecide,
}: {
  block: ApprovalBlock
  canDecide: boolean
  onDecide: (id: string, d: 'approved' | 'denied') => Promise<void>
}) {
  const pending = block.status === 'pending'
  return (
    <div className={`approval approval-${block.status}`}>
      <div className="approval-head">
        <strong>The agent wants to {block.explain.replace(/\.$/, '')}</strong>
        <span className="pill pill-risk">{block.risk} risk</span>
      </div>
      <pre className="mono approval-payload">{JSON.stringify(block.payload, null, 2)}</pre>

      {pending ? (
        canDecide ? (
          <div className="approval-actions">
            <button type="button" onClick={() => void onDecide(block.approvalId, 'approved')}>
              Approve
            </button>
            <button type="button" className="deny" onClick={() => void onDecide(block.approvalId, 'denied')}>
              Deny
            </button>
            <span className="muted">
              Expires {new Date(block.expiresAt).toLocaleTimeString()}. Nothing happens until you decide.
            </span>
          </div>
        ) : (
          <p className="muted">Waiting for someone who can approve this.</p>
        )
      ) : (
        <p className="muted">
          {block.status === 'approved' ? 'Approved' : block.status === 'denied' ? 'Denied' : 'Expired'}
          {block.decidedByEmail ? ` by ${block.decidedByEmail}` : ''}
          {block.reason ? ` — ${block.reason}` : ''}
          {block.status === 'expired' ? '. Nothing was done.' : '.'}
        </p>
      )}
    </div>
  )
}

function NoticeView({ block }: { block: NoticeBlock }) {
  return (
    <div className={`note ${block.tone === 'error' ? 'note-warn' : ''}`}>
      {block.text}
      {block.retryable ? ' You can try again.' : ''}
    </div>
  )
}
