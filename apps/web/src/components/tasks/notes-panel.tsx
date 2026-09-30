'use client'

import { useState } from 'react'
import { When } from '@/components/when'

/**
 * Notes on a company, as the company page shows them: pinned first, each
 * one headed "note by <name>, <when>" so it always reads as somebody's
 * words and never as something the agency observed (§2.2).
 *
 * Deleting is offered to the note's author and to owners, which is the rule
 * the route enforces; hiding the button is a courtesy, not the control.
 */

export interface NoteItem {
  readonly id: string
  readonly body: string
  readonly pinned: boolean
  readonly authorUserId: string
  readonly authorLabel: string
  readonly contactName: string | null
  readonly createdAt: string
}

/** 0018's bound, counted in characters as the database counts them. */
const MAX_CHARS = 8000
const charCount = (s: string): number => [...s].length

export function NotesPanel({
  companyId,
  notes,
  contacts,
  currentUserId,
  isOwner,
  canWrite,
}: {
  companyId: string
  notes: readonly NoteItem[]
  contacts: readonly { readonly id: string; readonly name: string }[]
  currentUserId: string
  isOwner: boolean
  canWrite: boolean
}) {
  const [body, setBody] = useState('')
  const [contactId, setContactId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const call = async (url: string, init: RequestInit): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json' } })
      const out = (await res.json().catch(() => ({}))) as { error?: unknown }
      if (!res.ok) {
        setError(typeof out.error === 'string' ? out.error : 'That did not work.')
        return false
      }
      return true
    } catch {
      setError('The request did not complete. Try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    if (!body.trim()) {
      setError('A note needs some words in it.')
      return
    }
    const ok = await call('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ companyId, contactId: contactId || null, body }),
    })
    if (ok) window.location.reload()
  }

  const pin = async (id: string, pinned: boolean): Promise<void> => {
    if (await call(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) })) window.location.reload()
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this note? It cannot be brought back.')) return
    if (await call(`/api/notes/${id}`, { method: 'DELETE' })) window.location.reload()
  }

  const used = charCount(body)

  return (
    <div>
      {error ? <div className="err-line" role="alert">{error}</div> : null}

      {notes.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>No notes yet.</p>
      ) : (
        <div className="rows" style={{ marginTop: 8 }}>
          {notes.map((n) => (
            <div key={n.id} className="row-card slim">
              <div className="row-head" style={{ marginBottom: 2 }}>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  note by <strong>{n.authorLabel}</strong>, <When iso={n.createdAt} />
                  {n.contactName ? <> · about {n.contactName}</> : null}
                  {n.pinned ? <span className="pill" style={{ marginLeft: 6 }}>pinned</span> : null}
                </span>
                {canWrite ? (
                  <span className="row-actions">
                    <button type="button" className="linkish" disabled={busy} onClick={() => void pin(n.id, !n.pinned)}>
                      {n.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    {n.authorUserId === currentUserId || isOwner ? (
                      <button type="button" className="linkish" disabled={busy} onClick={() => void remove(n.id)}>
                        Delete
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, wordBreak: 'break-word' }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}

      {canWrite ? (
        <form className="row-card slim" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void add() }}>
          <label>
            Add a note
            <textarea value={body} rows={3} onChange={(e) => setBody(e.target.value)} placeholder="What was said, by whom, and what happens next." />
            <span className="hint" style={used > MAX_CHARS ? { color: 'var(--warn)' } : undefined}>
              {used.toLocaleString('en-US')} / {MAX_CHARS.toLocaleString('en-US')} characters. Saved with your name on it.
            </span>
          </label>
          {contacts.length > 0 ? (
            <label>
              About (optional)
              <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">— the company in general —</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          ) : null}
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy || used > MAX_CHARS}>Add note</button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
