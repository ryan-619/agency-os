'use client'

import { useState } from 'react'
import {
  BUYER_ACCEPT_HEADING, BUYER_AUTHORITY, BUYER_REFUSAL, buyerAccepted,
} from '@/components/pipeline/proposal-share-copy'

/**
 * Accept, on the buyer's page. A typed name and one button.
 *
 * The name is the whole record of who accepted — the buyer has no account
 * and no session — so it is asked for in so many words, beside the sentence
 * that says what typing it means. The route answers `{ ok: true }` and
 * nothing else; whatever it refuses, it says in a sentence that names no id.
 */
export function AcceptForm({ token, orgName, basis }: { token: string; orgName: string; basis: string }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setError(BUYER_REFUSAL.blank_name)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/p/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setError(b.error ?? BUYER_REFUSAL.unavailable)
        return
      }
      setDone(true)
    } catch {
      setError('That did not go through. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <section className="buyer-accept" aria-live="polite">
        <h2 style={{ marginTop: 0 }}>Thank you</h2>
        <p style={{ color: 'var(--ink)' }}>{buyerAccepted(orgName)}</p>
      </section>
    )
  }

  return (
    <section className="buyer-accept">
      <h2 style={{ marginTop: 0 }}>{BUYER_ACCEPT_HEADING}</h2>
      <p>{basis}</p>
      {error ? <p className="err" role="alert">{error}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="accept-name">Your full name</label>
        <input
          id="accept-name"
          type="text"
          autoComplete="name"
          maxLength={120}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            width: '100%', maxWidth: 380, padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 6,
            background: 'var(--bg)', color: 'var(--ink)', fontSize: 14, fontFamily: 'inherit',
          }}
        />
        <p className="fine" style={{ margin: '10px 0 0' }}>{BUYER_AUTHORITY}</p>
        <button type="submit" disabled={busy}>{busy ? 'Recording…' : BUYER_ACCEPT_HEADING}</button>
      </form>
    </section>
  )
}
