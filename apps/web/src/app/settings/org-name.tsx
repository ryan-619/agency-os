'use client'

import { useState } from 'react'
import { toast } from '../../components/toast/toast'

/**
 * The organisation's name, editable in place by an owner. Saved through
 * PATCH /api/settings/org, and the page reloads from what was stored, so the
 * sidebar and every page after it read the new name.
 */
export function OrgName({ name, canWrite }: { name: string; canWrite: boolean }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!editing) {
    return (
      <>
        {name}{' '}
        {canWrite ? (
          <button type="button" className="linkish" onClick={() => setEditing(true)}>
            Rename
          </button>
        ) : null}
      </>
    )
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/settings/org', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: value }),
      })
      if (res.ok) {
        toast.afterReload(`Renamed to ${value.trim()}.`)
        window.location.reload()
        return
      }
      const answer = (await res.json().catch(() => ({}))) as { error?: string }
      setError(answer.error ?? 'That did not save.')
    } catch {
      setError('The request did not complete. Nothing changed; try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 6, maxWidth: 420 }}>
      <input value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} aria-label="Organisation name" />
      <span className="hint">
        Shown in the sidebar, on proposals (“Prepared by …”) and the booking page, and used to sign outreach
        openers and by the assistant.
      </span>
      {error ? <span className="err-line">{error}</span> : null}
      <div className="row-actions">
        <button type="button" disabled={busy || value.trim() === ''} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save name'}
        </button>
        <button
          type="button"
          className="linkish"
          disabled={busy}
          onClick={() => {
            setValue(name)
            setEditing(false)
            setError('')
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
