import { describeApproval } from '@/lib/approval-card'

/**
 * A tool's payload as a person reads it (2026-10-09): a title, the message's
 * words as a message, every other key as a fact — and the whole JSON a
 * click away, because the reading is not the record.
 *
 * One component for both places a card is decided, so they cannot read a
 * payload differently: the chat's inline card, and "Tools waiting on you" on
 * /approvals, which showed the raw tool name and JSON alone until 2026-10-15
 * — a delete decided there named nothing a person could check. The payload
 * is shown in FULL, never truncated: someone deciding has to see exactly
 * what they are approving.
 */
export function ApprovalReadingView({ toolName, payload }: { toolName: string; payload: unknown }) {
  const r = describeApproval(toolName, payload)
  return (
    <div className="approval-reading">
      <div className="approval-title">{r.title}</div>
      {r.message ? (
        <div className="approval-message">
          {r.message.subject ? <div className="approval-subject">{r.message.subject}</div> : null}
          <pre>{r.message.body}</pre>
        </div>
      ) : null}
      {r.facts.length > 0 ? (
        <dl className="approval-facts">
          {r.facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value.includes('\n') ? <pre>{f.value}</pre> : f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details className="approval-raw">
        <summary>The exact payload, as the tool would receive it</summary>
        <pre className="mono approval-payload">{JSON.stringify(payload, null, 2)}</pre>
      </details>
    </div>
  )
}
