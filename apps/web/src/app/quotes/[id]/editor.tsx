'use client'

import { useMemo, useState } from 'react'
import { QUOTE_UNITS, quoteItemFromService, quoteTotals, type QuoteItem, type QuoteUnit, type QuotableService } from '@agency/core'
import { money, unitWords } from '@/lib/quote-view'

/**
 * Editing a quote (0023): the title, the opening words, every line, the
 * contact, the advance, the validity and the terms — with the totals worked
 * out as you type, exactly as the server will (core's `quoteTotals`).
 * Saving a SENT quote turns it back into a draft and its links stop opening;
 * the page says so before anything is saved.
 */
export interface EditorQuote {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly title: string
  readonly intro: string
  readonly items: readonly QuoteItem[]
  readonly contactId: string | null
  readonly advancePercent: number
  readonly validUntil: string
  readonly terms: string
  readonly updatedAt: string
  readonly lapsed: boolean
  readonly acceptedByName: string | null
}

interface LinkView {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly revoked: boolean
  readonly views: number
  readonly lastViewedAt: string | null
}

const blankLine = (): QuoteItem => ({ serviceId: null, name: '', description: null, quantity: 1, unit: 'one_off', unitPrice: 0 })

export function QuoteEditor({
  initial, needs, gstRate, contacts, catalogue, links, upiReady, canWrite,
}: {
  initial: EditorQuote
  needs: readonly { label: string; evidence: readonly string[] }[]
  gstRate: number
  contacts: readonly { id: string; name: string; hasEmail: boolean }[]
  catalogue: readonly QuotableService[]
  links: readonly LinkView[]
  upiReady: boolean
  canWrite: boolean
}) {
  const [title, setTitle] = useState(initial.title)
  const [intro, setIntro] = useState(initial.intro)
  const [items, setItems] = useState<QuoteItem[]>([...initial.items])
  const [contactId, setContactId] = useState<string | null>(initial.contactId)
  const [advance, setAdvance] = useState(initial.advancePercent)
  const [validUntil, setValidUntil] = useState(initial.validUntil)
  const [terms, setTerms] = useState(initial.terms)
  const [updatedAt, setUpdatedAt] = useState(initial.updatedAt)
  const [status, setStatus] = useState(initial.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const editable = canWrite && (status === 'draft' || status === 'sent')
  const totals = useMemo(() => quoteTotals(items, gstRate, advance), [items, gstRate, advance])
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setDirty(true)
  }
  const setLine = (i: number, patch: Partial<QuoteItem>) => {
    setItems((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)))
    setDirty(true)
  }

  const call = async (url: string, method: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setError(typeof answer['error'] === 'string' ? (answer['error'] as string) : 'That did not work.')
        return null
      }
      return answer
    } catch {
      setError('The request did not complete. Nothing changed; try again.')
      return null
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<boolean> => {
    if (status === 'sent' && !window.confirm('This quote was sent. Saving changes makes it a draft again, and the link the buyer has stops opening — send it again afterwards. Save?')) {
      return false
    }
    const answer = await call(`/api/quotes/${initial.id}`, 'PATCH', {
      title, intro: intro.trim() || null, items, contactId, advancePercent: advance, validUntil, terms: terms.trim() || null,
      expectedUpdatedAt: updatedAt,
    })
    if (!answer) return false
    setUpdatedAt(String(answer['updatedAt']))
    if (answer['revised']) setStatus('draft')
    setDirty(false)
    setNotice(answer['revised'] ? 'Saved. It is a draft again — mark it sent when it is ready.' : 'Saved.')
    return true
  }

  const send = async () => {
    if (dirty && !(await save())) return
    const answer = await call(`/api/quotes/${initial.id}/send`, 'POST')
    if (answer) {
      setStatus('sent')
      setNotice('Marked sent. Copy its link, or draft the email that carries it.')
    }
  }

  const share = async () => {
    const answer = await call(`/api/quotes/${initial.id}/share`, 'POST')
    if (answer && typeof answer['url'] === 'string') {
      setLink(answer['url'] as string)
      await navigator.clipboard?.writeText(answer['url'] as string).catch(() => {})
      setNotice('Link made and copied. It opens until the quote’s last valid day.')
    }
  }

  const email = async () => {
    const answer = await call(`/api/quotes/${initial.id}/email`, 'POST')
    if (answer) setNotice('Email drafted with a fresh link. Read and approve it on Approvals — nothing is sent until you do.')
  }

  const decide = async (to: 'accepted' | 'declined' | 'withdrawn') => {
    let name: string | null = null
    let reason: string | null = null
    if (to === 'accepted') name = window.prompt('Who accepted it? (their name)') ?? null
    if (to === 'declined') reason = window.prompt('Why did they decline? (optional)') ?? null
    if (to === 'withdrawn' && !window.confirm('Withdraw this quote? Its links stop opening.')) return
    const answer = await call(`/api/quotes/${initial.id}/decide`, 'POST', { to, name, reason })
    if (answer) {
      setStatus(to)
      setNotice(to === 'accepted' ? 'Recorded as accepted — the deal is won, and a task to collect the advance is on Tasks.' : `Recorded as ${to}.`)
    }
  }

  const revoke = async (linkId: string) => {
    const answer = await call(`/api/quotes/${initial.id}/share`, 'DELETE', { linkId })
    if (answer) setNotice('Link revoked. It no longer opens.')
  }

  const addFromCatalogue = (serviceId: string) => {
    const service = catalogue.find((s) => s.id === serviceId)
    if (!service) return
    setItems((all) => [...all, quoteItemFromService(service)])
    setDirty(true)
  }

  return (
    <div className="quote-editor">
      <div className="row-head" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>
          {initial.number} <span className={`pill quote-status-${status}`}>{status}</span>
          {initial.lapsed && status === 'sent' ? <span className="tag" style={{ marginLeft: 6 }}>validity passed</span> : null}
        </h1>
        <div className="row-actions" style={{ gap: 6 }}>
          <a className="button-like" href={`/quotes/${initial.id}/print`} target="_blank" rel="noreferrer">Print / PDF</a>
          {editable ? <button type="button" disabled={busy || !dirty} onClick={() => void save()}>Save</button> : null}
          {canWrite && status === 'draft' ? <button type="button" disabled={busy} onClick={() => void send()}>Mark as sent</button> : null}
          {canWrite && status === 'sent' ? (
            <>
              <button type="button" disabled={busy} onClick={() => void share()}>Copy link</button>
              <button type="button" disabled={busy} onClick={() => void email()}>Draft email</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void decide('accepted')}>Accepted</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void decide('declined')}>Declined</button>
              <button type="button" className="linkish" disabled={busy} onClick={() => void decide('withdrawn')}>Withdraw</button>
            </>
          ) : null}
        </div>
      </div>
      {error ? <div className="err-line" style={{ margin: '8px 0' }}>{error}</div> : null}
      {notice ? <div className="ok-line" style={{ margin: '8px 0' }}>{notice}</div> : null}
      {link ? (
        <div className="note" style={{ margin: '8px 0', wordBreak: 'break-all' }}>
          Link for the buyer: <a href={link} target="_blank" rel="noreferrer">{link}</a>
        </div>
      ) : null}
      {status === 'accepted' && initial.acceptedByName ? <p className="hint">Accepted by {initial.acceptedByName}.</p> : null}
      {status === 'sent' ? (
        <p className="hint">This quote was sent. Changing it makes it a draft again, and the link the buyer has stops opening.</p>
      ) : null}

      <div className="card" style={{ marginTop: 12, display: 'grid', gap: 10 }}>
        <label>
          Title
          <input value={title} maxLength={200} disabled={!editable} onChange={(e) => touch(setTitle)(e.target.value)} />
        </label>
        <label>
          Opening words <span className="muted">(optional — shown above the lines)</span>
          <textarea rows={3} maxLength={4000} value={intro} disabled={!editable} onChange={(e) => touch(setIntro)(e.target.value)}
            placeholder="Thank you for your time today. As discussed, here is what we propose for your website and Google listing." />
        </label>
        <div className="two-up">
          <label>
            For
            <select value={contactId ?? ''} disabled={!editable} onChange={(e) => touch(setContactId)(e.target.value || null)}>
              <option value="">(no contact)</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.hasEmail ? '' : ' — no email'}</option>
              ))}
            </select>
          </label>
          <label>
            Valid until
            <input type="date" value={validUntil} disabled={!editable} onChange={(e) => touch(setValidUntil)(e.target.value)} />
          </label>
        </div>
      </div>

      {needs.length > 0 ? (
        <details className="card" style={{ marginTop: 12 }}>
          <summary>What the quote says it answers ({needs.length}) — from the evidence on record when it was raised</summary>
          <ul>
            {needs.map((n) => (
              <li key={n.label}><strong>{n.label}</strong> <span className="hint">{n.evidence.join(' · ')}</span></li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="card" style={{ marginTop: 12 }}>
        <table className="quote-edit-lines">
          <thead>
            <tr>
              <th>Service</th>
              <th style={{ width: 70 }}>Qty</th>
              <th style={{ width: 110 }}>Charged</th>
              <th style={{ width: 120 }}>Rate (₹)</th>
              <th className="num" style={{ width: 110 }}>Amount</th>
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td>
                  <input value={item.name} maxLength={120} disabled={!editable} placeholder="What you will do"
                    onChange={(e) => setLine(i, { name: e.target.value })} />
                  <textarea rows={2} maxLength={600} value={item.description ?? ''} disabled={!editable} placeholder="Details (optional)"
                    onChange={(e) => setLine(i, { description: e.target.value || null })} style={{ marginTop: 4 }} />
                </td>
                <td>
                  <input inputMode="numeric" value={item.quantity} disabled={!editable}
                    onChange={(e) => setLine(i, { quantity: Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, '')) || 0)) })} />
                </td>
                <td>
                  <select value={item.unit} disabled={!editable} onChange={(e) => setLine(i, { unit: e.target.value as QuoteUnit })}>
                    {QUOTE_UNITS.map((u) => <option key={u} value={u}>{unitWords(u)}</option>)}
                  </select>
                </td>
                <td>
                  <input inputMode="numeric" value={item.unitPrice} disabled={!editable}
                    onChange={(e) => setLine(i, { unitPrice: Math.max(0, Math.floor(Number(e.target.value.replace(/[^\d]/g, '')) || 0)) })} />
                </td>
                <td className="num">{money(item.quantity * item.unitPrice, 'INR')}</td>
                <td>
                  {editable ? (
                    <button type="button" className="linkish" aria-label="Remove line" onClick={() => { setItems((all) => all.filter((_, j) => j !== i)); setDirty(true) }}>✕</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {editable ? (
          <div className="row-actions" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="secondary" onClick={() => { setItems((all) => [...all, blankLine()]); setDirty(true) }}>Add a line</button>
            {catalogue.length > 0 ? (
              <select value="" onChange={(e) => { if (e.target.value) addFromCatalogue(e.target.value) }} style={{ width: 'auto' }}>
                <option value="">Add from your services…</option>
                {catalogue.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : <span className="hint">Add your services and prices in <a href="/settings/services">Settings → Services</a> to pick them here.</span>}
          </div>
        ) : null}

        <div className="quote-edit-totals">
          <div><span>Subtotal</span><span>{money(totals.subtotal, 'INR')}</span></div>
          {gstRate > 0 ? <div><span>GST {gstRate}%</span><span>{money(totals.taxAmount, 'INR')}</span></div> : (
            <div className="hint"><span>No GST</span><span><a href="/settings/profile">add a GSTIN</a> to charge it</span></div>
          )}
          <div className="quote-total"><span>Total</span><span>{money(totals.total, 'INR')}</span></div>
          <div>
            <span>
              Advance{' '}
              <input inputMode="numeric" value={advance} disabled={!editable} style={{ width: 52, display: 'inline-block' }}
                onChange={(e) => touch(setAdvance)(Math.min(100, Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, '')) || 0))))} />%
            </span>
            <span>{money(totals.advanceAmount, 'INR')}</span>
          </div>
          {totals.advanceAmount > 0 && !upiReady ? (
            <div className="hint">Add your UPI ID in <a href="/settings/profile">Settings → Business profile</a> and the quote carries a code to pay it.</div>
          ) : null}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <label>
          Terms
          <textarea rows={4} maxLength={4000} value={terms} disabled={!editable} onChange={(e) => touch(setTerms)(e.target.value)}
            placeholder="50% advance to start, the rest on delivery. Delivery in 10 working days from the advance. Hosting billed yearly." />
        </label>
      </div>

      {links.length > 0 ? (
        <div className="card" style={{ marginTop: 12 }}>
          <h2 style={{ marginTop: 0 }}>Links</h2>
          <table>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td>Made {l.createdAt.slice(0, 10)}</td>
                  <td>{l.revoked ? 'revoked' : `opens until ${l.expiresAt.slice(0, 10)}`}</td>
                  <td>{l.views === 0 ? 'not opened yet' : `opened ${l.views} ${l.views === 1 ? 'time' : 'times'}, last ${l.lastViewedAt?.slice(0, 16).replace('T', ' ')} UTC`}</td>
                  <td>{!l.revoked && canWrite ? <button type="button" className="linkish" disabled={busy} onClick={() => void revoke(l.id)}>Revoke</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
