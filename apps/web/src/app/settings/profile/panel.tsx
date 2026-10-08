'use client'

import { useState } from 'react'

type Fields = Record<
  'legalName' | 'address' | 'phone' | 'email' | 'website' | 'gstin' | 'gstRate' | 'upiVpa' | 'upiPayee'
  | 'advancePercent' | 'quoteValidityDays' | 'quoteTerms' | 'brochureUrl',
  string
>

/** The business profile form (0023). Saved whole through PUT /api/settings/profile. */
export function ProfilePanel({ initial, canWrite }: { initial: Fields; canWrite: boolean }) {
  const [f, setF] = useState<Fields>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const set = (k: keyof Fields) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value })
    setSaved(false)
  }
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...f,
          gstRate: f.gstin.trim() === '' ? 0 : Number(f.gstRate || '0'),
          advancePercent: Number(f.advancePercent || '0'),
          quoteValidityDays: Number(f.quoteValidityDays || '15'),
        }),
      })
      const answer = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.ok) setSaved(true)
      else setError(answer.error ?? 'That did not save.')
    } catch {
      setError('The request did not complete. Nothing changed; try again.')
    } finally {
      setBusy(false)
    }
  }
  const field = (k: keyof Fields, label: string, opts: { placeholder?: string; hint?: string; max?: number } = {}) => (
    <label>
      {label}
      {opts.hint ? <span className="muted"> ({opts.hint})</span> : null}
      <input value={f[k]} maxLength={opts.max ?? 300} disabled={!canWrite} placeholder={opts.placeholder} onChange={set(k)} />
    </label>
  )
  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 760 }}>
      <section className="card" style={{ display: 'grid', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Who you are</h2>
        {field('legalName', 'Legal name', { placeholder: 'Accemy Digital LLP', max: 200 })}
        <label>
          Address
          <textarea rows={2} maxLength={500} value={f.address} disabled={!canWrite} onChange={set('address')} placeholder="Street, city, PIN" />
        </label>
        <div className="two-up">
          {field('phone', 'Phone', { placeholder: '+91 98765 43210', max: 40 })}
          {field('email', 'Email', { placeholder: 'hello@myagencyos.in', max: 200 })}
        </div>
        {field('website', 'Website', { placeholder: 'https://myagencyos.in' })}
      </section>

      <section className="card" style={{ display: 'grid', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Tax and payment</h2>
        <div className="two-up">
          {field('gstin', 'GSTIN', { placeholder: '29ABCDE1234F1Z5', hint: 'leave empty if not registered', max: 15 })}
          {field('gstRate', 'GST %', { placeholder: '18', hint: 'only with a GSTIN', max: 5 })}
        </div>
        <div className="two-up">
          {field('upiVpa', 'UPI ID', { placeholder: 'accemy@okhdfcbank', hint: 'the advance is paid here', max: 300 })}
          {field('upiPayee', 'Name on the UPI account', { placeholder: 'Accemy Digital LLP', max: 100 })}
        </div>
        <div className="two-up">
          {field('advancePercent', 'Advance %', { placeholder: '50', max: 3 })}
          {field('quoteValidityDays', 'Quotes valid for (days)', { placeholder: '15', max: 3 })}
        </div>
      </section>

      <section className="card" style={{ display: 'grid', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Standard terms and brochure</h2>
        <label>
          Terms every new quote starts with
          <textarea rows={4} maxLength={4000} value={f.quoteTerms} disabled={!canWrite} onChange={set('quoteTerms')}
            placeholder="50% advance to start, the rest on delivery. Delivery in 10 working days from the advance. Prices exclude third-party fees (domain, hosting, ads)." />
        </label>
        {field('brochureUrl', 'Brochure or company profile link', { placeholder: 'https://drive.google.com/…', hint: 'a PDF anyone with the link can open' , max: 500 })}
      </section>

      {error ? <div className="err-line">{error}</div> : null}
      {saved ? <div className="ok-line">Saved. New quotes and drafts use it from now on.</div> : null}
      {canWrite ? (
        <div className="row-actions"><button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save profile'}</button></div>
      ) : (
        <p className="hint">Only an owner can change the business profile.</p>
      )}
    </div>
  )
}
