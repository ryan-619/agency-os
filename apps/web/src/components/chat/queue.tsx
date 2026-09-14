'use client'

import { useState } from 'react'
import { When } from '@/components/when'

/**
 * The approval queue's interactive half.
 *
 * Small on purpose. The page does the reading; this does the deciding, and the
 * only state it keeps is what has already been answered in this tab — so a row
 * someone else answered a second ago stops offering buttons that cannot work.
 */
export interface QueueItem {
  readonly id: string
  readonly toolName: string
  readonly risk: string
  readonly payload: unknown
  readonly expiresAt: string
  readonly createdAt: string
}

type Outcome = 'approved' | 'denied' | 'expired' | 'taken'

export function ApprovalQueue({
  items, canDecide,
}: {
  items: readonly QueueItem[]
  canDecide: boolean
}) {
  const [settled, setSettled] = useState<Record<string, Outcome>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setBusy(id)
    try {
      const res = await fetch(`/api/approvals/${id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (res.ok) {
        setSettled((s) => ({ ...s, [id]: decision }))
      } else if (res.status === 409) {
        // Someone else decided first. Two people looking at one queue is the
        // normal case here, so this is an outcome rather than an error.
        setSettled((s) => ({ ...s, [id]: 'taken' }))
      } else if (res.status === 410) {
        setSettled((s) => ({ ...s, [id]: 'expired' }))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="queue">
      {items.map((item) => {
        const outcome = settled[item.id]
        return (
          <div key={item.id} className={`approval ${outcome ? `approval-${outcome}` : ''}`}>
            <div className="approval-head">
              <strong>{item.toolName}</strong>
              <span className="pill pill-risk">{item.risk} risk</span>
              <span className="muted" style={{ fontSize: 12 }}>
                asked <When iso={item.createdAt} mode="time" /> · expires{' '}
                <When iso={item.expiresAt} mode="time" />
              </span>
            </div>

            <pre className="mono approval-payload">{JSON.stringify(item.payload, null, 2)}</pre>

            {outcome ? (
              <p className="muted">{describe(outcome)}</p>
            ) : canDecide ? (
              <div className="approval-actions">
                <button type="button" disabled={busy === item.id} onClick={() => void decide(item.id, 'approved')}>
                  Approve
                </button>
                <button
                  type="button"
                  className="deny"
                  disabled={busy === item.id}
                  onClick={() => void decide(item.id, 'denied')}
                >
                  Deny
                </button>
                <span className="muted">The conversation that asked is waiting on this.</span>
              </div>
            ) : (
              <p className="muted">Waiting for someone who can approve this.</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function describe(outcome: Outcome): string {
  switch (outcome) {
    case 'approved':
      return 'Approved. The agent has been told and has carried on.'
    case 'denied':
      return 'Denied. Nothing was done, and the agent has been told not to retry.'
    case 'expired':
      return 'This expired before anyone decided. Nothing was done.'
    case 'taken':
      return 'Someone else decided this first.'
  }
}
