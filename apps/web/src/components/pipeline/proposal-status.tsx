'use client'

import { useState } from 'react'
import { toast } from '../toast/toast'

/**
 * What can happen to a proposal next. The transitions are the route's;
 * this only offers the ones it will accept, and says what each means.
 */
const NEXT: Readonly<Record<string, readonly { to: string; label: string; note: string; danger?: boolean }[]>> = {
  draft: [
    { to: 'sent', label: 'Mark as sent', note: 'You sent it yourself. Nothing is sent from here.' },
    { to: 'withdrawn', label: 'Withdraw', note: 'It will not be sent.', danger: true },
  ],
  sent: [
    { to: 'accepted', label: 'Accepted', note: 'Closes the deal as won.' },
    { to: 'declined', label: 'Declined', note: 'They said no.', danger: true },
    { to: 'withdrawn', label: 'Withdraw', note: 'Taken back after sending.', danger: true },
  ],
}

export function ProposalStatus({ id, status, canWrite }: { id: string; status: string; canWrite: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options = NEXT[status] ?? []
  if (!canWrite || options.length === 0) return null

  const set = async (to: string): Promise<void> => {
    if (to === 'accepted' && !window.confirm('Record this proposal as accepted? The deal closes as won.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/proposals/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: to }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setError(b.error ?? 'That did not work.')
        return
      }
      // What was recorded, and no more: marking it sent sends nothing.
      toast.afterReload(to === 'sent' ? 'Marked as sent.' : to === 'withdrawn' ? 'Withdrawn.' : `Recorded as ${to}.`)
      window.location.reload()
    } catch {
      setError('The request did not complete.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      <div className="row-actions">
        {options.map((o) => (
          <button key={o.to} type="button" className={o.danger ? 'deny' : undefined} disabled={busy} title={o.note} onClick={() => void set(o.to)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
