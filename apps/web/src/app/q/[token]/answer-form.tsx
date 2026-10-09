'use client'

import { useState } from 'react'

/** Accept a quote with a name, or decline it with an optional reason (0023). */
export function AnswerForm({ token, seller }: { token: string; seller: string }) {
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'accepted' | 'declined' | null>(null)
  const [error, setError] = useState('')

  const post = async (what: 'accept' | 'decline', body: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/q/${encodeURIComponent(token)}/${what}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const answer = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.ok) setDone(what === 'accept' ? 'accepted' : 'declined')
      else setError(answer.error ?? 'That could not be recorded. Please try again.')
    } catch {
      setError('That could not be sent. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done === 'accepted') {
    return <section className="buyer-accept"><p style={{ margin: 0 }}>Thank you — accepted. {seller} will be in touch about the next steps.</p></section>
  }
  if (done === 'declined') {
    return <section className="buyer-accept"><p style={{ margin: 0 }}>Thank you for letting us know.</p></section>
  }
  return (
    <section className="buyer-accept print-hide">
      <h2 style={{ marginTop: 0 }}>Accept this quote</h2>
      <label>
        Your name
        <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ width: 'auto' }} />
        I accept this quote and its terms.
      </label>
      {error ? <div className="err-line">{error}</div> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy || !agree || name.trim() === ''} onClick={() => void post('accept', { name })}>
          {busy ? 'Sending…' : 'Accept'}
        </button>
        <button type="button" className="linkish" disabled={busy} onClick={() => window.print()}>Save as PDF</button>
        <button type="button" className="linkish" disabled={busy} onClick={() => setDeclining((d) => !d)}>Decline</button>
      </div>
      {declining ? (
        <div style={{ marginTop: 10 }}>
          <label>
            Anything we should know? <span className="muted">(optional)</span>
            <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="button" className="secondary" disabled={busy} onClick={() => void post('decline', { reason })}>Decline the quote</button>
        </div>
      ) : null}
    </section>
  )
}
