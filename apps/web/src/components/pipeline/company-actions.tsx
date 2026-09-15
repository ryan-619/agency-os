'use client'

import { useEffect, useState } from 'react'
import { detectTimeZone, knownTimeZones, wallClockToInstant } from '@/lib/wall-clock'

/**
 * What a person can DO with a company from its page (PROMPT.md §8.6):
 * put it on the board, book a meeting, generate a proposal.
 *
 * Booking records the meeting and moves the deal; it does not send an
 * invitation, and the form says so. Generating a proposal derives the scope
 * from the latest scan and refuses when that scan is stale or empty — the
 * refusal is shown with the fix (re-scan), not swallowed.
 */
export function CompanyActions({
  companyId,
  companyDomain,
  contacts,
  dealStage,
  canWrite,
  canGenerate,
}: {
  companyId: string
  companyDomain: string
  contacts: readonly { readonly id: string; readonly name: string }[]
  dealStage: string | null
  canWrite: boolean
  /** False when there is no fresh, successful scan — the button says why. */
  canGenerate: { ok: true } | { ok: false; why: string }
}) {
  const [mode, setMode] = useState<'idle' | 'meeting' | 'proposal'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // Booking form state.
  const [contactId, setContactId] = useState<string>(contacts[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [local, setLocal] = useState('')
  // Browser-only values, set after mount — see the booking form for why.
  const [zone, setZone] = useState('UTC')
  const [zones, setZones] = useState<string[]>(['UTC'])
  useEffect(() => {
    setZones(knownTimeZones())
    setZone(detectTimeZone())
  }, [])
  const [minutes, setMinutes] = useState(30)
  const [notes, setNotes] = useState('')
  // Proposal form state.
  const [dayRate, setDayRate] = useState('')
  const [currency, setCurrency] = useState('USD')

  if (!canWrite) return null

  const post = async (url: string, body: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setError(typeof out.error === 'string' ? out.error : 'That did not work.')
        return null
      }
      return out
    } catch {
      setError('The request did not complete. Try again.')
      return null
    } finally {
      setBusy(false)
    }
  }

  const putOnBoard = async (): Promise<void> => {
    const out = await post('/api/deals', { companyId, stage: 'new' })
    if (out) window.location.reload()
  }

  const book = async (): Promise<void> => {
    const startsAt = wallClockToInstant(local, zone)
    if (!startsAt) {
      setError('Pick a date and time, and a timezone the list knows.')
      return
    }
    const out = await post('/api/meetings', {
      companyId,
      contactId: contactId || null,
      title: title.trim() || null,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + minutes * 60_000).toISOString(),
      timeZone: zone,
      notes: notes.trim() || null,
    })
    if (out) {
      setDone(typeof out.note === 'string' ? out.note : 'Recorded.')
      setMode('idle')
      setTimeout(() => window.location.reload(), 600)
    }
  }

  const generate = async (): Promise<void> => {
    const rate = dayRate.trim() ? Number(dayRate) : null
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) {
      setError('The day rate is a positive number, or leave it blank for a proposal without prices.')
      return
    }
    const out = await post('/api/proposals', { companyId, dayRate: rate, currency })
    if (out && typeof out.id === 'string') window.location.assign(`/proposals/${out.id}`)
  }

  return (
    <section className="card" style={{ marginTop: 18 }}>
      <h2 style={{ marginTop: 0 }}>Pipeline</h2>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        {dealStage ? <>On the board at <strong>{dealStage}</strong>.</> : 'Not on the board yet — nothing has happened to this company.'}
      </p>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      {done ? <div className="ok-line">{done}</div> : null}

      {mode === 'idle' ? (
        <div className="row-actions" style={{ marginTop: 10 }}>
          {!dealStage ? (
            <button type="button" disabled={busy} onClick={() => void putOnBoard()}>Put on the board</button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => { setError(null); setMode('meeting') }}>Book a meeting</button>
          <button
            type="button"
            disabled={busy || !canGenerate.ok}
            title={canGenerate.ok ? undefined : canGenerate.why}
            onClick={() => { setError(null); setMode('proposal') }}
          >
            Generate proposal
          </button>
          {!canGenerate.ok ? <span className="hint" style={{ alignSelf: 'center' }}>{canGenerate.why}</span> : null}
        </div>
      ) : null}

      {mode === 'meeting' ? (
        <form
          className="row-card slim"
          style={{ marginTop: 10 }}
          onSubmit={(e) => { e.preventDefault(); void book() }}
        >
          <div className="two-up">
            <label>
              With
              <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">— nobody in particular —</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Intro call with ${companyDomain}`} />
            </label>
            <label>
              When (their wall-clock time)
              <input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} required />
            </label>
            <label>
              Timezone
              <select value={zone} onChange={(e) => setZone(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
              <span className="hint">The time above is read in this zone, not yours.</span>
            </label>
            <label>
              Length
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[15, 30, 45, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </select>
            </label>
            <label>
              Notes
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="what they want to talk about" />
            </label>
          </div>
          <p className="hint">Recording the meeting moves the deal to <code>meeting</code>. No invitation is sent from here — send one from your calendar.</p>
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy}>Record meeting</button>
            <button type="button" className="deny" disabled={busy} onClick={() => setMode('idle')}>Cancel</button>
          </div>
        </form>
      ) : null}

      {mode === 'proposal' ? (
        <form
          className="row-card slim"
          style={{ marginTop: 10 }}
          onSubmit={(e) => { e.preventDefault(); void generate() }}
        >
          <div className="two-up">
            <label>
              Day rate (optional)
              <input inputMode="decimal" value={dayRate} onChange={(e) => setDayRate(e.target.value)} placeholder="e.g. 1200" />
              <span className="hint">Blank leaves the pricing as an effort band with no total.</span>
            </label>
            <label>
              Currency
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <p className="hint">
            The scope is written from the latest scan of {companyDomain}: one item per gap observed, with its evidence.
            Signals the scanner could not observe are listed as not assessed, never as fine.
          </p>
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy}>Generate from findings</button>
            <button type="button" className="deny" disabled={busy} onClick={() => setMode('idle')}>Cancel</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
