'use client'

import { useState } from 'react'

/** Raise a draft quote for a company and open it to edit (0023). */
export function NewQuoteButton({ companyId, label = 'New quote' }: { companyId: string; label?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId }),
      })
      const answer = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
      if (res.ok && answer.id) {
        window.location.href = `/quotes/${answer.id}`
        return
      }
      setError(answer.error ?? 'The quote could not be raised.')
    } catch {
      setError('The request did not complete. Nothing changed; try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <span>
      <button type="button" disabled={busy} onClick={() => void create()} style={{ width: 'auto' }}>
        {busy ? 'Raising…' : label}
      </button>
      {error ? <span className="err-line" style={{ marginLeft: 8 }}>{error}</span> : null}
    </span>
  )
}
