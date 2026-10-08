'use client'

import { useState } from 'react'
import { CHECK_THANKS } from '@/lib/check-copy'

/** The free website check's form (2026-10-08). On success the visitor goes straight to their own page. */
export function CheckForm({ slug, consentWording }: { readonly slug: string; readonly consentWording: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/check/${slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          website: f.get('website'),
          business: f.get('business'),
          name: f.get('name'),
          email: f.get('email'),
          consent: f.get('consent') === 'on',
          website_confirm: f.get('website_confirm'),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string | null; error?: string }
      if (!res.ok) {
        setError(data.error ?? 'That did not work. Please try again.')
        return
      }
      if (data.url) window.location.href = data.url
      else setDone(true)
    } finally {
      setBusy(false)
    }
  }

  if (done) return <p className="note">{CHECK_THANKS}</p>
  return (
    <form onSubmit={(e) => void submit(e)} className="check-form">
      <label>
        Your website
        <input name="website" type="text" inputMode="url" placeholder="yourbusiness.com" required maxLength={300} autoComplete="url" />
      </label>
      <label>
        Business name <span className="muted">(optional)</span>
        <input name="business" type="text" maxLength={120} autoComplete="organization" />
      </label>
      <label>
        Your name
        <input name="name" type="text" required maxLength={120} autoComplete="name" />
      </label>
      <label>
        Your email
        <input name="email" type="email" required maxLength={254} autoComplete="email" />
      </label>
      {/* Hidden from people; a form-filling robot fills it, and its request is quietly ignored. */}
      <label className="check-trap" aria-hidden="true">
        Leave this empty
        <input name="website_confirm" type="text" tabIndex={-1} autoComplete="off" />
      </label>
      <label className="check-consent">
        <input name="consent" type="checkbox" required /> <span>{consentWording}</span>
      </label>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Checking your site — this takes up to half a minute…' : 'Check my website'}
      </button>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  )
}
