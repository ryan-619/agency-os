'use client'

import { useState } from 'react'
import { toast } from '../toast/toast'
import { ToastOn } from '../toast/toast-on'

async function post(url: string, method: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, data }
}

/** Make an audit-page or preview link (copied), or draft the email that carries one. */
export function ShareButtons({ companyId, canWrite, preview }: { companyId: string; canWrite: boolean; preview: boolean }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [url, setUrl] = useState<string | null>(null)
  if (!canWrite) return <p className="hint">Only someone who can edit companies can make these links.</p>

  const make = async (kind: 'report' | 'preview') => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const r = await post(`/api/companies/${companyId}/share`, 'POST', { kind })
      if (!r.ok || typeof r.data['url'] !== 'string') {
        setError(String(r.data['error'] ?? 'The link could not be made.'))
        return
      }
      setUrl(r.data['url'] as string)
      // A browser may refuse the copy after the request (Safari does): say "copied" only when it was.
      const copied = await navigator.clipboard?.writeText(r.data['url'] as string).then(() => true, () => false)
      setNote(
        copied
          ? 'Link made and copied. Paste it into your message — WhatsApp, email, anywhere.'
          : 'Link made. Copy it from below and paste it into your message — WhatsApp, email, anywhere.',
      )
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const email = async (kind: 'report' | 'preview') => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const r = await post(`/api/companies/${companyId}/share/email`, 'POST', { kind })
      if (!r.ok) {
        setError(String(r.data['error'] ?? 'The email could not be drafted.'))
        return
      }
      setNote('Email drafted with a fresh link. Read it, pick the recipient and approve it on Approvals — nothing is sent until you do.')
      window.setTimeout(() => window.location.reload(), 1500)
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy} onClick={() => void make('report')}>Copy audit page link</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void email('report')}>Draft email with it</button>
        {preview ? (
          <>
            <button type="button" disabled={busy} onClick={() => void make('preview')}>Copy website preview link</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void email('preview')}>Draft email with it</button>
          </>
        ) : null}
      </div>
      {error ? <div className="err-line" style={{ marginTop: 6 }}>{error}</div> : null}
      <ToastOn message={note} />
      {url ? <div className="note" style={{ marginTop: 6, wordBreak: 'break-all' }}><a href={url} target="_blank" rel="noreferrer">{url}</a></div> : null}
    </div>
  )
}

/** Revoke one link. */
ShareButtons.Revoke = function Revoke({ companyId, linkId }: { companyId: string; linkId: string }) {
  const [done, setDone] = useState(false)
  if (done) return <span className="hint">revoked</span>
  return (
    <button
      type="button"
      className="linkish"
      onClick={() => {
        void post(`/api/companies/${companyId}/share`, 'DELETE', { linkId }).then((r) => {
          if (!r.ok) return
          toast.success('Link revoked.')
          setDone(true)
        })
      }}
    >
      Revoke
    </button>
  )
}
