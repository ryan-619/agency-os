'use client'

import { useState } from 'react'
import { When } from '@/components/when'

/**
 * The suppression list, and who is paused (PROMPT.md §2.1, §8.4).
 *
 * "One row there and no channel may ever contact that address, number, or
 * domain again." So this screen is the one place a person sees the whole
 * list, adds to it, and — owner only, audited — takes something off it.
 *
 * The add form's error is the important text on the page. A value that cannot
 * be normalised is refused, and the message says what the consequence of
 * storing it as typed would have been: an opt-out that never matches.
 */

export interface SuppressionView {
  readonly id: string
  readonly kind: string
  readonly value: string
  readonly reason: string
  readonly createdAt: string
}

export interface PausedView {
  readonly id: string
  readonly email: string | null
  readonly pausedAt: string | null
  readonly pausedReason: string | null
}

export function SuppressionsPanel({
  suppressions,
  paused,
  canWrite,
  canRemove,
}: {
  suppressions: readonly SuppressionView[]
  paused: readonly PausedView[]
  canWrite: boolean
  canRemove: boolean
}) {
  const [kind, setKind] = useState<'email' | 'domain' | 'phone'>('email')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    setBusy('add')
    setError('')
    setNotice('')
    try {
      const res = await fetch('/api/suppressions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, value, reason }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; alreadyPresent?: boolean; value?: string }
      if (!res.ok) {
        setError(body.error ?? 'That did not work.')
        return
      }
      if (body.alreadyPresent) {
        setNotice(`${body.value} was already on the list. Nothing changed.`)
        setValue('')
        return
      }
      window.location.reload()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (s: SuppressionView): Promise<void> => {
    if (
      !window.confirm(
        `Remove ${s.value} from the suppression list?\n\nThis means they can be contacted again. ` +
          `It was added because: ${s.reason}`,
      )
    ) {
      return
    }
    setBusy(s.id)
    try {
      const res = await fetch(`/api/suppressions/${s.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'That did not work.')
        return
      }
      window.location.reload()
    } finally {
      setBusy(null)
    }
  }

  const resume = async (p: PausedView): Promise<void> => {
    setBusy(p.id)
    try {
      const res = await fetch(`/api/contacts/${p.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      })
      if (res.ok) window.location.reload()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {canWrite ? (
        <div className="row-card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 6px' }}>Add to the list</h3>
          <div className="two-up">
            <label>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="email">Email address</option>
                <option value="domain">Whole domain</option>
                <option value="phone">Phone number</option>
              </select>
            </label>
            <label>
              Value
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={kind === 'email' ? 'someone@example.com' : kind === 'domain' ? 'example.com' : '+1 415 555 0100'}
                autoComplete="off"
              />
            </label>
          </div>
          <label>
            Why
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Replied asking us to stop, 12 Sep" />
            <span className="hint">
              Required. A suppression nobody can explain gets removed by whoever finds it, and removing one means
              contacting somebody who asked not to be.
            </span>
          </label>
          {error ? <div className="err-line">{error}</div> : null}
          {notice ? <div className="ok-line">{notice}</div> : null}
          <div className="row-actions" style={{ marginTop: 10 }}>
            <button type="button" disabled={busy === 'add' || !value || !reason} onClick={() => void add()}>
              {busy === 'add' ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      ) : null}

      <h2 style={{ fontSize: 15, margin: '18px 0 8px' }}>Suppressed</h2>
      {suppressions.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>Nobody is suppressed.</p>
      ) : (
        <div className="rows">
          {suppressions.map((s) => (
            <div key={s.id} className="row-card slim">
              <div className="row-head">
                <div>
                  <code>{s.value}</code>
                  <span className="tag">{s.kind}</span>
                </div>
                {canRemove ? (
                  <button type="button" className="deny" disabled={busy === s.id} onClick={() => void remove(s)}>
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {s.reason} · <When iso={s.createdAt} mode="date" />
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 15, margin: '22px 0 8px' }}>Paused</h2>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        A contact who replied. Nothing further goes to them in any campaign until a person resumes them.
      </p>
      {paused.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>Nobody is paused.</p>
      ) : (
        <div className="rows">
          {paused.map((p) => (
            <div key={p.id} className="row-card slim">
              <div className="row-head">
                <div>
                  <code>{p.email ?? p.id}</code>
                </div>
                {canWrite ? (
                  <button type="button" disabled={busy === p.id} onClick={() => void resume(p)}>
                    Resume
                  </button>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {p.pausedReason} · {p.pausedAt ? <When iso={p.pausedAt} /> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
