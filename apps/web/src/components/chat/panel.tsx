'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { When } from '@/components/when'
import {
  emptyChat, parseFrame, reduceChat, withUserMessage,
  type ApprovalBlock, type Block, type ChatState, type NoticeBlock, type TextBlock, type ToolBlock,
} from './reducer'

/**
 * The chat panel (PROMPT.md §8.1).
 *
 * A client component that stays small: the reducer beside it does the
 * ordering, and this does the network and the markup. That split
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
  agentMisconfigured,
  archived = false,
  canDecide,
  initialBlocks = [],
}: {
  /**
   * The thread this panel speaks in. The page renders the panel with
   * `key={sessionId}`: the conversation lives in this component's state,
   * initialised once, so moving to another thread without a remount would
   * keep showing the last one's.
   */
  sessionId: string
  agentAvailable: boolean
  /**
   * Set when chat is off because AGENT_URL or AGENT_INTERNAL_TOKEN holds a
   * value that cannot be used: the sentence naming which (agent-config.ts),
   * never the value. "Not both set" would be false of it.
   */
  agentMisconfigured?: string
  /**
   * Hidden from the thread list. Read-only here, because a turn started in a
   * thread the list does not show is a conversation its owner cannot find
   * again; putting it back in the list is one click beside it.
   */
  archived?: boolean
  canDecide: boolean
  /**
   * The conversation as it was written down, rebuilt on the server.
   *
   * Without it a reload showed an EMPTY panel while the worker resumed the SDK
   * session with the whole conversation still in the model's context — so the
   * agent remembered and the person did not, and the next answer referred to
   * things that were no longer on screen.
   */
  initialBlocks?: readonly Block[]
}) {
  const [state, setState] = useState<ChatState>(() => ({ ...emptyChat, blocks: initialBlocks }))
  const [draft, setDraft] = useState('')
  const [stopping, setStopping] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [state.blocks.length])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || state.running) return
    setDraft('')
    setStopping(false)
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
            retryable: !NOT_RETRYABLE.has(detail.error ?? ''),
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
      setStopping(false)
      abortRef.current = null
    }
  }, [draft, sessionId, state.running])

  /**
   * Stop the TURN, not just this browser's view of it.
   *
   * `AbortController.abort()` alone closes our end of the stream and leaves
   * the agent running: still calling tools, still spending against the session
   * budget, still holding the conversation claim — so the next message is
   * refused as "already running" under a panel that looks idle. The abort is
   * the fallback here, used only when the turn cannot be reached.
   *
   * On success nothing is aborted at all: the worker emits `turn_finished`
   * with reason `interrupted`, the stream ends on its own, and the person sees
   * the real ending rather than one this component invented.
   */
  const stop = useCallback(async () => {
    const turnId = state.turnId
    if (stopping) return
    setStopping(true)

    // No turn id yet means the worker has not answered the POST, so there is
    // nothing on the other side to interrupt. Dropping our own request is the
    // whole of the job.
    if (!turnId) {
      abortRef.current?.abort()
      return
    }

    let ok = false
    try {
      const res = await fetch(`/api/chat/turns/${turnId}/interrupt`, { method: 'POST' })
      ok = res.ok
    } catch {
      ok = false
    }

    if (!ok) {
      // The worker could not be reached, so the turn was NOT stopped. Close
      // our end and say so, rather than letting the panel imply otherwise.
      abortRef.current?.abort()
      setState((s) => ({
        ...s,
        blocks: [
          ...s.blocks,
          {
            kind: 'notice',
            id: `stop:${turnId}`,
            tone: 'error',
            code: 'internal',
            text:
              'Could not reach the agent to stop it, so it may still be working. ' +
              'This conversation will refuse a new message until that turn ends.',
            retryable: false,
          } satisfies NoticeBlock,
        ],
      }))
    }
  }, [state.turnId, stopping])

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

  /**
   * No worker: no composer, but the transcript still renders.
   *
   * This used to return the note alone, which threw away `initialBlocks` —
   * the server had already rebuilt every past conversation from the database
   * at `chat/page.tsx`, and this early return dropped it on the floor. The
   * effect was that losing the worker also lost READ access to work that was
   * already done: what the agent found, what it drafted, what a person
   * approved. All of it still in Postgres, all of it invisible.
   *
   * Which is backwards. The worker is needed to START a turn, not to read one
   * that finished. A deployment without a worker is the normal state of this
   * product before anybody rents a server, so that is precisely when the
   * history matters most.
   *
   * `canDecide` is passed as false: the approve/deny buttons on a parked tool
   * call resume the turn by POSTing to the worker, so offering them here
   * would be offering a button that cannot work.
   *
   * The note does not say "API key". It used to, and that sent people to buy
   * credit for a worker that can run on a developer's own login (CLAUDE.md
   * §8) — what is missing here is the WORKER, and the sentence names it.
   */
  if (!agentAvailable || archived) {
    return (
      <div className="chat">
        {state.blocks.length > 0 ? (
          <div className="chat-log">
            {state.blocks.map((b) => (
              <BlockView key={b.id} block={b} canDecide={false} onDecide={decide} />
            ))}
          </div>
        ) : null}
        {archived ? (
          <div className="note">
            <strong>This thread is archived.</strong> It is read-only while it is out of the list;
            put it back in the list to carry on the conversation.
          </div>
        ) : agentMisconfigured !== undefined ? (
          <div className="note">
            <strong>Chat is off.</strong> {agentMisconfigured} Your threads still work: you can
            start, rename and archive them now.
            {state.blocks.length > 0 ? (
              <> This conversation is shown above and is read-only until the value is corrected.</>
            ) : null}
          </div>
        ) : (
          <div className="note">
            <strong>No worker is connected.</strong> Chat needs the agent worker, which runs on an
            API key or a developer&apos;s own login, and this deployment reaches it through{' '}
            <code>AGENT_URL</code> and <code>AGENT_INTERNAL_TOKEN</code>, which are not both set
            here. Everything else in Agency OS works without it, and so do your threads: you can
            start, rename and archive them now.
            {state.blocks.length > 0 ? (
              <> This conversation is shown above and is read-only until a worker is connected.</>
            ) : null}
          </div>
        )}
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
          <button type="button" onClick={() => void stop()} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
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

/** Refusals a retry cannot change: a value in this deployment has to be. */
const NOT_RETRYABLE: ReadonlySet<string> = new Set(['agent_not_configured', 'agent_misconfigured', 'agent_token_refused'])

function messageForRefusal(code: string | undefined): string {
  switch (code) {
    case 'agent_not_configured':
      return 'The agent worker is not configured for this deployment.'
    case 'agent_misconfigured':
      return 'Chat is off: AGENT_URL or AGENT_INTERNAL_TOKEN in this deployment is not a usable value — Settings → Deployment says which. Everything else still works.'
    case 'agent_unreachable':
      return 'The agent worker is not responding — the computer running it may be off or asleep, or its tunnel is down. Everything else still works.'
    case 'agent_token_refused':
      return 'The agent worker refused this site’s token: AGENT_INTERNAL_TOKEN here is not the one the worker was started with. Everything else still works.'
    case 'chat_disabled':
      return 'The agent worker is running but cannot reach a model: it has neither an API key nor a developer login. Everything else still works.'
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
              Expires <When iso={block.expiresAt} mode="time" />. Nothing happens until you decide.
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
